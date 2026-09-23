/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import type { VideoPlayer } from "@lichtblick/den/video";
import { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import { BasicBuilder } from "@lichtblick/test-builders";

import {
  ImageRenderable,
  IMAGE_RENDERABLE_DEFAULT_SETTINGS,
  ImageUserData,
} from "./ImageRenderable";
import { VideoFrameTexture, isVideoFrame, presentableImageSize } from "./VideoFrameTexture";
import { decodeCompressedVideoToBitmap } from "./decodeImage";
import { PreparedVideoFrameStatus } from "./types";

/** Stand-in for a decoder output frame; jsdom has no WebCodecs. */
class MockVideoFrame {
  public static created: MockVideoFrame[] = [];
  public closeCount = 0;
  public readonly close = jest.fn(() => {
    this.closeCount++;
  });
  public readonly clone = jest.fn(() => new MockVideoFrame(this.displayWidth, this.displayHeight));
  public constructor(
    public readonly displayWidth: number,
    public readonly displayHeight: number,
  ) {
    MockVideoFrame.created.push(this);
  }
}

const KEYFRAME = Uint8Array.from(
  Buffer.from(
    "000000016742c033da00f0010fa10000030001000003003c8f1832a00000000168ce0fc800000001658884",
    "hex",
  ),
);
const DELTA = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x03]);

const renderer = {
  queueAnimationFrame: jest.fn(),
  normalizeFrameId: jest.fn((id: string) => id),
  settings: {
    errors: {
      add: jest.fn(),
      addToTopic: jest.fn(),
      remove: jest.fn(),
      removeFromTopic: jest.fn(),
    },
  },
} as unknown as IRenderer;

function userData(): ImageUserData {
  return {
    topic: BasicBuilder.string(),
    settings: { ...IMAGE_RENDERABLE_DEFAULT_SETTINGS },
    firstMessageTime: 0n,
    cameraInfo: undefined,
    cameraModel: undefined,
    image: undefined,
    texture: undefined,
    material: undefined,
    geometry: undefined,
    mesh: undefined,
    frameId: "camera",
    messageTime: 0n,
    receiveTime: 0n,
    pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    settingsPath: [],
  };
}

let originalVideoFrame: unknown;
let bitmaps: ImageBitmap[];
let bitmapCloses: jest.Mock[];

beforeEach(() => {
  // jsdom's createImageBitmap is already a mock; clear its history between tests.
  jest.clearAllMocks();
  originalVideoFrame = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  (globalThis as { VideoFrame?: unknown }).VideoFrame = MockVideoFrame;
  MockVideoFrame.created = [];
  bitmaps = [];
  bitmapCloses = [];
  jest.spyOn(self, "createImageBitmap").mockImplementation(async (_source, ...rest) => {
    const resizeWidth = (rest[0] as ImageBitmapOptions | undefined)?.resizeWidth;
    const close = jest.fn();
    const bitmap = Object.assign(new ImageBitmap(), {
      width: resizeWidth ?? 1920,
      height: resizeWidth != undefined ? Math.round((resizeWidth * 9) / 16) : 1080,
      close,
    });
    bitmaps.push(bitmap);
    bitmapCloses.push(close);
    return bitmap;
  });
});

afterEach(() => {
  (globalThis as { VideoFrame?: unknown }).VideoFrame = originalVideoFrame;
  jest.restoreAllMocks();
});

describe("VideoFrameTexture", () => {
  it("uploads like the renderable's bitmap textures", () => {
    const frame = new MockVideoFrame(1920, 1080) as unknown as VideoFrame;
    const texture = new VideoFrameTexture(frame);
    expect(isVideoFrame(frame)).toBe(true);
    expect(presentableImageSize(frame)).toEqual({ width: 1920, height: 1080 });
    expect(texture.currentFrame()).toBe(frame);
    // three's texImage2D video path: size comes from the source, rows top first, no mipmaps.
    expect(texture.isVideoTexture).toBe(true);
    expect(texture.flipY).toBe(false);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.version).toBe(1);
    texture.update();
    expect(texture.version).toBe(1);
  });
});

describe("decodeCompressedVideoToBitmap presenting decoder frames", () => {
  const prepared = { data: DELTA, type: "delta" as const, status: PreparedVideoFrameStatus.Ok };
  const message = { timestamp: { sec: 0, nsec: 0 } };

  function player(decoded: MockVideoFrame | undefined, lastVideoFrame?: MockVideoFrame) {
    return {
      isInitialized: () => true,
      decode: jest.fn().mockResolvedValue(decoded),
      lastVideoFrame,
      lastImageBitmap: Object.assign(new ImageBitmap(), { width: 1920, height: 1080 }),
    } as unknown as VideoPlayer;
  }

  it("hands over a frame that fits the width without an ImageBitmap copy", async () => {
    const frame = new MockVideoFrame(1920, 1080);
    const videoPlayer = player(frame);
    const result = await decodeCompressedVideoToBitmap(message, prepared, videoPlayer, 0n, 1920, {
      retainPreviousBitmap: true,
      presentVideoFrame: true,
    });
    expect(result).toBe(frame);
    expect(frame.close).not.toHaveBeenCalled();
    expect(self.createImageBitmap).not.toHaveBeenCalled();
    // An older bitmap must not be re-presented after this frame.
    expect(videoPlayer.lastImageBitmap).toBeUndefined();
  });

  it("still resizes wider frames to the cap and closes the decoded frame", async () => {
    const frame = new MockVideoFrame(3840, 2160);
    const result = await decodeCompressedVideoToBitmap(message, prepared, player(frame), 0n, 1920, {
      retainPreviousBitmap: true,
      presentVideoFrame: true,
    });
    expect(result).toBe(bitmaps[0]);
    expect(self.createImageBitmap).toHaveBeenCalledWith(frame, { resizeWidth: 1920 });
    expect(frame.closeCount).toBe(1);
  });

  it("presents an owned clone of the player's cached frame after a decode gap", async () => {
    const cached = new MockVideoFrame(1280, 720);
    const videoPlayer = player(undefined, cached);
    (videoPlayer as { lastImageBitmap?: ImageBitmap }).lastImageBitmap = undefined;
    const result = await decodeCompressedVideoToBitmap(message, prepared, videoPlayer, 0n, 1920, {
      retainPreviousBitmap: true,
      presentVideoFrame: true,
    });
    expect(cached.clone).toHaveBeenCalledTimes(1);
    expect(result).toBe(cached.clone.mock.results[0]!.value);
    expect(cached.closeCount).toBe(0);
  });
});

describe("ImageRenderable presenting decoder frames", () => {
  function renderableWithDecoder(frames: MockVideoFrame[]) {
    const renderable = new ImageRenderable("camera", renderer, userData());
    const decode = jest.fn(async () => frames.shift());
    renderable.videoPlayer = {
      isInitialized: () => true,
      init: jest.fn().mockResolvedValue(undefined),
      decode,
      codedSize: () => undefined,
      decoderConfig: () => undefined,
      resetForSeek: jest.fn(),
      close: jest.fn(),
      lastImageBitmap: undefined,
      lastVideoFrame: undefined,
    } as unknown as ImageRenderable["videoPlayer"];
    let index = 0;
    const present = async (resizeWidth = 1920) => {
      renderable.setImage(
        {
          format: "h264",
          timestamp: { sec: 1, nsec: index * 33_333_333 },
          frame_id: "camera",
          data: index === 0 ? KEYFRAME : DELTA,
        },
        resizeWidth,
      );
      index++;
      renderable.flushPendingDecodes();
      await renderable.settleVideoDecodes();
    };
    return { renderable, present };
  }

  it("uploads each fitting frame directly and closes it exactly once", async () => {
    const frames = [1, 2, 3].map(() => new MockVideoFrame(1920, 1080));
    const [first, second, third] = frames;
    const { renderable, present } = renderableWithDecoder([...frames]);

    await present();
    const texture = renderable.userData.texture as VideoFrameTexture;
    expect(texture).toBeInstanceOf(VideoFrameTexture);
    expect(texture.currentFrame()).toBe(first);
    expect(texture.version).toBe(1);

    await present();
    await present();
    // Same texture, re-pointed at each new frame; replaced frames are released.
    expect(renderable.userData.texture).toBe(texture);
    expect(texture.currentFrame()).toBe(third);
    expect(texture.version).toBe(3);
    expect(renderable.getDecodedImage()).toBe(third);
    expect([first!.closeCount, second!.closeCount, third!.closeCount]).toEqual([1, 1, 0]);
    expect(self.createImageBitmap).not.toHaveBeenCalled();

    renderable.dispose();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
  });

  it("switches between resized bitmaps and direct frames without leaking either", async () => {
    const frames = [
      new MockVideoFrame(3840, 2160),
      new MockVideoFrame(1920, 1080),
      new MockVideoFrame(3840, 2160),
    ];
    const { renderable, present } = renderableWithDecoder([...frames]);

    await present();
    expect(renderable.userData.texture).toBeInstanceOf(THREE.CanvasTexture);
    await present();
    expect(renderable.userData.texture).toBeInstanceOf(VideoFrameTexture);
    expect(bitmapCloses[0]).toHaveBeenCalledTimes(1);
    await present();
    expect(renderable.userData.texture).toBeInstanceOf(THREE.CanvasTexture);
    expect(renderable.userData.texture?.image).toBe(bitmaps[1]);

    renderable.dispose();
    expect(frames.map((frame) => frame.closeCount)).toEqual([1, 1, 1]);
    expect(bitmapCloses.map((close) => close.mock.calls.length)).toEqual([1, 1]);
  });
});
