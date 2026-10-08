/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import EventEmitter from "eventemitter3";
import * as THREE from "three";

import { ObjectPool } from "@lichtblick/den/collection";

import { PublishClickEventMap, PublishClickTool } from "./PublishClickTool";
import { IRenderer } from "../IRenderer";
import { InputEvents } from "../Input";
import { SharedGeometry } from "../SharedGeometry";
import { DetailLevel } from "../lod";
import { RenderableArrow } from "./markers/RenderableArrow";
import { RenderableSphere } from "./markers/RenderableSphere";
import { Transform } from "../transforms/Transform";
import { TransformTree } from "../transforms/TransformTree";

const cleanups: (() => void)[] = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => {
    cleanup();
  });
});

function setup(cameraType: "2D" | "3D" = "3D") {
  const camera =
    cameraType === "2D"
      ? new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 100)
      : new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
  camera.position.set(...(cameraType === "2D" ? [0, 0, 15] : [6, -8, 15]));
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const input = Object.assign(new EventEmitter<InputEvents>(), {
    canvasSize: new THREE.Vector2(800, 600),
  });
  const transformTree = new TransformTree(new ObjectPool(Transform.Empty));
  const renderer = {
    input,
    transformTree,
    currentTime: 1n,
    followFrameId: "robot",
    fixedFrameId: "world",
    cameraHandler: { getActiveCamera: () => camera },
    sharedGeometry: new SharedGeometry(),
    outlineMaterial: new THREE.LineBasicMaterial(),
    maxLod: DetailLevel.Low,
    normalizeFrameId: (frameId: string) => frameId,
    config: { topics: {} },
    settings: { setNodesForKey: jest.fn() },
    queueAnimationFrame: jest.fn(),
  };
  const tool = new PublishClickTool(renderer as unknown as IRenderer);
  const submit = jest.fn<void, [PublishClickEventMap["foxglove.publish-submit"]]>();
  tool.addEventListener("foxglove.publish-submit", submit);
  const robotToWorld = new THREE.Matrix4();

  function setRobot(time: bigint, position: THREE.Vector3, rotation: THREE.Euler) {
    const quaternion = new THREE.Quaternion().setFromEuler(rotation);
    robotToWorld.compose(position, quaternion, new THREE.Vector3(1, 1, 1));
    transformTree.addTransform(
      "robot",
      "world",
      time,
      new Transform(position.toArray(), quaternion.toArray()),
    );
    renderer.currentTime = time;
  }

  function frame() {
    tool.startFrame(renderer.currentTime, renderer.followFrameId, renderer.fixedFrameId);
    tool.updateMatrixWorld(true);
  }

  // Project known render-frame positions through the actual camera, and pass
  // the same render-XY intersection as Input. The tool must derive world ground
  // from the ray instead of transforming this already flattened position.
  function pointer(type: "click" | "mousemove", renderPoint: THREE.Vector3) {
    const ndc = renderPoint.clone().project(camera);
    const cursor = new THREE.Vector2(((ndc.x + 1) / 2) * 800, ((1 - ndc.y) / 2) * 600);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const renderGround = raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      new THREE.Vector3(),
    );
    input.emit(type, cursor, renderGround ?? undefined, new MouseEvent(type));
  }

  function worldPointer(type: "click" | "mousemove", worldPoint: THREE.Vector3) {
    pointer(type, worldPoint.clone().applyMatrix4(robotToWorld.clone().invert()));
  }

  function previewWorldPosition() {
    tool.updateMatrixWorld(true);
    const preview = tool.children.find((child) => child.visible)!;
    return preview.getWorldPosition(new THREE.Vector3()).applyMatrix4(robotToWorld);
  }

  setRobot(1n, new THREE.Vector3(10, 20, 2), new THREE.Euler(0, 0, Math.PI / 2));
  cleanups.push(() => {
    tool.dispose();
    renderer.sharedGeometry.dispose();
    renderer.outlineMaterial.dispose();
  });
  return {
    tool,
    renderer,
    submit,
    camera,
    frame,
    setRobot,
    pointer,
    worldPointer,
    previewWorldPosition,
    robotToWorld,
  };
}

function expectPoint(actual: { x: number; y: number; z: number }, expected: THREE.Vector3) {
  expect(actual.x).toBeCloseTo(expected.x, 8);
  expect(actual.y).toBeCloseTo(expected.y, 8);
  expect(actual.z).toBeCloseTo(expected.z, 8);
}

describe("PublishClickTool", () => {
  it.each([
    "2D",
    "3D",
  ] as const)("keeps both %s goal clicks and preview in world as the followed robot moves", (cameraType) => {
    const { tool, submit, frame, setRobot, worldPointer, previewWorldPosition, robotToWorld } =
      setup(cameraType);
    const first = new THREE.Vector3(12, 25, 0);
    const second = new THREE.Vector3(12, 30, 0);
    tool.setPublishClickType("pose");
    tool.start("world");
    frame();

    worldPointer("mousemove", first);
    expectPoint(previewWorldPosition(), first);
    worldPointer("click", first);
    expect(tool.state).toBe("place-second-point");
    expect(submit).not.toHaveBeenCalled();

    setRobot(2n, new THREE.Vector3(14, 21, 3), new THREE.Euler(0.1, 0.2, -Math.PI / 3));
    frame();
    expectPoint(previewWorldPosition(), first);
    worldPointer("mousemove", second);
    expectPoint(previewWorldPosition(), first);
    tool.updateMatrixWorld(true);
    const arrow = tool.children.find((child) => child instanceof RenderableArrow)!;
    const direction = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(arrow.getWorldQuaternion(new THREE.Quaternion()))
      .transformDirection(robotToWorld);
    expectPoint(direction, new THREE.Vector3(0, 1, 0));

    worldPointer("click", second);
    expect(submit).toHaveBeenCalledTimes(1);
    const event = submit.mock.calls[0]![0];
    expect(event.frameId).toBe("world");
    expect(event.publishClickType).toBe("pose");
    if (event.publishClickType === "point") {
      throw new Error("Expected a pose");
    }
    expectPoint(event.pose.position, first);
    expectPoint(event.pose.orientation, new THREE.Vector3(0, 0, Math.SQRT1_2));
    expect(event.pose.orientation.w).toBeCloseTo(Math.SQRT1_2, 8);
    expect(tool.state).toBe("idle");
    expect(tool.children.every((child) => !child.visible)).toBe(true);
  });

  it.each(["2D", "3D"] as const)("publishes a %s point on world ground", (cameraType) => {
    const { tool, submit, frame, worldPointer, previewWorldPosition } = setup(cameraType);
    const point = new THREE.Vector3(12, 25, 0);
    tool.start("world");
    frame();
    worldPointer("mousemove", point);
    expect(tool.children.find((child) => child.visible)).toBeInstanceOf(RenderableSphere);
    expectPoint(previewWorldPosition(), point);
    worldPointer("click", point);
    const event = submit.mock.calls[0]![0];
    expect(event.frameId).toBe("world");
    expect(event.publishClickType).toBe("point");
    if (event.publishClickType !== "point") {
      throw new Error("Expected a point");
    }
    expectPoint(event.point, point);
  });

  it("cancels a world goal and starts a fresh pose estimate in the default follow frame", () => {
    const { tool, submit, renderer, frame, worldPointer, pointer } = setup();
    tool.setPublishClickType("pose");
    tool.start("world");
    frame();
    worldPointer("click", new THREE.Vector3(12, 25, 0));
    tool.stop();
    expect(renderer.input.listenerCount("click")).toBe(0);
    expect(renderer.input.listenerCount("mousemove")).toBe(0);
    expect(submit).not.toHaveBeenCalled();

    tool.setPublishClickType("pose_estimate");
    tool.start();
    frame();
    expect(tool.children.every((child) => !child.visible)).toBe(true);
    pointer("click", new THREE.Vector3(1, 2, 0));
    pointer("click", new THREE.Vector3(4, 2, 0));
    const event = submit.mock.calls[0]![0];
    expect(event.frameId).toBe("robot");
    expect(event.publishClickType).toBe("pose_estimate");
    if (event.publishClickType === "point") {
      throw new Error("Expected a pose estimate");
    }
    expectPoint(event.pose.position, new THREE.Vector3(1, 2, 0));
    expectPoint(event.pose.orientation, new THREE.Vector3());
    expect(event.pose.orientation.w).toBeCloseTo(1, 8);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks before the selected frame is resolved or when its transform is missing", () => {
    const { tool, submit, frame, pointer } = setup();
    tool.start("missing");
    pointer("click", new THREE.Vector3());
    frame();
    pointer("click", new THREE.Vector3());
    expect(tool.visible).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    expect(tool.state).toBe("place-first-point");
  });

  it("does not publish when the camera ray points away from the selected ground", () => {
    const { tool, submit, renderer, camera, frame } = setup();
    tool.start("world");
    frame();
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(0, 0, 1)));
    camera.updateMatrixWorld(true);
    renderer.input.emit("click", new THREE.Vector2(400, 300), undefined, new MouseEvent("click"));
    expect(submit).not.toHaveBeenCalled();
  });

  it("picks world ground even when the ray is parallel to the render ground", () => {
    const { tool, submit, renderer, camera, frame, setRobot, robotToWorld } = setup();
    setRobot(2n, new THREE.Vector3(10, 20, 2), new THREE.Euler(0, Math.PI / 6, 0));
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(1, 0, 0)));
    camera.updateMatrixWorld(true);
    tool.start("world");
    frame();
    const worldOrigin = camera.position.clone().applyMatrix4(robotToWorld);
    const worldDirection = new THREE.Vector3(1, 0, 0).transformDirection(robotToWorld);
    const expected = worldOrigin
      .clone()
      .addScaledVector(worldDirection, -worldOrigin.z / worldDirection.z);
    renderer.input.emit("click", new THREE.Vector2(400, 300), undefined, new MouseEvent("click"));
    expect(submit).toHaveBeenCalledTimes(1);
    const event = submit.mock.calls[0]![0];
    expect(event.frameId).toBe("world");
    if (event.publishClickType !== "point") {
      throw new Error("Expected a point");
    }
    expectPoint(event.point, expected);
  });
});
