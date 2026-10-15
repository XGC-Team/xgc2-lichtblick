/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { setupJestCanvasMock } from "jest-canvas-mock";
import * as THREE from "three";

import { Renderer } from "./Renderer";
import { SceneExtension } from "./SceneExtension";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "./SceneExtensionConfig";
import { CameraState, DEFAULT_CAMERA_STATE } from "./camera";
import { DEFAULT_PUBLISH_SETTINGS } from "./renderables/PublishSettings";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");
jest.mock("./Picker", () => ({
  Picker: jest.fn().mockImplementation(() => ({ dispose: jest.fn(), pick: jest.fn(() => -1) })),
}));
jest.mock("three", () => ({
  ...jest.requireActual("three"),
  WebGLRenderer: jest.fn().mockImplementation(() => ({
    capabilities: { isWebGL2: true },
    setPixelRatio: jest.fn(),
    getPixelRatio: () => 1,
    setSize: jest.fn(),
    getDrawingBufferSize: () => ({ width: 100, height: 100 }),
    render: jest.fn(),
    clear: jest.fn(),
    clearDepth: jest.fn(),
    setClearColor: jest.fn(),
    info: { reset: jest.fn() },
    shadowMap: {},
    dispose: jest.fn(),
  })),
}));

describe("world-space camera transitions", () => {
  let renderer: Renderer;
  let canvas: HTMLCanvasElement;
  let now: number;
  let frames: Map<number, FrameRequestCallback>;
  const originalObserver = globalThis.ResizeObserver;
  const robotPosition = new THREE.Vector3(120, -70, 8);
  const robotOrientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.15, 1.2));

  beforeEach(() => {
    setupJestCanvasMock();
    now = 0;
    jest.spyOn(performance, "now").mockImplementation(() => now);
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
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn(() => ({ addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    const parent = document.createElement("div");
    canvas = document.createElement("canvas");
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
        followTf: "world",
        scene: {},
        transforms: { "frame:world": { visible: true } },
        topics: {},
        layers: {},
        publish: DEFAULT_PUBLISH_SETTINGS,
        imageMode: {},
      },
      interfaceMode: "3d",
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      customCameraModels: new Map(),
      fetchAsset: async () => {
        throw new Error("No assets expected");
      },
      testOptions: {},
    });
    renderer.setCurrentTime(1n);
    renderer.addTransform("world", "robot", 1n, robotPosition, robotOrientation);
    renderer.animationFrame();
  });

  afterEach(() => {
    renderer.dispose();
    globalThis.ResizeObserver = originalObserver;
    jest.restoreAllMocks();
  });

  function worldPose() {
    const camera = renderer.cameraHandler.getActiveCamera();
    camera.updateWorldMatrix(true, false);
    const position = camera.getWorldPosition(new THREE.Vector3());
    const orientation = camera.getWorldQuaternion(new THREE.Quaternion());
    if (renderer.followFrameId === "robot") {
      position.applyQuaternion(robotOrientation).add(robotPosition);
      orientation.premultiply(robotOrientation);
    }
    return { position, orientation };
  }

  function select(frame: string, state: CameraState = DEFAULT_CAMERA_STATE) {
    renderer.updateConfig((draft) => {
      draft.followTf = frame;
      draft.cameraState = state;
    });
  }

  function expectPose(
    actual: ReturnType<typeof worldPose>,
    expected: ReturnType<typeof worldPose>,
  ) {
    expect(actual.position.distanceTo(expected.position)).toBeLessThan(1e-8);
    expect(Math.abs(actual.orientation.dot(expected.orientation))).toBeCloseTo(1, 10);
  }

  it("moves between far translated/rotated frames in world space even with identical local orbit fields", () => {
    const source = worldPose();
    const destination = {
      position: source.position.clone().applyQuaternion(robotOrientation).add(robotPosition),
      orientation: robotOrientation.clone().multiply(source.orientation),
    };
    select("robot");
    const moved = jest.fn();
    const changed = jest.fn();
    renderer.on("cameraMove", moved);
    renderer.on("configChange", changed);
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    expectPose(worldPose(), source);
    expect(frames.size).toBe(1);

    now = 500;
    renderer.animationFrame();
    expectPose(worldPose(), {
      position: source.position.clone().lerp(destination.position, 0.5),
      orientation: source.orientation.clone().slerp(destination.orientation, 0.5),
    });
    // Paused simulation time must not freeze a UI camera transition.
    expect(renderer.currentTime).toBe(1n);
    now = 1000;
    renderer.animationFrame();
    expectPose(worldPose(), destination);
    expect(frames.size).toBe(0);
    now = 2000;
    renderer.animationFrame();
    expectPose(worldPose(), destination);
    expect(moved).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });

  it("snapshots the final painted pose when a later scene extension changes the camera", () => {
    const late = new SceneExtension("test-late-camera", renderer);
    let update = true;
    late.startFrame = () => {
      if (update) {
        update = false;
        const target = { ...DEFAULT_CAMERA_STATE, distance: 9, thetaOffset: 120 };
        select("world", target);
        renderer.setCameraState(target);
      }
    };
    renderer.sceneExtensions.set(late.extensionId, late);
    renderer.animationFrame();
    const painted = worldPose();
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    expectPose(worldPose(), painted);
  });

  it("starts a replacement transition from the currently rendered world pose", () => {
    const original = worldPose();
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    now = 400;
    renderer.animationFrame();
    const interrupted = worldPose();
    expect(interrupted.position.distanceTo(original.position)).toBeGreaterThan(1);
    select("world");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    expectPose(worldPose(), interrupted);
    now = 900;
    renderer.animationFrame();
    expectPose(worldPose(), {
      position: interrupted.position.clone().lerp(original.position, 0.5),
      orientation: interrupted.orientation.clone().slerp(original.orientation, 0.5),
    });
    now = 1400;
    renderer.animationFrame();
    expectPose(worldPose(), original);
  });

  it("queries the current pose and projection during animation and after position-follow settles", () => {
    const target = { ...DEFAULT_CAMERA_STATE, distance: 8, phi: 35, thetaOffset: 120, fovy: 60 };
    select("robot", target);
    renderer.updateConfig((draft) => {
      draft.followMode = "follow-position";
    });
    renderer.transitionCameraState(target, { durationMs: 1000 });
    renderer.animationFrame();
    now = 500;
    renderer.animationFrame();
    const current = renderer.getCameraState()!;
    expect(current.distance).toBeCloseTo(14);
    expect(current.fovy).toBeCloseTo(52.5);
    now = 1000;
    renderer.animationFrame();
    const settled = renderer.getCameraState()!;
    expect(settled.distance).toBeCloseTo(target.distance);
    expect(settled.phi).toBeCloseTo(target.phi);
    expect(settled.thetaOffset).toBeCloseTo(target.thetaOffset);
    expect(settled.fovy).toBeCloseTo(target.fovy);
  });

  it.each([
    true,
    false,
  ])("restores the remembered WORLD getter exactly after a robot visit (perspective=%s)", (perspective) => {
    const global = {
      ...DEFAULT_CAMERA_STATE,
      perspective,
      distance: 33,
      phi: 47,
      thetaOffset: -82,
      targetOffset: [15, -12, 4] as const,
      fovy: 39,
      near: 0.2,
      far: 2500,
    };
    select("world", global);
    renderer.updateConfig((draft) => {
      draft.followMode = "follow-none";
    });
    renderer.setCameraState(global);
    renderer.animationFrame();
    const original = worldPose();
    // This is captured before changing follow configuration, as the native handler does.
    const remembered = renderer.getCameraState()!;
    expect(remembered.distance).toBeCloseTo(global.distance);
    expect(remembered.targetOffset).toEqual(global.targetOffset);

    const robot = { ...DEFAULT_CAMERA_STATE, perspective, distance: 11 };
    select("robot", robot);
    renderer.updateConfig((draft) => {
      draft.followMode = "follow-position";
    });
    renderer.transitionCameraState(robot, { durationMs: 1000 });
    renderer.animationFrame();
    now = 1000;
    renderer.animationFrame();
    expect(worldPose().position.distanceTo(original.position)).toBeGreaterThan(1);

    select("world", remembered);
    renderer.updateConfig((draft) => {
      draft.followMode = "follow-none";
    });
    renderer.transitionCameraState(remembered, { durationMs: 500 });
    renderer.animationFrame();
    now = 1500;
    renderer.animationFrame();
    expectPose(worldPose(), original);
    const restored = renderer.getCameraState()!;
    expect(restored.distance).toBeCloseTo(global.distance);
    expect(restored.fovy).toBeCloseTo(global.fovy);
    expect(restored.near).toBeCloseTo(global.near);
    expect(restored.far).toBeCloseTo(global.far);
    expect(restored.targetOffset).toEqual(global.targetOffset);
  });

  it("cancels an animation when the existing instant setter receives a newer view", () => {
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    now = 300;
    renderer.animationFrame();
    const target = { ...DEFAULT_CAMERA_STATE, distance: 7, phi: 30 };
    select("world", target);
    renderer.setCameraState(target);
    renderer.setFollowFrameId("world");
    renderer.animationFrame();
    const instant = worldPose();
    expect(renderer.getCameraState()!.distance).toBeCloseTo(7);
    now = 3000;
    renderer.animationFrame();
    expectPose(worldPose(), instant);
    expect(frames.size).toBe(0);
  });

  it("uses the existing instant setter for zero-duration transitions", () => {
    const set = jest.spyOn(renderer.cameraHandler, "setCameraState");
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 0 });
    renderer.animationFrame();
    expect(set).toHaveBeenCalledWith(DEFAULT_CAMERA_STATE);
    expect(renderer.followFrameId).toBe("robot");
    expect(frames.size).toBe(0);
  });

  it("hands control to a manual wheel gesture without resuming the old animation", () => {
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    now = 400;
    renderer.animationFrame();
    const moved = jest.fn();
    renderer.on("cameraMove", moved);
    canvas.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }),
    );
    expect(moved).toHaveBeenCalled();
    renderer.animationFrame();
    const manual = worldPose();
    now = 3000;
    renderer.animationFrame();
    expectPose(worldPose(), manual);
    expect(frames.size).toBe(0);
  });

  it("cancels scheduled frames on dispose and ignores later transition requests", () => {
    select("robot");
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    renderer.animationFrame();
    expect(frames.size).toBe(1);
    renderer.dispose();
    expect(frames.size).toBe(0);
    renderer.transitionCameraState(DEFAULT_CAMERA_STATE, { durationMs: 1000 });
    expect(frames.size).toBe(0);
  });
});
