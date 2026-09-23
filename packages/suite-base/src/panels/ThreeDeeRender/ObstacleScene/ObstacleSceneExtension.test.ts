/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import {
  TransformControls,
  type TransformControlsGizmo,
} from "three/examples/jsm/controls/TransformControls.js";

import { embeddedSceneBridge } from "@lichtblick/suite-base/components/EmbeddedSceneBridge";

import { ObstacleSceneExtension } from "./ObstacleSceneExtension";
import { createObstacle, type ScenePreset } from "./geometry";
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

async function setup(options: { preset?: ScenePreset; whole?: boolean } = {}) {
  const initial = envelope();
  initial.document.obstacles = [createObstacle(options.preset ?? "Arch", "arch-1")];
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
    .mockResolvedValue({ success: true, ...initial });
  const extension = new ObstacleSceneExtension(renderer as unknown as IRenderer);
  extension.session!.setLive({ live: true });
  extension.session!.accept(initial);
  await Promise.resolve();
  await Promise.resolve();
  extension.session!.setActive({ active: true });
  extension.session!.select({
    obstacleId: "arch-1",
    ...(options.whole === true ? {} : { partId: "lintel" }),
  });
  const controls = extension.children.find((child) => child instanceof TransformControls)!;
  return {
    extension,
    controls,
    command,
    renderer,
    canvas,
    initial,
    dispose: () => {
      extension.dispose();
      canvas.remove();
    },
  };
}

describe("3D obstacle authoring", () => {
  it.each(["Sphere", "Capsule", "Arch"] as const)(
    "keeps a %s centre-handle drag finite and reversible even when native scaling divides by zero",
    async (preset) => {
      const { extension, controls, canvas, command, dispose } = await setup({ preset, whole: true });
      extension.setMode("scale");
      controls.axis = "XYZ";
      canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 100 }));
      controls.dispatchEvent({ type: "mouseDown" });
      for (const [x, y, expected] of [[132, 100, Math.exp(0.2)], [100, 132, Math.exp(-0.2)], [100, 100, 1]]) {
        canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
        controls.object!.scale.setScalar(Infinity);
        controls.dispatchEvent({ type: "objectChange" });
        expect(controls.object!.scale.toArray()).toEqual([expected, expected, expected]);
        expect(extension.getTransformSnapshot().scaleFactor).toBeCloseTo(expected!);
      }
      expect(command).not.toHaveBeenCalled();
      extension.cancelPreview();
      controls.dispatchEvent({ type: "mouseUp" });
      expect(command).not.toHaveBeenCalled();
      expect(controls.object!.scale.toArray()).toEqual([1, 1, 1]);
      dispose();
    },
  );

  it.each([
    "Sphere",
    "Capsule",
    "Arch",
  ] as const)("refuses a nonuniform %s scale instead of committing a different shape", async (preset) => {
    const { extension, controls, command, initial, dispose } = await setup({ preset, whole: true });
    extension.setMode("scale");
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.scale.set(2, 3, 2);
    controls.dispatchEvent({ type: "objectChange" });
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).not.toHaveBeenCalled();
    expect(extension.session!.getSnapshot().envelope).toEqual(initial);
    expect(extension.getTransformSnapshot().preview).toBeUndefined();
    expect(controls.object!.scale.toArray()).toEqual([1, 1, 1]);
    expect(extension.session!.getSnapshot().error).toBeDefined();
    dispose();
  });

  it("restores accepted geometry and clears the numeric preview when a scale update is rejected", async () => {
    const { extension, controls, command, initial, dispose } = await setup({ whole: true });
    command.mockResolvedValue({ ...initial, success: false, error: "Consumer rejected this edit" });
    extension.setMode("scale");
    const target = controls.object!;
    controls.dispatchEvent({ type: "mouseDown" });
    target.scale.setScalar(2);
    controls.dispatchEvent({ type: "objectChange" });
    controls.dispatchEvent({ type: "mouseUp" });
    await Promise.resolve();
    await Promise.resolve();
    expect(command).toHaveBeenCalledTimes(1);
    expect(extension.session!.getSnapshot().envelope!.document).toEqual(initial.document);
    expect(extension.session!.getSnapshot().needsRefresh).toBe(true);
    expect(extension.getTransformSnapshot().preview).toBeUndefined();
    expect(target.scale.toArray()).toEqual([1, 1, 1]);
    dispose();
  });

  it.each([
    ["Box", ["X", "XY", "XYZ", "XZ", "Y", "YZ", "Z"]],
    ["Icosahedron", ["X", "XY", "XYZ", "XZ", "Y", "YZ", "Z"]],
    ["Sphere", ["XYZ"]],
    ["Capsule", ["XYZ"]],
    ["Cylinder", ["X", "XYZ", "Y", "Z"]],
    ["Arch", ["XYZ"]],
  ] as const)("ordinary %s selection exposes only representable scale handles", async (preset, handles) => {
    const { extension, controls, dispose } = await setup({ preset, whole: true });
    expect(extension.canScale()).toBe(true);
    extension.setMode("scale");
    expect(controls.mode).toBe("scale");
    expect(controls.object?.name).toBe(preset === "Arch" ? "arch-1" : "body");
    const gizmo = controls.children.find(
      (child) => child.type === "TransformControlsGizmo",
    ) as TransformControlsGizmo;
    for (const group of [gizmo.gizmo.scale, gizmo.picker.scale]) {
      expect([...new Set(group.children.map((child) => child.name))].sort()).toEqual(handles);
    }
    dispose();
  });

  it("bakes an entire compound into one acknowledged update while retaining its pending preview", async () => {
    const { extension, controls, command, initial, dispose } = await setup({ whole: true });
    let accept!: (value: { success: boolean } & SceneEnvelope) => void;
    command.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          accept = resolve;
        }),
    );
    extension.setMode("scale");
    const target = controls.object!;
    controls.dispatchEvent({ type: "mouseDown" });
    target.scale.setScalar(2);
    controls.dispatchEvent({ type: "objectChange" });
    const candidate = extension.getTransformSnapshot().preview!;
    expect(candidate.parts[0]!.pose.position).toEqual([-2, 0, 2]);
    expect(candidate.parts[0]!.geometry).toEqual({ type: "box", size: [0.8, 1.2, 4] });
    expect(extension.session!.getSnapshot().envelope).toEqual(initial);
    expect(command).not.toHaveBeenCalled();
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith(
      "/xgc/scene",
      expect.objectContaining({
        operation: "update",
        obstacle: candidate,
        expectedEpoch: "epoch",
        expectedRevision: 1,
      }),
    );
    expect(target.scale.toArray()).toEqual([2, 2, 2]);
    expect(extension.getTransformSnapshot().preview).toEqual(candidate);
    accept({
      ...initial,
      success: true,
      revision: 2,
      savedRevision: 2,
      document: { ...initial.document, obstacles: [candidate] },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(extension.session!.getSnapshot().envelope!.document.obstacles[0]).toEqual(candidate);
    expect(extension.getTransformSnapshot().preview).toBeUndefined();
    expect(controls.object?.scale.toArray()).toEqual([1, 1, 1]);
    dispose();
  });

  it.each([
    "X",
    "Y",
    "Z",
  ] as const)("keeps a cylinder circular when dragging its %s handle", async (axis) => {
    const { extension, controls, command, dispose } = await setup({
      preset: "Cylinder",
      whole: true,
    });
    extension.setMode("scale");
    controls.axis = axis;
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.scale.set(axis === "X" ? 2 : 1, axis === "Y" ? 2 : 1, axis === "Z" ? 3 : 1);
    controls.dispatchEvent({ type: "objectChange" });
    const shape = extension.getTransformSnapshot().preview!.parts[0]!.geometry;
    expect(shape).toEqual({
      type: "cylinder",
      radius: axis === "Z" ? 0.4 : 0.8,
      height: axis === "Z" ? 3 : 1,
    });
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        obstacle: expect.objectContaining({
          pose: expect.objectContaining({ position: [0, 0, 0] }),
          parts: [
            expect.objectContaining({
              geometry: shape,
              pose: expect.objectContaining({ position: [0, 0, 0.5] }),
            }),
          ],
        }),
      }),
    );
    dispose();
  });

  it("retains local axes across mode changes and reports automatic mode changes to the editor", async () => {
    const { extension, controls, dispose } = await setup({ whole: true });
    extension.setLocalSpace({ local: true });
    extension.setMode("rotate");
    expect(controls.space).toBe("local");
    extension.setMode("scale");
    extension.setMode("translate");
    expect(controls.space).toBe("local");
    extension.setMode("scale");
    extension.session!.select(undefined);
    expect(extension.getTransformSnapshot().mode).toBe("translate");
    expect(extension.getTransformSnapshot().local).toBe(true);
    dispose();
  });

  it.each([
    "cancel",
    "new revision",
    "change selection",
  ] as const)("drops a scale preview on %s without submitting", async (reason) => {
    const { extension, controls, command, initial, dispose } = await setup({ whole: true });
    extension.setMode("scale");
    controls.dispatchEvent({ type: "mouseDown" });
    controls.object!.scale.setScalar(2);
    controls.dispatchEvent({ type: "objectChange" });
    if (reason === "cancel") {
      extension.cancelPreview();
    } else if (reason === "new revision") {
      extension.session!.accept({ ...initial, revision: 2 });
    } else {
      extension.session!.select({ obstacleId: "arch-1", partId: "lintel" });
    }
    controls.dispatchEvent({ type: "mouseUp" });
    expect(command).not.toHaveBeenCalled();
    expect(extension.getTransformSnapshot().preview).toBeUndefined();
    expect(extension.getTransformSnapshot().dragging).toBe(false);
    dispose();
  });

  it("renders typed compounds with stable part identity and registers the frame without an algorithm", async () => {
    const { extension, controls, renderer, dispose } = await setup();
    expect(renderer.addCoordinateFrame).toHaveBeenCalledWith("world");
    expect(controls.object?.name).toBe("lintel");
    expect(controls.object?.parent?.name).toBe("arch-1");
    expect(
      controls.object?.parent?.children.filter((child) => child instanceof THREE.Mesh),
    ).toHaveLength(3);
    expect(
      extension
        .getSubscriptions()
        .map((subscription) => (subscription.type === "topic" ? subscription.topicName : "")),
    ).toEqual(["/xgc/scene/document", "/xgc/scene/state"]);
    dispose();
  });

  it("renders the 3D pane as lit solids without edge or ground-projection overlays", async () => {
    const { controls, dispose } = await setup();
    const meshes = (controls.object?.parent?.children ?? []).filter(
      (child) => child instanceof THREE.Mesh,
    );
    expect(meshes).toHaveLength(3);
    for (const mesh of meshes) {
      expect((mesh as THREE.Mesh).material).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(mesh.children).toHaveLength(0);
      expect(mesh.userData.groundZ).toBeUndefined();
    }
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
    expect(extension.children[0]!.children[0]!.children[2]!.position.x).toBe(2);
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

describe("AR overlay color override", () => {
  async function setupOverlay(
    obstacleScene: { namespace: string; color?: unknown },
    mutate?: (doc: SceneEnvelope) => void,
  ) {
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
      config: { scene: { obstacleScene } },
      interfaceMode: "image",
      queueAnimationFrame: jest.fn(),
      cameraHandler: { getActiveCamera: () => camera, setInteractionEnabled: jest.fn() },
      addCoordinateFrame: jest.fn(),
    };
    jest
      .spyOn(embeddedSceneBridge, "getBinding")
      .mockReturnValue({ namespace: "/xgc/scene", editable: false });
    const extension = new ObstacleSceneExtension(renderer as unknown as IRenderer);
    const doc = envelope();
    mutate?.(doc);
    extension.session!.accept(doc);
    await Promise.resolve();
    await Promise.resolve();
    const mesh = extension.children[0]!.children[0]!.children[0]! as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    return {
      material: mesh.material,
      extension,
      dispose: () => {
        extension.dispose();
        canvas.remove();
      },
    };
  }

  it("renders the opaque product amber when the pane declares no override", async () => {
    const { material, dispose } = await setupOverlay({ namespace: "/xgc/scene" });
    expect(material.color.toArray()).toEqual([1, 0.5, 0.1]);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    dispose();
  });

  it("applies the translucent image-pane override to every part material", async () => {
    const { material, dispose } = await setupOverlay({
      namespace: "/xgc/scene",
      color: [1, 0.5, 0.1, 0.4],
    });
    expect(material.color.toArray()).toEqual([1, 0.5, 0.1]);
    expect(material.opacity).toBe(0.4);
    expect(material.transparent).toBe(true);
    dispose();
  });

  it("falls back to the document color when the override is malformed", async () => {
    for (const color of ["#ff801a66", [1, 0.5], [1, 0.5, 0.1, 2], [1, 0.5, 0.1, Number.NaN]]) {
      const { material, dispose } = await setupOverlay({ namespace: "/xgc/scene", color });
      expect(material.color.toArray()).toEqual([1, 0.5, 0.1]);
      expect(material.opacity).toBe(1);
      expect(material.transparent).toBe(false);
      dispose();
    }
  });
});
