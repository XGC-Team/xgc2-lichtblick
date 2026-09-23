/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";

import {
  ImageRenderable,
  IMAGE_RENDERABLE_DEFAULT_SETTINGS,
  ImageUserData,
} from "./ImageRenderable";
import { AnyImage } from "./ImageTypes";

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

function renderable(): ImageRenderable {
  const userData: ImageUserData = {
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
  };
  return new ImageRenderable("/camera", renderer, userData);
}

type DecodeSpy = jest.SpyInstance<Promise<ImageBitmap | ImageData>, [AnyImage, number?]>;

function spyDecode(target: ImageRenderable): DecodeSpy {
  return jest
    .spyOn(
      target as unknown as { decodeImage: (image: AnyImage) => Promise<ImageBitmap | ImageData> },
      "decodeImage",
    )
    .mockImplementation(async () =>
      Object.assign(new ImageBitmap(), { width: 1920, height: 1080, close: jest.fn() }),
    );
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const video = (sec: number, data: Uint8Array): AnyImage => ({
  format: "h264",
  timestamp: { sec, nsec: 0 },
  frame_id: "camera",
  data,
});

const jpeg = (sec: number): AnyImage => ({
  format: "jpeg",
  data: new Uint8Array([0xff, 0xd8, sec]),
  header: { frame_id: "camera", stamp: { sec, nsec: 0 } },
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ImageRenderable while its canvas is hidden", () => {
  it("decodes no independent image until visible, then only the newest", async () => {
    const target = renderable();
    const decode = spyDecode(target);
    jest.spyOn(target, "update").mockImplementation(() => undefined);
    target.setCanvasVisibility("hidden");

    for (let sec = 1; sec <= 30; sec++) {
      target.setImage(jpeg(sec));
    }
    await settle();
    expect(decode).not.toHaveBeenCalled();

    target.setCanvasVisibility("visible");
    await settle();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode.mock.calls[0]![0]).toEqual(jpeg(30));
    target.dispose();
  });

  it("keeps only the newest GOP of video and decodes it once visible", async () => {
    const target = renderable();
    const decode = spyDecode(target);
    jest.spyOn(target, "update").mockImplementation(() => undefined);
    target.setCanvasVisibility("hidden");

    // Three GOPs arrive while parked; flushes from frames are ignored.
    let sec = 1;
    for (let gop = 0; gop < 3; gop++) {
      target.setImage(video(sec++, KEYFRAME));
      for (let delta = 0; delta < 4; delta++) {
        target.setImage(video(sec++, DELTA));
      }
      target.flushPendingDecodes();
    }
    await settle();
    expect(decode).not.toHaveBeenCalled();
    expect(target.getVideoBufferStats().pendingFrames).toBe(5);

    target.setCanvasVisibility("visible");
    target.flushPendingDecodes();
    await target.settleVideoDecodes();
    // The last keyframe (t=11) and its four deltas: one GOP, in order.
    expect(
      decode.mock.calls.map(([image]) => (image as { timestamp: { sec: number } }).timestamp.sec),
    ).toEqual([11, 12, 13, 14, 15]);
    target.dispose();
  });

  it("stops a running drain when hidden and resumes it when visible", async () => {
    const target = renderable();
    jest.spyOn(target, "update").mockImplementation(() => undefined);
    let release!: () => void;
    const decode = jest
      .spyOn(
        target as unknown as { decodeImage: (image: AnyImage) => Promise<ImageBitmap | ImageData> },
        "decodeImage",
      )
      .mockImplementationOnce(
        async () =>
          await new Promise((resolve) => {
            release = () => {
              resolve(Object.assign(new ImageBitmap(), { width: 1920, height: 1080 }));
            };
          }),
      )
      .mockImplementation(async () =>
        Object.assign(new ImageBitmap(), { width: 1920, height: 1080 }),
      );

    target.setImage(video(1, KEYFRAME));
    target.setImage(video(2, DELTA));
    target.setImage(video(3, DELTA));
    target.flushPendingDecodes();
    await settle();
    expect(decode).toHaveBeenCalledTimes(1);

    target.setCanvasVisibility("hidden");
    release();
    await target.settleVideoDecodes();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(target.getVideoBufferStats().pendingFrames).toBe(2);

    target.setCanvasVisibility("visible");
    target.flushPendingDecodes();
    await target.settleVideoDecodes();
    expect(decode).toHaveBeenCalledTimes(3);
    target.dispose();
  });
});

describe("ImageRenderable texture uploads", () => {
  it("does not re-upload the image when only the scene around it changes", async () => {
    const target = renderable();
    spyDecode(target);
    target.setImage(jpeg(1));
    await settle();
    const texture = target.userData.texture!;
    expect(texture.version).toBe(1);

    // Marker/TF-driven frames update the renderable's header and pose, not its pixels.
    for (let frame = 0; frame < 10; frame++) {
      target.update();
    }
    expect(target.userData.texture).toBe(texture);
    expect(texture.version).toBe(1);
    target.dispose();
  });
});
