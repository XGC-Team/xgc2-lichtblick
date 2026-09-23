/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { H264 } from "@lichtblick/den/video";
import { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import { inspectAnnexBVideoFrame } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/liveMessageQueue";

import { ImageRenderable, IMAGE_RENDERABLE_DEFAULT_SETTINGS } from "./ImageRenderable";
import { imageModeDecodeWidth } from "../ImageMode/utils";

/**
 * Per-frame budget of the AR image path on the main thread, for the stream sizes a producer may
 * send (H.264 foxglove CompressedVideo, 30 fps). The expectations are the budget: a change that
 * adds a payload scan, a bitmap conversion or a texture upload per frame fails here.
 *
 * Browser-native work is counted in bytes, not timed: decoding (the decoder's own output frame),
 * createImageBitmap (reads that frame, writes RGBA) and the texture upload (RGBA in GPU memory).
 */
type FrameBudget = {
  /** Encoded bytes per frame at the stream's bitrate (what each WebSocket hop carries). */
  payloadBytes: number;
  /** Full payload scans for NAL headers: the player's recovery check and the renderable's. */
  payloadScans: number;
  /** Decoder output per frame (4:2:0), before any conversion. */
  decodedBytes: number;
  bitmapConversions: number;
  /** RGBA bytes written by createImageBitmap. */
  bitmapBytes: number;
  textureUploads: number;
  /** RGBA bytes a texture upload writes; the ImageMode width cap keeps it at 1920 wide. */
  uploadBytes: number;
};

const FRAMES = 30;
const FPS = 30;

class BudgetVideoFrame {
  public readonly close = jest.fn();
  public readonly clone = jest.fn(
    () => new BudgetVideoFrame(this.displayWidth, this.displayHeight),
  );
  public constructor(
    public readonly displayWidth: number,
    public readonly displayHeight: number,
  ) {}
}

function payload(bytes: number, kind: "key" | "delta"): Uint8Array {
  const data = new Uint8Array(bytes);
  let seed = 7;
  for (let i = 0; i < bytes; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    // Slice payload after emulation prevention: never two zero bytes in a row.
    const byte = (seed >> 16) & 0xff;
    data[i] = byte === 0 ? 0x80 : byte;
  }
  const header =
    kind === "key"
      ? Buffer.from(
          "000000016742c033da00f0010fa10000030001000003003c8f1832a00000000168ce0fc800000001658884",
          "hex",
        )
      : Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a]);
  data.set(header, 0);
  return data;
}

async function measure(width: number, height: number, bitrate: number): Promise<FrameBudget> {
  const payloadBytes = Math.round(bitrate / 8 / FPS);
  const frames = Array.from({ length: FRAMES }, (_, index) =>
    payload(payloadBytes, index === 0 ? "key" : "delta"),
  );
  const bitmapBytes: number[] = [];
  jest.spyOn(self, "createImageBitmap").mockImplementation(async (_source, ...rest) => {
    const resizeWidth = (rest[0] as ImageBitmapOptions | undefined)?.resizeWidth ?? width;
    const resizeHeight = Math.round((height * resizeWidth) / width);
    bitmapBytes.push(resizeWidth * resizeHeight * 4);
    return Object.assign(new ImageBitmap(), { width: resizeWidth, height: resizeHeight });
  });
  const renderer = {
    queueAnimationFrame: jest.fn(),
    normalizeFrameId: (id: string) => id,
    settings: {
      errors: {
        add: jest.fn(),
        addToTopic: jest.fn(),
        remove: jest.fn(),
        removeFromTopic: jest.fn(),
      },
    },
  } as unknown as IRenderer;
  const renderable = new ImageRenderable("/camera", renderer, {
    topic: "/camera",
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
  });
  renderable.videoPlayer = {
    isInitialized: () => true,
    init: jest.fn().mockResolvedValue(undefined),
    decode: jest.fn(async () => new BudgetVideoFrame(width, height)),
    codedSize: () => undefined,
    decoderConfig: () => undefined,
    resetForSeek: jest.fn(),
    close: jest.fn(),
    lastImageBitmap: undefined,
    lastVideoFrame: undefined,
  } as unknown as ImageRenderable["videoPlayer"];
  const keyframeScans = jest.spyOn(H264, "IsKeyframe");
  let playerScans = 0;

  // ImageMode's decode width for this CameraInfo width: min(width, 1920).
  const resizeWidth = imageModeDecodeWidth(width);
  for (const [index, data] of frames.entries()) {
    // The WebSocket player inspects every video message once on the main thread.
    inspectAnnexBVideoFrame(data);
    playerScans++;
    renderable.setImage(
      { format: "h264", timestamp: { sec: 1, nsec: index * 33_333_333 }, frame_id: "camera", data },
      resizeWidth,
    );
    renderable.flushPendingDecodes();
    await renderable.settleVideoDecodes();
  }
  const texture = renderable.userData.texture!;
  const uploaded = texture.image as { displayWidth?: number; width?: number };
  const uploadWidth = uploaded.displayWidth ?? uploaded.width ?? 0;
  const uploadHeight = Math.round((height * uploadWidth) / width);
  const budget: FrameBudget = {
    payloadBytes,
    payloadScans: (playerScans + keyframeScans.mock.calls.length) / FRAMES,
    decodedBytes: width * height * 1.5,
    bitmapConversions: bitmapBytes.length / FRAMES,
    bitmapBytes: bitmapBytes.reduce((sum, bytes) => sum + bytes, 0) / FRAMES,
    textureUploads: texture.version / FRAMES,
    uploadBytes: (texture.version * uploadWidth * uploadHeight * 4) / FRAMES,
  };
  renderable.dispose();
  jest.restoreAllMocks();
  return budget;
}

describe("AR image path budget per frame", () => {
  let originalVideoFrame: unknown;
  beforeEach(() => {
    jest.clearAllMocks();
    originalVideoFrame = (globalThis as { VideoFrame?: unknown }).VideoFrame;
    (globalThis as { VideoFrame?: unknown }).VideoFrame = BudgetVideoFrame;
  });
  afterEach(() => {
    (globalThis as { VideoFrame?: unknown }).VideoFrame = originalVideoFrame;
  });

  it("4K H.264 at 25 Mbit/s: decoded at 4K, resized into a 1920 bitmap, then uploaded", async () => {
    expect(await measure(3840, 2160, 25_000_000)).toEqual({
      payloadBytes: 104_167,
      payloadScans: 2,
      decodedBytes: 12_441_600,
      bitmapConversions: 1,
      bitmapBytes: 8_294_400,
      textureUploads: 1,
      uploadBytes: 8_294_400,
    });
  });

  it("1080p H.264 at 6 Mbit/s: the decoded frame is uploaded without a bitmap", async () => {
    expect(await measure(1920, 1080, 6_000_000)).toEqual({
      payloadBytes: 25_000,
      payloadScans: 2,
      decodedBytes: 3_110_400,
      bitmapConversions: 0,
      bitmapBytes: 0,
      textureUploads: 1,
      uploadBytes: 8_294_400,
    });
  });
});
