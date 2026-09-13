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
  Picker: jest.fn().mockImplementation(() => ({ dispose: jest.fn(), pick: jest.fn(() => -1) })),
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
  let render: jest.SpyInstance;
  let setSize: jest.SpyInstance;
  let setPixelRatio: jest.SpyInstance;
  let frames: Map<number, FrameRequestCallback>;
  const originalPixelRatio = window.devicePixelRatio;
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const originalObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    jest.useFakeTimers();
    setupJestCanvasMock();
    // This suite emits resize events explicitly; Input lifecycle tests cover
    // observer delivery. Avoid the global mock's eager initialization callback.
    globalThis.ResizeObserver = class {
      public observe(): void {}
      public unobserve(): void {}
      public disconnect(): void {}
    };
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
    render = jest.spyOn(renderer.gl, "render");
    setSize = jest.spyOn(renderer.gl, "setSize");
    setPixelRatio = jest.spyOn(renderer.gl, "setPixelRatio");
    jest.clearAllMocks();
  });

  afterEach(() => {
    renderer.dispose();
    jest.useRealTimers();
    globalThis.ResizeObserver = originalObserver;
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
    expect(render).not.toHaveBeenCalled();
    expect(setSize).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    const callback = [...frames.values()][0]!;
    callback(0);
    expect(render).toHaveBeenCalledTimes(1);
    expect(setSize).not.toHaveBeenCalled();
    jest.advanceTimersByTime(80);
    [...frames.values()][0]!(80);
    expect(setSize).toHaveBeenCalledTimes(1);
    expect(setSize).toHaveBeenCalledWith(210, 160, false);
    expect(frames.size).toBe(0);
  });

  it("follows camera aspect during motion and changes only resolution after settling", () => {
    const cameraResize = jest.spyOn(renderer.cameraHandler, "handleResize");
    for (let width = 101; width <= 160; width++) {
      resize(width, 100);
      jest.advanceTimersByTime(16);
      [...frames.values()][0]!(width);
      expect(cameraResize).toHaveBeenLastCalledWith(width, 100, 1);
    }
    expect(setPixelRatio).not.toHaveBeenCalled();
    expect(setSize).not.toHaveBeenCalled();
    cameraResize.mockClear();
    jest.advanceTimersByTime(80);
    [...frames.values()][0]!(1000);
    expect(setSize).toHaveBeenCalledTimes(1);
    expect(setSize).toHaveBeenCalledWith(160, 100, false);
    expect(cameraResize).not.toHaveBeenCalled();
  });

  it("ignores duplicate and non-renderable sizes", () => {
    resize(100, 100);
    resize(0, 100);
    resize(100, 0);
    resize(Number.NaN, 100);
    resize(100, Number.POSITIVE_INFINITY);
    expect(setSize).not.toHaveBeenCalled();
    expect(setPixelRatio).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("restores buffer resolution before picking during a resize", () => {
    renderer.setPickingEnabled(true);
    resize(200, 150);
    [...frames.values()][0]!(0);
    expect(setSize).not.toHaveBeenCalled();
    renderer.input.emit(
      "click",
      renderer.input.canvasSize.clone().set(20, 30),
      undefined,
      new MouseEvent("click"),
    );
    expect(setSize).toHaveBeenCalledTimes(1);
    expect(setSize).toHaveBeenCalledWith(200, 150, false);
    jest.advanceTimersByTime(80);
    expect(frames.size).toBe(0);
  });

  it("updates a changed device pixel ratio without a second same-size reset", () => {
    const cameraResize = jest.spyOn(renderer.cameraHandler, "handleResize");
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    resize(100, 100);
    expect(frames.size).toBe(1);
    [...frames.values()][0]!(0);
    jest.advanceTimersByTime(80);
    [...frames.values()][0]!(80);
    expect(setPixelRatio).toHaveBeenCalledWith(2);
    expect(cameraResize).toHaveBeenCalledWith(100, 100, 2);
    expect(setSize).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("recovers on the next frame after a scene extension throws", () => {
    const fail = () => {
      throw new Error("transient frame failure");
    };
    renderer.on("startFrame", fail);
    expect(() => {
      renderer.animationFrame();
    }).toThrow("transient frame failure");
    renderer.off("startFrame", fail);
    renderer.animationFrame();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending paint and ignores late callbacks after disposal", () => {
    resize(200, 150);
    const [id, callback] = [...frames.entries()][0]!;
    renderer.dispose();
    jest.advanceTimersByTime(80);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(id);
    callback(0);
    renderer.queueAnimationFrame();
    renderer.animationFrame();
    expect(frames.size).toBe(0);
    expect(render).not.toHaveBeenCalled();
  });
});
