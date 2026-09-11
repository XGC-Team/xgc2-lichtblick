// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import {
  initialPose,
  OBSTACLE_VISUAL_COLOR,
  type SceneGeometry,
  type SceneObstacle,
  type ScenePart,
  type Vec3,
} from "./types";

export const SCENE_PRESETS = [
  "Box",
  "Sphere",
  "Cylinder",
  "Capsule",
  "Icosahedron",
  "Arch",
  "L block",
  "T block",
  "Stairs",
  "Dumbbell",
] as const;
export type ScenePreset = (typeof SCENE_PRESETS)[number];

export function createGeometry(shape: SceneGeometry): THREE.BufferGeometry {
  switch (shape.type) {
    case "box":
      return new THREE.BoxGeometry(...shape.size);
    case "sphere":
      return new THREE.SphereGeometry(shape.radius, 32, 24);
    case "cylinder":
      return new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 32).rotateX(
        Math.PI / 2,
      );
    case "capsule":
      return new THREE.CapsuleGeometry(shape.radius, shape.height, 12, 24).rotateX(Math.PI / 2);
    case "convex": {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(shape.vertices.flat(), 3));
      geometry.setIndex(shape.triangles);
      geometry.computeVertexNormals();
      return geometry;
    }
  }
}

function part(id: string, geometry: SceneGeometry, position?: Vec3): ScenePart {
  return { id, geometry, pose: initialPose(position), color: [...OBSTACLE_VISUAL_COLOR] };
}

function box(id: string, size: Vec3, position: Vec3): ScenePart {
  return part(id, { type: "box", size }, position);
}

function icosahedron(): SceneGeometry {
  const t = (1 + Math.sqrt(5)) / 2;
  const scale = 0.65 / Math.hypot(1, t);
  const vertices: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  return {
    type: "convex",
    vertices: vertices.map((v) => v.map((n) => n * scale) as Vec3),
    triangles: [
      0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
      8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ],
  };
}

/** Presets are authoring conveniences over one compound schema, never a shape-name protocol. */
export function createObstacle(preset: ScenePreset, id: string): SceneObstacle {
  let parts: ScenePart[];
  switch (preset) {
    case "Box":
      parts = [box("body", [1, 1, 1], [0, 0, 0.5])];
      break;
    case "Sphere":
      parts = [part("body", { type: "sphere", radius: 0.5 }, [0, 0, 0.5])];
      break;
    case "Cylinder":
      parts = [part("body", { type: "cylinder", radius: 0.4, height: 1 }, [0, 0, 0.5])];
      break;
    case "Capsule":
      parts = [part("body", { type: "capsule", radius: 0.3, height: 1 }, [0, 0, 0.8])];
      break;
    case "Icosahedron":
      parts = [part("body", icosahedron(), [0, 0, 0.65])];
      break;
    case "Arch":
      parts = [
        box("left", [0.4, 0.6, 2], [-1, 0, 1]),
        box("right", [0.4, 0.6, 2], [1, 0, 1]),
        box("lintel", [2.4, 0.6, 0.4], [0, 0, 2.2]),
      ];
      break;
    case "L block":
      parts = [
        box("leg", [0.5, 1.5, 1], [-0.5, 0, 0.5]),
        box("foot", [1.5, 0.5, 1], [0, -0.5, 0.5]),
      ];
      break;
    case "T block":
      parts = [box("stem", [0.5, 1.5, 1], [0, 0, 0.5]), box("bar", [1.5, 0.5, 1], [0, 0.5, 0.5])];
      break;
    case "Stairs":
      parts = [
        box("step-1", [0.6, 1, 0.3], [-0.6, 0, 0.15]),
        box("step-2", [0.6, 1, 0.6], [0, 0, 0.3]),
        box("step-3", [0.6, 1, 0.9], [0.6, 0, 0.45]),
      ];
      break;
    case "Dumbbell": {
      const bar = part("bar", { type: "cylinder", radius: 0.15, height: 1.5 }, [0, 0, 0.45]);
      bar.pose.orientation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
      parts = [
        part("left", { type: "sphere", radius: 0.45 }, [-0.75, 0, 0.45]),
        part("right", { type: "sphere", radius: 0.45 }, [0.75, 0, 0.45]),
        bar,
      ];
    }
  }
  return { id, name: preset, pose: initialPose(), parts, motion: { type: "hold" } };
}

/** Scaling is baked into author dimensions, and must never turn a sphere into an unnamed ellipsoid. */
export function scaleGeometry(shape: SceneGeometry, scale: Vec3): SceneGeometry {
  if (scale.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(
      "Dimensions must be positive. Mirroring or collapsing an obstacle is not supported.",
    );
  }
  const [x, y, z] = scale;
  switch (shape.type) {
    case "box":
      return { type: "box", size: shape.size.map((n, i) => n * scale[i]!) as Vec3 };
    case "convex":
      return {
        ...shape,
        vertices: shape.vertices.map((v) => v.map((n, i) => n * scale[i]!) as Vec3),
      };
    case "sphere":
      if (Math.abs(x - y) > 1e-5 || Math.abs(x - z) > 1e-5) {
        throw new Error("A sphere needs uniform scaling. Edit its radius instead.");
      }
      return { ...shape, radius: shape.radius * x };
    case "cylinder":
      if (Math.abs(x - y) > 1e-5) {
        throw new Error("A cylinder needs equal X/Y scaling. Edit radius and height instead.");
      }
      return { ...shape, radius: shape.radius * x, height: shape.height * z };
    case "capsule":
      if (Math.abs(x - y) > 1e-5 || Math.abs(x - z) > 1e-5) {
        throw new Error(
          "A capsule needs uniform scaling. Edit radius and cylinder height instead.",
        );
      }
      return { ...shape, radius: shape.radius * x, height: shape.height * z };
  }
}
