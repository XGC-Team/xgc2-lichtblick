/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { setupJestCanvasMock } from "jest-canvas-mock";

import { Renderer } from "./Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "./SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "./camera";
import { DEFAULT_PUBLISH_SETTINGS } from "./renderables/PublishSettings";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");
jest.mock("./Picker", () => ({
  Picker: jest.fn().mockImplementation(() => ({ dispose: jest.fn() })),
}));
jest.mock("three", () => ({
  ...jest.requireActual("three"),
  WebGLRenderer: jest.fn().mockImplementation(() => {
    let ratio = 1;
    return {
      capabilities: { isWebGL2: true },
      setPixelRatio: jest.fn((value: number) => {
        ratio = value;
      }),
      getPixelRatio: () => ratio,
      setSize: jest.fn(),
      getDrawingBufferSize: () => ({ width: 100, height: 100 }),
      render: jest.fn(),
      clear: jest.fn(),
      clearDepth: jest.fn(),
      setClearColor: jest.fn(),
      info: { reset: jest.fn() },
      shadowMap: {},
      dispose: jest.fn(),
    };
  }),
}));

describe("renderer resize scheduling and recovery", () => {
  let renderer: Renderer;
  let frames: Map<number, FrameRequestCallback>;
  const originalPixelRatio = window.devicePixelRatio;
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");

  beforeEach(() => {
    setupJestCanvasMock();
    frames = new Map();
    let nextFrame = 0;
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn(() => ({
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    const parent = document.createElement("div");
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    Object.defineProperties(parent, {
      clientWidth: { value: 100 },
      clientHeight: { value: 100 },
    });
    renderer = new Renderer({
      canvas,
      config: {
        cameraState: DEFAULT_CAMERA_STATE,
        followMode: "follow-pose",
        followTf: undefined,
        scene: {},
        transforms: {},
        topics: {},
        layers: {},
        publish: DEFAULT_PUBLISH_SETTINGS,
        imageMode: {},
      },
      interfaceMode: "3d",
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      customCameraModels: new Map(),
      fetchAsset: async () => {
        throw new Error("No assets expected in scheduling tests");
      },
      testOptions: {},
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    renderer.dispose();
    jest.restoreAllMocks();
    if (originalMatchMedia) {
      Object.defineProperty(window, "matchMedia", originalMatchMedia);
    } else {
      Reflect.deleteProperty(window, "matchMedia");
    }
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: originalPixelRatio,
    });
  });

  const resize = (width: number, height: number) => {
    renderer.input.canvasSize.set(width, height);
    renderer.input.emit("resize", renderer.input.canvasSize);
  };

  it("shares one pending paint with resize and decoded-frame notifications", () => {
    resize(200, 150);
    resize(210, 160);
    renderer.queueAnimationFrame();
    expect(renderer.gl.render).not.toHaveBeenCalled();
    expect(renderer.gl.setSize).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    const callback = [...frames.values()][0]!;
    callback(0);
    expect(renderer.gl.render).toHaveBeenCalledTimes(1);
    expect(renderer.gl.setSize).toHaveBeenCalledTimes(1);
    expect(renderer.gl.setSize).toHaveBeenCalledWith(210, 160);
    expect(frames.size).toBe(0);
  });

  it("does not reset the pixel ratio on every animated size change", () => {
    for (let width = 101; width <= 160; width++) {
      resize(width, 100);
      [...frames.values()][0]!(width);
    }
    expect(renderer.gl.setPixelRatio).not.toHaveBeenCalled();
    expect(renderer.gl.setSize).toHaveBeenCalledTimes(60);
  });

  it("ignores duplicate and non-renderable sizes", () => {
    resize(100, 100);
    resize(0, 100);
    resize(100, 0);
    resize(Number.NaN, 100);
    resize(100, Number.POSITIVE_INFINITY);
    expect(renderer.gl.setSize).not.toHaveBeenCalled();
    expect(renderer.gl.setPixelRatio).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("updates a changed device pixel ratio without a second same-size reset", () => {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    resize(100, 100);
    expect(frames.size).toBe(1);
    [...frames.values()][0]!(0);
    expect(renderer.gl.setPixelRatio).toHaveBeenCalledWith(2);
    expect(renderer.gl.setSize).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("recovers on the next frame after a scene extension throws", () => {
    const fail = () => {
      throw new Error("transient frame failure");
    };
    renderer.on("startFrame", fail);
    expect(() => renderer.animationFrame()).toThrow("transient frame failure");
    renderer.off("startFrame", fail);
    renderer.animationFrame();
    expect(renderer.gl.render).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending paint and ignores late callbacks after disposal", () => {
    resize(200, 150);
    const [id, callback] = [...frames.entries()][0]!;
    renderer.dispose();
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(id);
    callback(0);
    renderer.queueAnimationFrame();
    renderer.animationFrame();
    expect(frames.size).toBe(0);
    expect(renderer.gl.render).not.toHaveBeenCalled();
  });
});
