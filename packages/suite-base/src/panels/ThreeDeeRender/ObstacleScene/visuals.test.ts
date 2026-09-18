/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { createGeometry } from "./geometry";
import {
  convexFacePlanes,
  convexHull2D,
  createObstacleEdges,
  createObstacleFill,
  createObstacleFootprint,
  setObstacleVisualSelected,
  trimSharedFaces,
} from "./visuals";
import type { ScenePose } from "./types";

const AMBER: [number, number, number] = [1, 0.5, 0.1];

function pose(position: [number, number, number], yaw = 0): ScenePose {
  return {
    position,
    orientation: [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)],
  };
}

describe("obstacle visuals", () => {
  it("tints the fill uniformly and keeps pane alpha semantics", () => {
    const opaque = createObstacleFill([...AMBER, 1]);
    expect(opaque).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(opaque.color.toArray()).toEqual(AMBER);
    expect(opaque.opacity).toBe(1);
    expect(opaque.transparent).toBe(false);
    const overlay = createObstacleFill([...AMBER, 0.4]);
    expect(overlay.opacity).toBe(0.4);
    expect(overlay.transparent).toBe(true);
    expect(overlay.customProgramCacheKey()).toBe("xgc2-obstacle-fill");
  });

  it("draws facet edges for boxes but not for smooth surfaces", () => {
    const boxEdges = createObstacleEdges(createGeometry({ type: "box", size: [1, 1, 1] }), AMBER);
    expect(boxEdges?.geometry.getAttribute("position").count).toBe(24);
    const sphereEdges = createObstacleEdges(createGeometry({ type: "sphere", radius: 1 }), AMBER);
    expect(sphereEdges).toBeUndefined();
  });

  it("suppresses seam edges fused with a sibling decomposition part", () => {
    // A tall column decomposed into two unit boxes: lower z∈[0,1], upper z∈[1,2].
    const lowerPlanes = convexFacePlanes(
      createGeometry({ type: "box", size: [1, 1, 1] }),
      pose([0, 0, 0.5]),
    );
    const inverse = new THREE.Matrix4()
      .compose(
        new THREE.Vector3(0, 0, 1.5),
        new THREE.Quaternion(0, 0, 0, 1),
        new THREE.Vector3(1, 1, 1),
      )
      .invert();
    const blockers = [lowerPlanes.map((plane) => plane.clone().applyMatrix4(inverse))];
    const edges = createObstacleEdges(
      createGeometry({ type: "box", size: [1, 1, 1] }),
      AMBER,
      blockers,
    )!;
    // Top loop (4 segments) and verticals (4) stay; the shared bottom loop is gone.
    expect(edges.geometry.getAttribute("position").count).toBe(16);
    // The shared bottom face (2 triangles) is trimmed off the fill as well.
    const trimmed = trimSharedFaces(createGeometry({ type: "box", size: [1, 1, 1] }), blockers);
    expect(trimmed.getAttribute("position").count).toBe(30);
    // No siblings -> geometry passes through untouched (smooth normals survive).
    const plain = createGeometry({ type: "sphere", radius: 1 });
    expect(trimSharedFaces(plain, [])).toBe(plain);
  });

  it("projects a rotated box to a rectangle footprint at floor level", () => {
    const footprint = createObstacleFootprint(
      createGeometry({ type: "box", size: [2, 1, 1] }),
      pose([3, 4, 0.5], Math.PI / 2),
      AMBER,
    );
    expect(footprint).toBeDefined();
    expect(footprint!.userData.footprint).toBe(true);
    expect(footprint!.position.z).toBeLessThan(0.05);
    const outline = footprint!.children.find((child) => child instanceof THREE.LineLoop)!;
    const xs = [...(outline.geometry.getAttribute("position").array as Float32Array)];
    const xy: [number, number][] = [];
    for (let i = 0; i < xs.length; i += 3) {
      xy.push([xs[i]!, xs[i + 1]!]);
    }
    // Rotated 90°: the 2 m side lies along obstacle Y, the 1 m side along X.
    expect(Math.max(...xy.map(([x]) => x))).toBeCloseTo(3.5);
    expect(Math.min(...xy.map(([x]) => x))).toBeCloseTo(2.5);
    expect(Math.max(...xy.map(([, y]) => y))).toBeCloseTo(5);
    expect(Math.min(...xy.map(([, y]) => y))).toBeCloseTo(3);
    expect(xy).toHaveLength(4);
  });

  it("hulls a sphere projection to a disc-sized polygon", () => {
    const hull = convexHull2D([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.5, 0.5],
      [0.2, 0.8],
    ]);
    expect(hull).toHaveLength(4);
    expect(hull).toEqual(
      expect.arrayContaining([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]),
    );
  });

  it("toggles selection without a compiled GL program", () => {
    const mesh = new THREE.Mesh(
      createGeometry({ type: "box", size: [1, 1, 1] }),
      createObstacleFill([...AMBER, 1]),
    );
    const edges = createObstacleEdges(mesh.geometry, AMBER)!;
    mesh.userData.edges = edges;
    setObstacleVisualSelected(mesh, true);
    expect(mesh.material.userData.selected).toBe(true);
    expect(edges.material.opacity).toBe(1);
    setObstacleVisualSelected(mesh, false);
    expect(mesh.material.userData.selected).toBe(false);
    expect(edges.material.opacity).toBeCloseTo(0.9);
  });
});
