/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import { embeddedSceneBridge } from "@lichtblick/suite-base/components/EmbeddedSceneBridge";

import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { createObstacle } from "./geometry";
import { type SceneEnvelope } from "./types";
import type { IRenderer } from "../IRenderer";

function envelope(): SceneEnvelope {
  return {
    epoch: "epoch",
    revision: 1,
    savedRevision: 1,
    dirty: false,
    playing: false,
    sceneTime: 0,
    consumers: [],
    document: {
      schema: "xgc2.scene.v1",
      id: "test",
      frame: "world",
      obstacles: [createObstacle("Arch", "arch-1")],
    },
  };
}

async function setup() {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, -5, 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
  const renderer = {
    gl: { domElement: canvas },
    settings: { setNodesForKey: jest.fn() },
    config: { scene: { obstacleScene: { namespace: "/xgc/scene" } } },
    queueAnimationFrame: jest.fn(function (this: unknown): void {
      // Real Renderer uses private fields, so an unbound Three.js callback fails in a browser.
      expect(this).toBe(renderer);
    }),
    cameraHandler: { getActiveCamera: () => camera, setInteractionEnabled: jest.fn() },
    addCoordinateFrame: jest.fn(),
  };
  jest
    .spyOn(embeddedSceneBridge, "getBinding")
    .mockReturnValue({ namespace: "/xgc/scene", editable: true });
  const command = jest
    .spyOn(embeddedSceneBridge, "command")
    .mockResolvedValue({ success: true, ...envelope() });
  const extension = new ObstacleSceneExtension(renderer as unknown as IRenderer);
  extension.session!.setLive({ live: true });
  await Promise.resolve();
  await Promise.resolve();
  extension.session!.setActive({ active: true });
  extension.session!.select({ obstacleId: "arch-1", partId: "lintel" });
  const controls = extension.children.find((child) => child instanceof TransformControls)!;
  return {
    extension,
    controls,
    command,
    renderer,
    canvas,
    dispose: () => {
      extension.dispose();
      canvas.remove();
    },
  };
}

describe("3D obstacle authoring", () => {
  it("renders typed compounds with stable part identity and registers the frame without an algorithm", async () => {
    const { extension, controls, renderer, dispose } = await setup();
    expect(renderer.addCoordinateFrame).toHaveBeenCalledWith("world");
    expect(controls.object?.name).toBe("lintel");
    expect(controls.object?.parent?.name).toBe("arch-1");
    expect(controls.object?.parent?.children).toHaveLength(3);
    expect(
      extension
        .getSubscriptions()
        .map((subscription) => (subscription.type === "topic" ? subscription.topicName : "")),
    ).toEqual(["/xgc/scene/document", "/xgc/scene/state"]);
    dispose();
  });

  it("previews locally, commits once on release, and leaves accepted geometry while awaiting the response", async () => {
    const { extension, controls, command, renderer, dispose } = await setup();
    command.mockClear();
    command.mockReturnValue(new Promise(() => {}));
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.position.x = 2;
    controls.dispatchEvent({ type: "objectChange" });
    controls.dispatchEvent({ type: "objectChange" });
    expect(
      extension.session!.getSnapshot().envelope!.document.obstacles[0]!.parts[2]!.pose.position[0],
    ).toBe(0);
    expect(command).not.toHaveBeenCalled();
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      "/xgc/scene",
      expect.objectContaining({
        operation: "update",
        obstacle: expect.objectContaining({
          id: "arch-1",
          parts: expect.arrayContaining([
            expect.objectContaining({
              id: "lintel",
              pose: expect.objectContaining({ position: [2, 0, 2.2] }),
            }),
          ]),
        }),
      }),
    );
    expect(renderer.cameraHandler.setInteractionEnabled).toHaveBeenLastCalledWith({
      enabled: true,
    });
    expect(extension.children[0]!.children[0]!.children[2]!.position.x).toBe(0);
    dispose();
  });

  it("Escape cancels a preview without a write and restores the initial pose", async () => {
    const { controls, command, canvas, dispose } = await setup();
    command.mockClear();
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.position.x = 4;
    controls.dispatchEvent({ type: "objectChange" });
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).not.toHaveBeenCalled();
    expect(controls.object?.position.x).toBe(0);
    dispose();
  });

  it("a new accepted snapshot cancels an in-progress drag rather than overwriting it", async () => {
    const { extension, controls, command, dispose } = await setup();
    command.mockClear();
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.position.x = 4;
    controls.dispatchEvent({ type: "objectChange" });
    const next = envelope();
    next.revision = 2;
    next.document.obstacles[0]!.parts[2]!.pose.position[0] = 7;
    extension.session!.accept(next);
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).not.toHaveBeenCalled();
    expect(controls.object?.position.x).toBe(7);
    dispose();
  });

  it("keeps moving poses separate from initial definitions and ignores stale dynamic state", async () => {
    const { extension, controls, dispose } = await setup();
    const subscription = extension.getSubscriptions()[1]!.subscription;
    subscription.handler({
      message: {
        epoch: "epoch",
        revision: 1,
        obstacles: [
          {
            id: "arch-1",
            pose: { position: { x: 3, y: 2, z: 1 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          },
        ],
      },
    } as never);
    expect(controls.object?.parent?.position.toArray()).toEqual([3, 2, 1]);
    expect(extension.session!.getSnapshot().envelope!.document.obstacles[0]!.pose.position).toEqual(
      [0, 0, 0],
    );
    subscription.handler({
      message: {
        epoch: "old",
        revision: 1,
        obstacles: [
          {
            id: "arch-1",
            pose: { position: { x: 90, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          },
        ],
      },
    } as never);
    expect(controls.object?.parent?.position.toArray()).toEqual([3, 2, 1]);
    dispose();
  });

  it("disables the gizmo when the view changes to a recording", async () => {
    const { extension, controls, command, dispose } = await setup();
    command.mockClear();
    extension.session!.setLive({ live: false });
    expect(controls.enabled).toBe(false);
    expect(controls.object).toBeUndefined();
    expect(command).not.toHaveBeenCalled();
    dispose();
  });
});
