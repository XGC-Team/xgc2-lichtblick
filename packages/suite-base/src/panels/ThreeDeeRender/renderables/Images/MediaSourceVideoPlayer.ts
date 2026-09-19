// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Mutex } from "async-mutex";
import EventEmitter from "eventemitter3";

import {
  DecodeFramesResult,
  EncodedVideoFrame,
  VideoPlayerEventTypes,
} from "@lichtblick/den/video";

import { initSegment, mediaSegment, MEDIA_SOURCE_FRAME_DURATION_US } from "./H264MediaSource";

// Bounds cover a broken source with no further IDR, independently of the renderer queue.
const MAX_GOP_BYTES = 32 * 1024 * 1024;
const MAX_GOP_FRAMES = 300;
const DECODE_DEADLINE_MS = 5000;

type MediaSourceConstructor = typeof MediaSource;
function mediaSourceConstructor(): MediaSourceConstructor | undefined {
  const managed = (
    globalThis as typeof globalThis & {
      ManagedMediaSource?: MediaSourceConstructor;
    }
  ).ManagedMediaSource;
  return managed ?? (typeof MediaSource === "function" ? MediaSource : undefined);
}
function equalBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a?.length === b.length && b.every((value, index) => a[index] === value);
}

/** Native AVC decoder for HTTP origins where WebCodecs is unavailable.
 * The input contract is ordered Annex-B I/P access units with complete SPS/PPS at IDR.
 * A paused video seeks to the exact appended sample; a matching native video-frame
 * callback is the pixel barrier. Container time is private; output retains source time.
 * The renderer still owns backfill, presentation, overload recovery and AR geometry.
 */
export class MediaSourceVideoPlayer extends EventEmitter<VideoPlayerEventTypes> {
  readonly #mutex = new Mutex();
  #config?: VideoDecoderConfig;
  #video?: HTMLVideoElement;
  #source?: MediaSource;
  #buffer?: SourceBuffer;
  #url?: string;
  #initialization?: Uint8Array;
  #controller = new AbortController();
  #epoch = 0;
  #sequence = 0;
  #gopBytes = 0;
  #gopFrames = 0;
  #lastTimestamp?: number;
  public lastVideoFrame?: VideoFrame;
  public lastImageBitmap?: ImageBitmap;

  public static IsSupported(): boolean {
    return (
      typeof document !== "undefined" &&
      typeof VideoFrame === "function" &&
      typeof HTMLVideoElement.prototype.requestVideoFrameCallback === "function" &&
      mediaSourceConstructor() != undefined
    );
  }

  public async init(config: VideoDecoderConfig): Promise<void> {
    const Source = mediaSourceConstructor();
    if (
      !config.codec.startsWith("avc1.") ||
      Source?.isTypeSupported(`video/mp4; codecs="${config.codec}"`) !== true
    ) {
      throw new Error(`Native MediaSource cannot decode ${config.codec}`);
    }
    this.#config = config;
  }

  public isInitialized(): boolean {
    return this.#config != undefined;
  }
  public decoderConfig(): VideoDecoderConfig | undefined {
    return this.#config;
  }
  public codedSize(): { width: number; height: number } | undefined {
    return this.#config?.codedWidth != undefined && this.#config.codedHeight != undefined
      ? { width: this.#config.codedWidth, height: this.#config.codedHeight }
      : undefined;
  }

  public async decode(
    data: Uint8Array,
    timestampMicros: number,
    type: "key" | "delta",
  ): Promise<VideoFrame | undefined> {
    const result = await this.decodeFrames([{ data, timestampMicros, type }]);
    return "frame" in result ? result.frame : undefined;
  }

  public async decodeFrames(frames: EncodedVideoFrame[]): Promise<DecodeFramesResult> {
    const epoch = this.#epoch;
    return await this.#mutex.runExclusive(async (): Promise<DecodeFramesResult> => {
      if (epoch !== this.#epoch || this.#config == undefined || frames.length === 0) {
        return { type: "aborted" };
      }
      let frame: VideoFrame | undefined;
      try {
        for (const input of frames) {
          if (epoch !== this.#epoch) {
            frame?.close();
            return { type: "aborted" };
          }
          frame?.close();
          frame = undefined;
          frame = await this.#decodeOne(input);
        }
        if (epoch !== this.#epoch) {
          frame?.close();
          return { type: "aborted" };
        }
        return frame ? { type: "target", frame } : { type: "timeout" };
      } catch (cause) {
        frame?.close();
        if (epoch !== this.#epoch) {
          return { type: "aborted" };
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.resetForSeek();
        this.emit("error", error);
        throw error;
      }
    });
  }

  async #decodeOne(input: EncodedVideoFrame): Promise<VideoFrame> {
    const signal = this.#controller.signal;
    if (
      !Number.isSafeInteger(input.timestampMicros) ||
      (this.#lastTimestamp != undefined && input.timestampMicros <= this.#lastTimestamp)
    ) {
      throw new Error("MSE video timestamps must increase until an explicit reset");
    }
    if (input.type === "key") {
      const initialization = initSegment(input.data);
      if (!equalBytes(this.#initialization, initialization.bytes)) {
        this.#releaseMedia();
        this.#config = initialization.config;
        await this.#open(initialization.bytes);
        signal.throwIfAborted();
      }
      this.#gopBytes = 0;
      this.#gopFrames = 0;
    }
    const buffer = this.#buffer,
      video = this.#video;
    if (!buffer || !video) {
      throw new Error("MSE H264 is waiting for a complete IDR with SPS/PPS");
    }
    if (
      this.#gopBytes + input.data.byteLength > MAX_GOP_BYTES ||
      this.#gopFrames >= MAX_GOP_FRAMES
    ) {
      throw new Error("MSE H264 GOP exceeded its byte/frame budget; a new IDR is required");
    }
    const sampleTime = this.#sequence * MEDIA_SOURCE_FRAME_DURATION_US;
    const bytes = mediaSegment(input.data, sampleTime, this.#sequence + 1);
    await this.#wait(buffer, ["updateend"], () => {
      buffer.appendBuffer(bytes);
    });
    signal.throwIfAborted();
    await this.#seekFrame(video, sampleTime);
    signal.throwIfAborted();
    const frame = new VideoFrame(video, { timestamp: input.timestampMicros });
    try {
      // Once this IDR is decoded, earlier GOPs cannot be dependencies or seek evidence.
      if (input.type === "key" && sampleTime > 0) {
        await this.#wait(buffer, ["updateend"], () => {
          buffer.remove(0, sampleTime / 1e6);
        });
      }
      signal.throwIfAborted();
      this.lastVideoFrame?.close();
      this.lastVideoFrame = frame.clone();
      this.#sequence++;
      this.#gopBytes += input.data.byteLength;
      this.#gopFrames++;
      this.#lastTimestamp = input.timestampMicros;
      return frame;
    } catch (error) {
      frame.close();
      throw error;
    }
  }

  async #open(initialization: Uint8Array<ArrayBuffer>): Promise<void> {
    const signal = this.#controller.signal;
    const Source = mediaSourceConstructor();
    if (!Source || !this.#config) {
      throw new Error("Native MediaSource is unavailable");
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    // Required by ManagedMediaSource when no alternative remote-playback source exists.
    video.disableRemotePlayback = true;
    const source = new Source();
    this.#video = video;
    this.#source = source;
    this.#url = URL.createObjectURL(source);
    await this.#wait(source, ["sourceopen"], () => {
      video.src = this.#url!;
    });
    signal.throwIfAborted();
    const buffer = source.addSourceBuffer(`video/mp4; codecs="${this.#config.codec}"`);
    this.#buffer = buffer;
    await this.#wait(buffer, ["updateend"], () => {
      buffer.appendBuffer(initialization);
    });
    signal.throwIfAborted();
    this.#initialization = initialization;
  }

  async #seekFrame(video: HTMLVideoElement, sampleTime: number): Promise<void> {
    const signal = this.#controller.signal;
    await new Promise<void>((resolve, reject) => {
      let callback = 0;
      const cleanup = () => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback(callback);
        video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const failed = () => {
        cleanup();
        reject(new Error(video.error?.message ?? "Native MediaSource decode failed"));
      };
      const aborted = () => {
        cleanup();
        reject(new Error("Native MediaSource decode reset"));
      };
      const presented: VideoFrameRequestCallback = (_now, metadata) => {
        // seeked/readyState alone can precede the new decoded picture. The video
        // remains paused, so a matching submitted frame cannot advance underneath us.
        const timeMicros = Math.round(metadata.mediaTime * 1e6);
        if (timeMicros >= sampleTime && timeMicros < sampleTime + MEDIA_SOURCE_FRAME_DURATION_US) {
          cleanup();
          resolve();
        } else {
          callback = video.requestVideoFrameCallback(presented);
        }
      };
      // A deadline only rejects; it never substitutes for decoded-frame evidence.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Native MediaSource decoded-frame deadline exceeded"));
      }, DECODE_DEADLINE_MS);
      video.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      if (video.error != undefined) {
        failed();
        return;
      }
      try {
        callback = video.requestVideoFrameCallback(presented);
        video.currentTime = (sampleTime + 1000) / 1e6;
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async #wait(
    target: EventTarget,
    events: string[],
    action: () => void,
    ready: () => boolean = () => true,
  ): Promise<void> {
    const signal = this.#controller.signal;
    const video = this.#video;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        for (const event of events) {
          target.removeEventListener(event, done);
        }
        target.removeEventListener("error", failed);
        video?.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const done = () => {
        if (ready()) {
          cleanup();
          resolve();
        }
      };
      const failed = () => {
        cleanup();
        reject(new Error(video?.error?.message ?? "Native MediaSource decode failed"));
      };
      const aborted = () => {
        cleanup();
        reject(new Error("Native MediaSource decode reset"));
      };
      // Failure watchdog only: elapsed time never claims a decoded frame.
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Native MediaSource decode deadline exceeded"));
      }, DECODE_DEADLINE_MS);
      for (const event of events) {
        target.addEventListener(event, done);
      }
      target.addEventListener("error", failed);
      video?.addEventListener("error", failed);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      if (video?.error != undefined) {
        failed();
        return;
      }
      try {
        action();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #releaseMedia(): void {
    if (this.#source?.readyState === "open" && this.#buffer) {
      try {
        if (this.#buffer.updating) {
          this.#buffer.abort();
        }
        this.#source.removeSourceBuffer(this.#buffer);
      } catch {
        /* Element teardown below also detaches it. */
      }
    }
    this.#video?.pause();
    this.#video?.removeAttribute("src");
    this.#video?.load();
    if (this.#url) {
      URL.revokeObjectURL(this.#url);
    }
    this.#video = undefined;
    this.#source = undefined;
    this.#buffer = undefined;
    this.#url = undefined;
    this.#initialization = undefined;
    this.#sequence = 0;
    this.#gopBytes = 0;
    this.#gopFrames = 0;
  }

  public resetForSeek(): void {
    this.#epoch++;
    this.#controller.abort();
    this.#controller = new AbortController();
    this.#releaseMedia();
    this.#config = undefined;
    this.#lastTimestamp = undefined;
  }

  public close(): void {
    this.resetForSeek();
    this.lastVideoFrame?.close();
    this.lastVideoFrame = undefined;
    this.lastImageBitmap?.close();
    this.lastImageBitmap = undefined;
  }
}
