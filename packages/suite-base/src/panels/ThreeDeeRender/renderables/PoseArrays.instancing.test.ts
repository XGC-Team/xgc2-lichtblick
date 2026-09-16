// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { PoseArrays, LayerSettingsPoseArray } from "./PoseArrays";
import type { IRenderer, RendererConfig } from "../IRenderer";
import { onlyLastByTopicMessage } from "../SceneExtension";
import { SharedGeometry } from "../SharedGeometry";
import { DetailLevel } from "../lod";
import type { Pose } from "../transforms";
import { RenderableLineStrip } from "./markers/RenderableLineStrip";

const TOPIC = "/prediction";
const HEADER = { frame_id: "world", stamp: { sec: 12, nsec: 34 } };
const POSES: Pose[] = [
  { position: { x: 1, y: 2, z: 3 }, orientation: { x: 0, y: 0, z: 0.6, w: 0.8 } },
  { position: { x: 2, y: 3, z: 4 }, orientation: { x: 0.6, y: 0, z: 0, w: 0.8 } },
];

describe("PoseArrays instanced representations", () => {
  let extension: PoseArrays;
  let sharedGeometry: SharedGeometry;

  function send(schemaName: string, message: unknown): void {
    const sub = extension
      .getSubscriptions()
      .find((entry) => entry.type === "schema" && entry.schemaNames.has(schemaName));
    if (sub == undefined) {
      throw new Error(`Missing subscription for ${schemaName}`);
    }
    expect(sub.subscription.filterQueue).toBe(onlyLastByTopicMessage);
    sub.subscription.handler({
      topic: TOPIC,
      schemaName,
      receiveTime: { sec: 13, nsec: 45 },
      sizeInBytes: 0,
      message,
    });
  }

  function sendPoses(poses = POSES): void {
    send("geometry_msgs/PoseArray", { header: HEADER, poses });
  }

  function setType(type: LayerSettingsPoseArray["type"]): void {
    extension.handleSettingsAction({
      action: "update",
      payload: { path: ["topics", TOPIC, "type"], input: "select", value: type },
    });
  }

  beforeEach(() => {
    sharedGeometry = new SharedGeometry();
    const config = {
      topics: { [TOPIC]: { visible: true, type: "axis" } },
      layers: {},
    } as unknown as RendererConfig;
    const renderer = {
      config,
      input: { canvasSize: new THREE.Vector2(640, 480) },
      maxLod: DetailLevel.High,
      sharedGeometry,
      topics: [],
      settings: { setNodesForKey: jest.fn(), errors: { addToTopic: jest.fn() } },
      updateConfig: (update: (draft: RendererConfig) => void) => {
        update(config);
      },
      normalizeFrameId: (id: string) => id.replace(/^\//, ""),
    } as unknown as IRenderer;
    extension = new PoseArrays(renderer);
  });

  afterEach(() => {
    extension.dispose();
    sharedGeometry.dispose();
    jest.restoreAllMocks();
  });

  it.each<[string, unknown]>([
    ["geometry_msgs/PoseArray", { header: HEADER, poses: POSES }],
    ["nav_msgs/Path", { header: HEADER, poses: POSES.map((pose) => ({ header: HEADER, pose })) }],
    ["foxglove.PosesInFrame", { timestamp: HEADER.stamp, frame_id: "world", poses: POSES }],
  ])("preserves message metadata and all authored poses for %s", (schema, message) => {
    send(schema, message);
    const renderable = extension.renderables.get(TOPIC)!;
    expect(renderable.userData.poseArrayMessage.poses).toEqual(POSES);
    expect(renderable.userData.frameId).toBe("world");
    expect(renderable.userData.messageTime).toBe(12000000034n);
    expect(renderable.userData.receiveTime).toBe(13000000045n);
    expect(renderable.details()).toBe(message);
    expect(renderable.pickable).toBe(true);
    expect(renderable.pickableInstances).toBe(false);
    expect(renderable.userData.axes!.children).toHaveLength(2);
    for (const child of renderable.userData.axes!.children) {
      expect((child as THREE.InstancedMesh).count).toBe(POSES.length * 3);
    }
  });

  it("does not create axis resources for an initially empty message", () => {
    sendPoses([]);
    expect(extension.renderables.get(TOPIC)!.userData.axes).toBeUndefined();
    sendPoses();
    const axes = extension.renderables.get(TOPIC)!.userData.axes!;
    sendPoses([]);
    expect(axes.visible).toBe(false);
    sendPoses();
    expect(extension.renderables.get(TOPIC)!.userData.axes).toBe(axes);
    expect(axes.visible).toBe(true);
  });

  it("keeps axes on style updates and retires only inactive representations", () => {
    sendPoses();
    const renderable = extension.renderables.get(TOPIC)!;
    const axes = renderable.userData.axes!;
    const dispose = jest.spyOn(axes, "dispose");
    extension.handleSettingsAction({
      action: "update",
      payload: { path: ["topics", TOPIC, "axisScale"], input: "number", value: 0.3 },
    });
    expect(renderable.userData.axes).toBe(axes);
    expect(dispose).not.toHaveBeenCalled();
    setType("line-axes");
    expect(renderable.userData.axes).toBe(axes);
    expect(renderable.userData.lineStrip).toBeDefined();
    setType("line");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(renderable.userData.axes).toBeUndefined();
    setType("arrow");
    expect(renderable.userData.lineStrip).toBeUndefined();
    expect(renderable.userData.arrows).toHaveLength(POSES.length);
    setType("axis");
    expect(renderable.userData.arrows).toHaveLength(0);
    expect(renderable.userData.axes).toBeDefined();
  });

  it("constructs a line once instead of submitting its first update twice", () => {
    const update = jest.spyOn(RenderableLineStrip.prototype, "update");
    setType("line-axes");
    sendPoses();
    expect(update).toHaveBeenCalledTimes(1);
    sendPoses();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("gives singleton arrows and lines a finite start-gradient color", () => {
    setType("arrow");
    sendPoses([POSES[0]!]);
    const renderable = extension.renderables.get(TOPIC)!;
    const color = renderable.userData.arrows[0]!.userData.marker.color;
    expect(color.a).toBe(1);
    for (const component of Object.values(color)) {
      expect(Number.isFinite(component)).toBe(true);
    }
    setType("line");
    const lineColor = renderable.userData.lineStrip!.userData.marker.colors[0]!;
    expect(lineColor).toEqual(color);
  });

  it("inherits selection layers when a new representation is created", () => {
    sendPoses();
    const renderable = extension.renderables.get(TOPIC)!;
    renderable.traverse((object) => {
      object.layers.set(1);
    });
    setType("line");
    renderable.userData.lineStrip!.traverse((object) => {
      expect(object.layers.mask).toBe(2);
    });
    setType("line-axes");
    renderable.userData.axes!.traverse((object) => {
      expect(object.layers.mask).toBe(2);
    });
  });

  it("processes successive messages without trimming poses or synthesizing orientations", () => {
    sendPoses();
    const renderable = extension.renderables.get(TOPIC)!;
    const before = renderable.userData.axes;
    for (let i = 0; i < 100; i++) {
      sendPoses(POSES.map((p) => ({ ...p, position: { ...p.position, x: p.position.x + i } })));
      expect(renderable.userData.axes).toBe(before);
      expect(renderable.userData.poseArrayMessage.poses).toHaveLength(POSES.length);
      expect(renderable.userData.poseArrayMessage.poses[0]!.orientation).toEqual(
        POSES[0]!.orientation,
      );
    }
  });
});
