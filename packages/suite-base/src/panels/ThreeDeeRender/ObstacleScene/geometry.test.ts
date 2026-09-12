// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import {
  createGeometry,
  createObstacle,
  createPlacementObstacle,
  DEFAULT_ADD_POSITION,
  obstacleLowestWorldZ,
  scaleGeometry,
  SCENE_DRAFT_ID,
  SCENE_PRESETS,
  snapObstacleToGround,
} from "./geometry";
import { withObstaclePose } from "./motion";
import {
  geometryValid,
  initialPose,
  OBSTACLE_VISUAL_COLOR,
  parseSceneEnvelope,
  sceneNamespace,
  type SceneEnvelope,
  type SceneGeometry,
} from "./types";

function fixture(): SceneEnvelope {
  return {
    epoch: "epoch-1",
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
      obstacles: [createObstacle("Box", "box-1")],
    },
  };
}

describe("rich scene geometry", () => {
  it("uses the runtime namespace grammar and bound", () => {
    expect(sceneNamespace("/_lab/scene_1")).toBe("/_lab/scene_1");
    expect(sceneNamespace("/" + "a".repeat(160))).toBeUndefined();
    expect(sceneNamespace("/lab//scene")).toBeUndefined();
  });
  it.each(
    SCENE_PRESETS.map((preset) => [preset] as const),
  )("round trips and renders %s without primitive substitution", (preset) => {
    const obstacle = createObstacle(preset, "stable-id");
    const envelope = fixture();
    envelope.document.obstacles = [obstacle];
    expect(parseSceneEnvelope(JSON.parse(JSON.stringify(envelope)!)).document.obstacles).toEqual([
      obstacle,
    ]);
    for (const part of obstacle.parts) {
      expect(geometryValid(part.geometry)).toBe(true);
      const geometry = createGeometry(part.geometry);
      geometry.computeBoundingBox();
      expect(geometry.boundingBox?.isEmpty()).toBe(false);
      geometry.dispose();
    }
  });

  it("paints authored gray as the product amber", () => {
    const envelope = fixture();
    envelope.document.obstacles[0]!.parts[0]!.color = [0.5, 0.5, 0.5, 1];
    expect(
      parseSceneEnvelope(JSON.parse(JSON.stringify(envelope))).document.obstacles[0]!.parts[0]!
        .color,
    ).toEqual(OBSTACLE_VISUAL_COLOR);
  });

  it("preserves an arch opening as three separate collision parts", () => {
    const arch = createObstacle("Arch", "door");
    const query = new THREE.Vector3(0, 0, 1);
    expect(arch.parts).toHaveLength(3);
    for (const part of arch.parts) {
      const geometry = createGeometry(part.geometry);
      geometry.computeBoundingBox();
      expect(
        geometry
          .boundingBox!.translate(new THREE.Vector3(...part.pose.position))
          .containsPoint(query),
      ).toBe(false);
      geometry.dispose();
    }
  });

  it("uses full Z cylinder height and capsule cylinder section height", () => {
    const cylinder = createGeometry({ type: "cylinder", radius: 0.4, height: 2 });
    const capsule = createGeometry({ type: "capsule", radius: 0.4, height: 2 });
    cylinder.computeBoundingBox();
    capsule.computeBoundingBox();
    expect(cylinder.boundingBox!.getSize(new THREE.Vector3()).z).toBeCloseTo(2);
    expect(capsule.boundingBox!.getSize(new THREE.Vector3()).z).toBeCloseTo(2.8);
    cylinder.dispose();
    capsule.dispose();
  });

  it("preserves all convex vertices and faces with nonuniform author scaling", () => {
    const shape = createObstacle("Icosahedron", "ico").parts[0]!.geometry as Extract<
      SceneGeometry,
      { type: "convex" }
    >;
    expect(shape.vertices).toHaveLength(12);
    expect(shape.triangles).toHaveLength(60);
    const scaled = scaleGeometry(shape, [1, 2, 3]) as typeof shape;
    expect(scaled.triangles).toEqual(shape.triangles);
    expect(scaled.vertices[0]).toEqual([shape.vertices[0]![0], shape.vertices[0]![1] * 2, 0]);
  });

  it("rejects collapsed or silently changed primitive geometry", () => {
    expect(() => scaleGeometry({ type: "sphere", radius: 1 }, [1, 2, 1])).toThrow("uniform");
    expect(() => scaleGeometry({ type: "capsule", radius: 1, height: 2 }, [1, 1, 2])).toThrow(
      "uniform",
    );
    expect(geometryValid({ type: "box", size: [1, 0, 1] })).toBe(false);
    expect(geometryValid({ type: "cone", radius: 1, height: 2 })).toBe(false);
    const envelope = fixture();
    envelope.document.obstacles[0]!.parts[0]!.geometry = { type: "cone" } as never;
    expect(() => parseSceneEnvelope(envelope)).toThrow("Unsupported");
  });

  it("does not accept duplicate obstacle or part identities", () => {
    const envelope = fixture();
    envelope.document.obstacles.push(envelope.document.obstacles[0]!);
    expect(() => parseSceneEnvelope(envelope)).toThrow("identity");
  });

  it("places new authoring drafts outside the 10 m origin box", () => {
    const placement = createPlacementObstacle("Box");
    expect(placement.id).toBe(SCENE_DRAFT_ID);
    expect(placement.pose.position).toEqual(DEFAULT_ADD_POSITION);
    expect(DEFAULT_ADD_POSITION[0]).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_ADD_POSITION[1]).toBeGreaterThanOrEqual(10);
  });

  it("snaps a lifted compound onto the world ground without changing part offsets", () => {
    const original = withObstaclePose(createObstacle("Arch", "door"), initialPose([4, -3, 2]));
    const snapped = snapObstacleToGround(original);
    expect(obstacleLowestWorldZ(snapped)).toBeCloseTo(0, 6);
    expect(snapped.pose.position[0]).toBe(4);
    expect(snapped.pose.position[1]).toBe(-3);
    expect(snapped.parts).toEqual(original.parts);
    expect(snapObstacleToGround(snapped).pose.position[2]).toBeCloseTo(snapped.pose.position[2], 6);
  });
});
