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
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "./SceneExtensionConfig";
import { CameraState, DEFAULT_CAMERA_STATE } from "./camera";
import { DEFAULT_PUBLISH_SETTINGS } from "./renderables/PublishSettings";
import { robotViewpointCamera } from "./viewpointCamera";

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

describe("Viewpoint preserves the painted world orbit", () => {
  let renderer: Renderer;
  let now: number;
  let frames: Map<number, FrameRequestCallback>;
  const originalObserver = globalThis.ResizeObserver;
  const robots = new Map([
    [
      "robotA",
      {
        position: new THREE.Vector3(120, -70, 8),
        orientation: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.15, 1.2)),
      },
    ],
    [
      "robotB",
      {
        position: new THREE.Vector3(-40, 130, 4),
        orientation: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 0.4, -2.1)),
      },
    ],
  ]);

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
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => frames.delete(id));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn(() => ({ addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    const parent = document.createElement("div");
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    Object.defineProperties(parent, { clientWidth: { value: 100 }, clientHeight: { value: 100 } });
    renderer = new Renderer({
      canvas,
      config: {
        cameraState: DEFAULT_CAMERA_STATE,
        followMode: "follow-none",
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
    for (const [frame, pose] of robots) {
      renderer.addTransform("world", frame, 1n, pose.position, pose.orientation);
    }
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
    const frame = robots.get(renderer.followFrameId ?? "");
    if (frame) {
      position.applyQuaternion(frame.orientation).add(frame.position);
      orientation.premultiply(frame.orientation);
    }
    return { position, orientation };
  }

  function select(frame: string, camera: CameraState) {
    renderer.updateConfig((draft) => {
      draft.followTf = frame;
      draft.followMode = frame === "world" ? "follow-none" : "follow-position";
      draft.cameraState = camera;
    });
  }

  function visit(frame: string, camera: CameraState = renderer.getCameraState()!) {
    const target = robotViewpointCamera(camera);
    select(frame, target);
    renderer.transitionCameraState(target, { durationMs: 500 });
    renderer.animationFrame();
    return target;
  }

  function settle() {
    now += 500;
    renderer.animationFrame();
  }

  function expectOrientation(actual: THREE.Quaternion, expected: THREE.Quaternion) {
    expect(Math.abs(actual.dot(expected))).toBeCloseTo(1, 10);
  }

  it.each([
    true,
    false,
  ])("keeps zoom and world eye orientation through rotated robotA->B and WORLD roundtrip (perspective=%s)", (perspective) => {
    const world: CameraState = {
      ...DEFAULT_CAMERA_STATE,
      perspective,
      distance: 37,
      phi: 44,
      thetaOffset: -73,
      targetOffset: [15, -12, 0],
      fovy: 52,
      near: 0.2,
      far: 6000,
    };
    select("world", world);
    renderer.setCameraState(world);
    renderer.animationFrame();
    const original = worldPose();
    const remembered = renderer.getCameraState()!;
    visit("robotA");
    settle();
    expect(renderer.getCameraState()!.distance).toBeCloseTo(37);
    expectOrientation(worldPose().orientation, original.orientation);

    const robotOrbit = {
      ...renderer.getCameraState()!,
      distance: 9,
      phi: 32,
      thetaOffset: 117,
      targetOffset: [3, -4, 0] as const,
    };
    select("robotA", robotOrbit);
    renderer.setCameraState(robotOrbit);
    renderer.animationFrame();
    const before = worldPose();
    const center = robots
      .get("robotA")!
      .position.clone()
      .add(new THREE.Vector3(3, -4, 0));
    const eyeOffset = before.position.clone().sub(center);
    visit("robotB");
    settle();
    expect(renderer.getCameraState()!.distance).toBeCloseTo(9);
    expectOrientation(worldPose().orientation, before.orientation);
    expect(
      worldPose().position.distanceTo(robots.get("robotB")!.position.clone().add(eyeOffset)),
    ).toBeLessThan(1e-8);

    select("world", remembered);
    renderer.transitionCameraState(remembered, { durationMs: 500 });
    renderer.animationFrame();
    settle();
    expectOrientation(worldPose().orientation, original.orientation);
    expect(worldPose().position.distanceTo(original.position)).toBeLessThan(1e-8);
    expect(renderer.getCameraState()!.distance).toBeCloseTo(37);
    expect(renderer.getCameraState()!.targetOffset).toEqual(remembered.targetOffset);
  });

  it("uses the latest painted orbit when robotB interrupts a robotA transition", () => {
    const world = { ...DEFAULT_CAMERA_STATE, distance: 31, phi: 42, thetaOffset: -66 };
    select("world", world);
    renderer.setCameraState(world);
    renderer.animationFrame();
    const original = worldPose();
    visit("robotA");
    now = 200;
    renderer.animationFrame();
    const interrupted = worldPose();
    expect(interrupted.position.distanceTo(original.position)).toBeGreaterThan(1);
    const target = visit("robotB");
    expect(worldPose().position.distanceTo(interrupted.position)).toBeLessThan(1e-8);
    expectOrientation(worldPose().orientation, interrupted.orientation);
    settle();
    expect(renderer.followFrameId).toBe("robotB");
    expect(renderer.getCameraState()!.distance).toBeCloseTo(target.distance);
    expectOrientation(worldPose().orientation, original.orientation);
    const latest = worldPose();
    now = 3000;
    renderer.animationFrame();
    expect(worldPose().position.distanceTo(latest.position)).toBeLessThan(1e-8);
    expect(frames.size).toBe(0);
  });

  it("uses the selected WORLD baseline on interruption while preserving transition continuity and WORLD memory", () => {
    const world = { ...DEFAULT_CAMERA_STATE, distance: 53, phi: 35, thetaOffset: -80 };
    select("world", world);
    renderer.setCameraState(world);
    renderer.animationFrame();
    const original = worldPose();
    const remembered = renderer.getCameraState()!;
    visit("robotA");
    settle();
    const zoomed = { ...renderer.getCameraState()!, distance: 7, phi: 72, thetaOffset: 21 };
    select("robotA", zoomed);
    renderer.setCameraState(zoomed);
    renderer.animationFrame();
    select("world", remembered);
    renderer.transitionCameraState(remembered, { durationMs: 500 });
    renderer.animationFrame();
    now += 200;
    renderer.animationFrame();
    const interrupted = worldPose();
    // The handler uses the selected WORLD orbit while its return is still in progress.
    visit("robotB", remembered);
    expect(worldPose().position.distanceTo(interrupted.position)).toBeLessThan(1e-8);
    expectOrientation(worldPose().orientation, interrupted.orientation);
    settle();
    expect(renderer.followFrameId).toBe("robotB");
    expect(renderer.getCameraState()!.distance).toBeCloseTo(remembered.distance);
    expectOrientation(worldPose().orientation, original.orientation);
    select("world", remembered);
    renderer.transitionCameraState(remembered, { durationMs: 500 });
    renderer.animationFrame();
    settle();
    expect(worldPose().position.distanceTo(original.position)).toBeLessThan(1e-8);
    expectOrientation(worldPose().orientation, original.orientation);
  });
});
