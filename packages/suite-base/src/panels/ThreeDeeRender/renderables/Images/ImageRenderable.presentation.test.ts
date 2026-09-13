/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { IRenderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/IRenderer";
import H265FrameBuilder from "@lichtblick/suite-base/testing/builders/H265FrameBuilder";

import {
  ImageRenderable,
  IMAGE_RENDERABLE_DEFAULT_SETTINGS,
  ImageUserData,
} from "./ImageRenderable";
import { AnyImage } from "./ImageTypes";

const sample: AnyImage = {
  format: "jpeg",
  data: new Uint8Array([1]),
  header: { frame_id: "camera", stamp: { sec: 0, nsec: 1 } },
};

function bitmap(width = 640, height = 480): ImageBitmap {
  const image = new ImageBitmap();
  Object.defineProperties(image, {
    width: { configurable: true, value: width },
    height: { configurable: true, value: height },
  });
  // Model browser detachment rather than a no-op close mock: closed dimensions
  // becoming zero is what previously made every video frame replace its texture.
  jest.spyOn(image, "close").mockImplementation(() => {
    Object.defineProperties(image, {
      width: { configurable: true, value: 0 },
      height: { configurable: true, value: 0 },
    });
  });
  return image;
}

function fixture() {
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
  return { renderable: new ImageRenderable("camera", renderer, userData), renderer };
}

function mockDecode(renderable: ImageRenderable) {
  return jest.spyOn(
    renderable as unknown as {
      decodeImage: (image: AnyImage) => Promise<ImageBitmap | ImageData>;
    },
    "decodeImage",
  );
}

async function presentImage(renderable: ImageRenderable, image = sample): Promise<void> {
  await new Promise<void>((resolve) => renderable.setImage(image, undefined, resolve));
}

function videoFixture() {
  const result = fixture();
  const decode = jest.fn().mockImplementation(async () => ({
    codedWidth: 640,
    codedHeight: 480,
    timestamp: 0,
    close: jest.fn(),
  }));
  result.renderable.videoPlayer = {
    isInitialized: jest.fn().mockReturnValue(true),
    init: jest.fn().mockResolvedValue(undefined),
    decode,
    resetForSeek: jest.fn(),
    codedSize: () => ({ width: 640, height: 480 }),
    close: jest.fn(),
    lastImageBitmap: undefined,
    lastVideoFrame: undefined,
  } as unknown as ImageRenderable["videoPlayer"];
  return { ...result, decode };
}

const key = H265FrameBuilder.keyframeWithParameterSets();
const delta = H265FrameBuilder.deltaFrame();
const video = (data: Uint8Array, sec: number) =>
  H265FrameBuilder.frame({ data, frame_id: "camera", timestamp: { sec, nsec: 0 } });

async function flush(renderable: ImageRenderable): Promise<void> {
  renderable.flushPendingDecodes();
  await renderable.settleVideoDecodes();
}

describe("image presentation hot path", () => {
  afterEach(() => jest.restoreAllMocks());

  it("reuses texture and uniform identities across independent frames", async () => {
    const { renderable } = fixture();
    mockDecode(renderable).mockImplementation(async () => bitmap());
    await presentImage(renderable);
    const texture = renderable.userData.texture!;
    const material = renderable.userData.material!;
    const map = material.uniforms.map;
    const color = material.uniforms.color;
    const colorValue = color!.value;
    const version = material.version;
    const textureVersion = texture.version;
    for (let index = 0; index < 100; index++) {
      await presentImage(renderable);
    }
    expect(renderable.userData.texture).toBe(texture);
    expect(renderable.userData.material).toBe(material);
    expect(material.version).toBe(version);
    expect(material.uniforms.map).toBe(map);
    expect(material.uniforms.color).toBe(color);
    expect(color!.value).toBe(colorValue);
    expect(texture.version).toBeGreaterThan(textureVersion);
    renderable.dispose();
  });

  it("updates enhancement uniforms without revalidating the shader program", async () => {
    const { renderable } = fixture();
    mockDecode(renderable).mockResolvedValue(bitmap());
    await presentImage(renderable);
    const material = renderable.userData.material!;
    const brightness = material.uniforms.brightness;
    const contrast = material.uniforms.contrast;
    const version = material.version;
    renderable.setSettings({ ...renderable.userData.settings, brightness: 20, contrast: 30 });
    renderable.update();
    expect(material.uniforms.brightness).toBe(brightness);
    expect(material.uniforms.contrast).toBe(contrast);
    expect(material.version).toBe(version);
    renderable.setSettings({ ...renderable.userData.settings, color: "#ffffff80" });
    renderable.update();
    expect(material.transparent).toBe(true);
    expect(material.version).toBe(version + 1);
    renderable.dispose();
  });

  it("rebinds a changed-size texture while retaining its uniform objects", async () => {
    const { renderable } = fixture();
    mockDecode(renderable).mockResolvedValueOnce(bitmap()).mockResolvedValueOnce(bitmap(800, 600));
    await presentImage(renderable);
    const oldTexture = renderable.userData.texture;
    const map = renderable.userData.material!.uniforms.map;
    await presentImage(renderable);
    expect(renderable.userData.texture).not.toBe(oldTexture);
    expect(renderable.userData.material!.uniforms.map).toBe(map);
    expect(map!.value).toBe(renderable.userData.texture);
    renderable.dispose();
  });

  it("recovers the update guard after a transient header failure", () => {
    const { renderable } = fixture();
    renderable.userData.image = sample;
    jest.spyOn(renderable, "updateHeaderInfo").mockImplementationOnce(() => {
      throw new Error("transient header failure");
    });
    expect(() => renderable.update()).toThrow("transient header failure");
    renderable.update();
    expect(renderable.userData.material).toBeInstanceOf(THREE.ShaderMaterial);
    renderable.dispose();
  });

  it("keeps the presented video bitmap alive until the same-size texture is swapped", async () => {
    const { renderable } = videoFixture();
    const first = bitmap();
    const second = bitmap();
    jest
      .spyOn(globalThis, "createImageBitmap")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    renderable.setImage(video(key, 0));
    await flush(renderable);
    const texture = renderable.userData.texture;
    renderable.setImage(video(delta, 1));
    await flush(renderable);
    expect(renderable.userData.texture).toBe(texture);
    expect(texture!.image).toBe(second);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    renderable.dispose();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("does not let a dropped duplicate suppress the last queued video presentation", async () => {
    const { renderable, decode, renderer } = videoFixture();
    jest.spyOn(globalThis, "createImageBitmap").mockImplementation(async () => bitmap());
    renderable.setImage(video(key, 0));
    await flush(renderable);
    const oldImage = renderable.userData.texture!.image;
    const next = video(delta, 1);
    renderable.setImage(next);
    renderable.setImage(next);
    expect(renderable.getVideoBufferStats().pendingFrames).toBe(1);
    await flush(renderable);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(renderable.userData.texture!.image).not.toBe(oldImage);
    expect(renderer.queueAnimationFrame).toHaveBeenCalledTimes(2);
    renderable.dispose();
  });

  it("releases skipped bitmaps without closing the visible texture early", async () => {
    const { renderable } = videoFixture();
    const first = bitmap();
    const skipped = bitmap();
    const last = bitmap();
    jest.spyOn(globalThis, "createImageBitmap")
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(skipped)
      .mockResolvedValueOnce(last);
    renderable.setImage(video(key, 0));
    await flush(renderable);
    const afterIntermediate = jest.fn(() => {
      expect(first.close).not.toHaveBeenCalled();
      expect(renderable.userData.texture!.image).toBe(first);
    });
    renderable.setImage(video(delta, 1), undefined, afterIntermediate);
    renderable.setImage(video(delta, 2));
    await flush(renderable);
    expect(afterIntermediate).toHaveBeenCalledTimes(1);
    expect(skipped.close).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(last.close).not.toHaveBeenCalled();
    expect(renderable.userData.texture!.image).toBe(last);
    renderable.dispose();
  });
});
