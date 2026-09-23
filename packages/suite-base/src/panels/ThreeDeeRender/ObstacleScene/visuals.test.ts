/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { createGeometry } from "./geometry";
import type { ScenePose } from "./types";
import {
  convexFacePlanes,
  createObstacleEdges,
  createObstacleFill,
  createObstacleSolid,
  setObstacleVisualSelected,
  trimSharedFaces,
} from "./visuals";

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

  it("renders the 3D pane as a matte lit solid without edge or ground overlays", () => {
    const solid = createObstacleSolid([...AMBER, 1]);
    expect(solid).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(solid.color.toArray()).toEqual(AMBER);
    expect(solid.opacity).toBe(1);
    expect(solid.transparent).toBe(false);
    // Same-hue emissive floor keeps the amber vivid where scene lights fall off.
    expect(solid.emissive.toArray()).toEqual(AMBER.map((n) => n * 0.3));
    const draft = createObstacleSolid([...AMBER, 0.45]);
    expect(draft.opacity).toBe(0.45);
    expect(draft.transparent).toBe(true);
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

  it("toggles selection without a compiled GL program", () => {
    const mesh = new THREE.Mesh(
      createGeometry({ type: "box", size: [1, 1, 1] }),
      createObstacleFill([...AMBER, 1]),
    );
    const edges = createObstacleEdges(mesh.geometry, AMBER)!;
    mesh.userData.edges = edges;
    setObstacleVisualSelected(mesh, { selected: true });
    expect(mesh.material.userData.selected).toBe(true);
    expect(edges.material.opacity).toBe(1);
    setObstacleVisualSelected(mesh, { selected: false });
    expect(mesh.material.userData.selected).toBe(false);
    expect(edges.material.opacity).toBeCloseTo(0.9);
  });

  it("moves the 3D pane selection glow onto the lit material emissive", () => {
    const mesh = new THREE.Mesh(
      createGeometry({ type: "box", size: [1, 1, 1] }),
      createObstacleSolid([...AMBER, 1]),
    );
    const baseEmissive = mesh.material.emissive.toArray();
    setObstacleVisualSelected(mesh, { selected: true });
    expect(mesh.material.userData.selected).toBe(true);
    expect(mesh.material.emissive.toArray()).not.toEqual(baseEmissive);
    setObstacleVisualSelected(mesh, { selected: false });
    expect(mesh.material.emissive.toArray()).toEqual(baseEmissive);
  });
});
