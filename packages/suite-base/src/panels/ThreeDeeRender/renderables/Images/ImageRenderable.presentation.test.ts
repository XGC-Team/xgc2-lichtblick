/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";

import {
  ImageRenderable,
  IMAGE_RENDERABLE_DEFAULT_SETTINGS,
  ImageUserData,
} from "./ImageRenderable";
import { AnyImage, CompressedVideo } from "./ImageTypes";
import { decodeCompressedImageToBitmap, decodeCompressedVideoToBitmap } from "./decodeImage";

jest.mock("@lichtblick/den/video", () => ({
  ...jest.requireActual("@lichtblick/den/video"),
  VideoPlayer: class {
    #ready = false;
    public static IsSupported() {
      return true;
    }
    public on() {}
    public isInitialized() {
      return this.#ready;
    }
    public async init() {
      this.#ready = true;
    }
    public resetForSeek() {
      this.#ready = false;
    }
    public close() {}
  },
}));

jest.mock("./decodeImage", () => ({
  ...jest.requireActual("./decodeImage"),
  prepareVideoFrame: () => ({
    type: "key",
    decoderConfig: { codec: "avc1.42E01E" },
    status: "ok",
    data: new Uint8Array([1]),
  }),
  decodeCompressedVideoToBitmap: jest.fn(),
  decodeCompressedImageToBitmap: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick() {
  for (let index = 0; index < 16; index++) {
    await Promise.resolve();
  }
}

const sample = (sec: number, format = "h264"): CompressedVideo => ({
  format,
  frame_id: "camera",
  timestamp: { sec, nsec: 0 },
  data: new Uint8Array([0, 0, 0, 1, 0x65, 1]),
});

function bitmap(width = 10, height = 10) {
  const image = new ImageBitmap();
  Object.defineProperties(image, {
    width: { configurable: true, value: width },
    height: { configurable: true, value: height },
  });
  return image;
}

describe("image presentation under resize and decode pressure", () => {
  let renderable: ImageRenderable;
  let now: number;
  let paints: number[];
  let requests: ReturnType<typeof deferred<ImageBitmap>>[];

  beforeEach(() => {
    now = 0;
    paints = [];
    requests = [];
    jest.spyOn(performance, "now").mockImplementation(() => now);
    jest.mocked(decodeCompressedVideoToBitmap).mockImplementation(async () => {
      const request = deferred<ImageBitmap>();
      requests.push(request);
      return await request.promise;
    });
    jest.mocked(decodeCompressedImageToBitmap).mockImplementation(async () => bitmap());
    const errors = {
      add: jest.fn(),
      addToTopic: jest.fn(),
      remove: jest.fn(),
      removeFromTopic: jest.fn(),
    };
    const renderer = {
      queueAnimationFrame: () => paints.push(now),
      normalizeFrameId: (frame: string) => frame,
      settings: { errors },
    } as unknown as IRenderer;
    const userData: ImageUserData = {
      topic: "camera",
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
    renderable = new ImageRenderable("camera", renderer, userData);
  });

  afterEach(() => {
    renderable.dispose();
    jest.restoreAllMocks();
  });

  async function warmVideo() {
    renderable.setImage(sample(0));
    renderable.flushPendingDecodes();
    await tick();
    requests[0]!.resolve(bitmap());
    await renderable.settleVideoDecodes();
    paints.length = 0;
    requests.length = 0;
  }

  it("reuses same-size textures and uniforms without invalidating the image material", async () => {
    renderable.setImage(sample(0, "jpeg"));
    await tick();
    const material = renderable.userData.material!;
    const texture = renderable.userData.texture;
    const version = material.version;
    const uniforms = Object.values(material.uniforms);
    for (let index = 1; index <= 100; index++) {
      renderable.setImage(sample(index, "jpeg"));
      await tick();
    }
    expect(renderable.userData.texture).toBe(texture);
    expect(material.version).toBe(version);
    Object.values(material.uniforms).forEach((uniform, index) => {
      expect(uniform).toBe(uniforms[index]);
    });
  });

  it("also reuses raw-image DataTexture materials", async () => {
    jest
      .spyOn(
        renderable as unknown as { decodeImage: (image: AnyImage) => Promise<ImageData> },
        "decodeImage",
      )
      .mockImplementation(async () => new ImageData(new Uint8ClampedArray(400), 10, 10));
    renderable.setImage(sample(0, "jpeg"));
    await tick();
    const material = renderable.userData.material!;
    const texture = renderable.userData.texture;
    const version = material.version;
    renderable.setImage(sample(1, "jpeg"));
    await tick();
    expect(renderable.userData.texture).toBe(texture);
    expect(material.version).toBe(version);
  });

  it("changes brightness and contrast in place without recompiling the shader", () => {
    renderable.update();
    const material = renderable.userData.material!;
    const color = material.uniforms.color!.value;
    const brightness = material.uniforms.brightness;
    const version = material.version;
    renderable.setSettings({ ...renderable.userData.settings, brightness: 0.2, contrast: 0.3 });
    renderable.update();
    expect(material.uniforms.color!.value).toBe(color);
    expect(material.uniforms.brightness).toBe(brightness);
    expect(material.version).toBe(version);
  });

  it("still invalidates when the material changes transparency variant", () => {
    renderable.update();
    const material = renderable.userData.material!;
    const version = material.version;
    renderable.setSettings({ ...renderable.userData.settings, color: "#ffffff80" });
    renderable.update();
    expect(material.transparent).toBe(true);
    expect(material.version).toBe(version + 1);
    renderable.setSettings({ ...renderable.userData.settings, brightness: 0.5 });
    renderable.update();
    expect(material.version).toBe(version + 1);
  });

  it("recovers after an image update throws", () => {
    renderable.userData.image = sample(0);
    const header = jest.spyOn(renderable, "updateHeaderInfo").mockImplementationOnce(() => {
      throw new Error("transient update error");
    });
    expect(() => {
      renderable.update();
    }).toThrow("transient update error");
    header.mockRestore();
    renderable.update();
    expect(renderable.userData.material).toBeDefined();
  });

  it("collapses short video bursts to the final presentation", async () => {
    await warmVideo();
    renderable.setImage(sample(1));
    renderable.setImage(sample(2));
    renderable.flushPendingDecodes();
    await tick();
    requests[0]!.resolve(bitmap());
    await tick();
    expect(paints).toHaveLength(0);
    requests[1]!.resolve(bitmap());
    await renderable.settleVideoDecodes();
    expect(paints).toHaveLength(1);
  });

  it("does not let a duplicate timestamp suppress the final real frame", async () => {
    await warmVideo();
    renderable.setImage(sample(1));
    renderable.setImage(sample(1));
    renderable.flushPendingDecodes();
    await tick();
    expect(requests).toHaveLength(1);
    requests[0]!.resolve(bitmap());
    await renderable.settleVideoDecodes();
    expect(paints).toHaveLength(1);
  });

  it("publishes live progress while preserving serial decode under sustained backlog", async () => {
    await warmVideo();
    renderable.setImage(sample(1));
    renderable.setImage(sample(2));
    renderable.flushPendingDecodes();
    await tick();
    for (let index = 0; index < 6; index++) {
      renderable.setImage(sample(index + 3));
      now = (index + 1) * 50;
      requests[index]!.resolve(bitmap());
      await tick();
    }
    expect(paints).toEqual([100, 200, 300]);
    expect(requests).toHaveLength(7);
    renderable.dispose();
    requests[6]!.resolve(bitmap());
    await renderable.settleVideoDecodes();
  });

  it("keeps explicit seek backfill atomic even beyond the live presentation deadline", async () => {
    await warmVideo();
    renderable.resetVideoForSeek();
    renderable.setImage(sample(1));
    renderable.setImage(sample(2));
    renderable.flushPendingDecodes();
    await tick();
    now = 500;
    requests[0]!.resolve(bitmap());
    await tick();
    expect(paints).toHaveLength(0);
    requests[1]!.resolve(bitmap());
    await renderable.settleVideoDecodes();
    expect(paints).toHaveLength(1);
  });

  it("closes late video output after disposal without requesting another paint", async () => {
    await warmVideo();
    renderable.setImage(sample(1));
    renderable.flushPendingDecodes();
    await tick();
    renderable.dispose();
    const image = bitmap();
    const close = jest.spyOn(image, "close");
    requests[0]!.resolve(image);
    await renderable.settleVideoDecodes();
    expect(close).toHaveBeenCalledTimes(1);
    expect(paints).toHaveLength(0);
  });
});
