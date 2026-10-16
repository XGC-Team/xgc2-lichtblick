// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { ConvexHull } from "three/examples/jsm/math/ConvexHull.js";

import { withObstaclePose } from "./motion";
import { createRingGeometry } from "./ringGeometry";
import {
  initialPose,
  OBSTACLE_VISUAL_COLOR,
  type SceneGeometry,
  isInlineObstacle,
  type SceneInlineObstacle,
  type SceneObstacle,
  type ScenePart,
  type ScenePose,
  type Vec3,
} from "./types";

export const SCENE_PRESETS = [
  "Box",
  "Sphere",
  "Cylinder",
  "Capsule",
  "Ring",
  "Icosahedron",
  "Arch",
  "L block",
  "T block",
  "Stairs",
  "Dumbbell",
] as const;
export type ScenePreset = (typeof SCENE_PRESETS)[number];

/** Local-only authoring ghost. Never send this identity in an add command. */
export const SCENE_DRAFT_ID = "__xgc_scene_draft__";
/** Default add XY is outside the 10 m × 10 m origin box used by robot spawn. */
export const DEFAULT_ADD_POSITION: Vec3 = [12, 12, 0];

/** Only convex solids may hide sibling faces. Explicit meshes may contain holes. */
export function geometryIsConvex(shape: SceneGeometry): boolean {
  return shape.type !== "ring" && shape.type !== "mesh";
}

function spansVolume(points: THREE.Vector3[]): boolean {
  const origin = points[0];
  if (!origin) {
    return false;
  }
  const extent = new THREE.Box3().setFromPoints(points).getSize(new THREE.Vector3()).length();
  const tolerance = Math.max(extent, Number.MIN_VALUE) * 1e-10;
  const line = points
    .find((p) => p.distanceTo(origin) > tolerance)
    ?.clone()
    .sub(origin);
  if (!line) {
    return false;
  }
  const normal = points
    .map((p) => new THREE.Vector3().subVectors(p, origin).cross(line))
    .find((n) => n.length() > tolerance * line.length());
  return (
    normal != undefined &&
    points.some(
      (p) =>
        Math.abs(new THREE.Vector3().subVectors(p, origin).dot(normal)) >
        tolerance * normal.length(),
    )
  );
}

/** Display-only finite H intersection, computed on definition edits, never a query authority. */
function halfspaceVertices(rows: [number, number, number, number][]): THREE.Vector3[] {
  if (rows.length > 128) {
    throw new Error("Halfspace display supports at most 128 planes.");
  }
  const planes = rows.map(([x, y, z, d]) => {
    const normal = new THREE.Vector3(x, y, z);
    const length = Math.hypot(x, y, z);
    return { normal: normal.divideScalar(length), d: d / length };
  });
  const normals = planes.map((p) => p.normal);
  // No recession direction exists iff the normals positively span R3.
  if (
    !spansVolume(normals) ||
    new ConvexHull().setFromPoints(normals).faces.some((f) => f.constant <= 1e-10)
  ) {
    throw new Error("Halfspace display requires a bounded solid.");
  }
  const tolerance = 1e-8 * Math.max(1, ...planes.map((p) => Math.abs(p.d)));
  const vertices: THREE.Vector3[] = [];
  for (let i = 0; i < planes.length; ++i) {
    for (let j = i + 1; j < planes.length; ++j) {
      for (let k = j + 1; k < planes.length; ++k) {
        const a = planes[i]!,
          b = planes[j]!,
          c = planes[k]!;
        const bc = new THREE.Vector3().crossVectors(b.normal, c.normal);
        const determinant = a.normal.dot(bc);
        if (Math.abs(determinant) <= 1e-10) {
          continue;
        }
        const point = bc
          .multiplyScalar(-a.d)
          .addScaledVector(new THREE.Vector3().crossVectors(c.normal, a.normal), -b.d)
          .addScaledVector(new THREE.Vector3().crossVectors(a.normal, b.normal), -c.d)
          .divideScalar(determinant);
        if (
          point.toArray().every(Number.isFinite) &&
          planes.every((p) => p.normal.dot(point) + p.d <= tolerance) &&
          !vertices.some((v) => v.distanceToSquared(point) <= tolerance * tolerance)
        ) {
          vertices.push(point);
        }
      }
    }
  }
  if (!spansVolume(vertices)) {
    throw new Error("Halfspace display requires a nonempty solid with volume.");
  }
  return vertices;
}

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
    case "ring":
      return createRingGeometry(shape.radii, shape.tubeRadius);
    case "ellipsoid":
      return new THREE.SphereGeometry(1, 32, 24).scale(...shape.semiaxes);
    case "halfspaces":
      return new ConvexGeometry(halfspaceVertices(shape.halfspaces));
    case "convex":
    case "mesh": {
      if (shape.type === "convex" && (shape.triangles?.length ?? 0) === 0) {
        const vertices = shape.vertices.map((v) => new THREE.Vector3(...v));
        if (!spansVolume(vertices)) {
          throw new Error("Convex display requires vertices spanning a volume.");
        }
        return new ConvexGeometry(vertices);
      }
      // Explicit mesh topology is retained, including disconnected components and holes.
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(shape.vertices.flat(), 3));
      geometry.setIndex(shape.triangles!);
      geometry.computeVertexNormals();
      return geometry;
    }
  }
}

function part(id: string, geometry: SceneGeometry, position?: Vec3): ScenePart {
  return {
    id,
    geometry,
    pose: initialPose(position),
    color: [...OBSTACLE_VISUAL_COLOR],
  };
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
export function createObstacle(preset: ScenePreset, id: string): SceneInlineObstacle {
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
    case "Ring":
      parts = [part("body", { type: "ring", radii: [1.2, 1], tubeRadius: 0.1 }, [0, 0, 0.1])];
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
  return {
    id,
    name: preset,
    pose: initialPose(),
    parts,
    motion: { type: "hold" },
  };
}

function applyObjectPose(object: THREE.Object3D, pose: ScenePose): void {
  object.position.fromArray(pose.position);
  object.quaternion.fromArray(pose.orientation);
  object.scale.set(1, 1, 1);
}

/** Lowest world Z of the compound obstacle, including part poses and extents. */
export function obstacleLowestWorldZ(obstacle: SceneObstacle): number {
  if (!isInlineObstacle(obstacle)) {
    return obstacle.pose.position[2];
  }
  const root = new THREE.Group();
  applyObjectPose(root, obstacle.pose);
  const geometries: THREE.BufferGeometry[] = [];
  for (const scenePart of obstacle.parts) {
    const geometry = createGeometry(scenePart.geometry);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry);
    applyObjectPose(mesh, scenePart.pose);
    root.add(mesh);
  }
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  for (const geometry of geometries) {
    geometry.dispose();
  }
  return bounds.min.z;
}

/** Shift the whole obstacle so its lowest point sits on the world ground plane z=0. */
export function snapObstacleToGround(obstacle: SceneObstacle): SceneObstacle {
  const minZ = obstacleLowestWorldZ(obstacle);
  if (!Number.isFinite(minZ) || Math.abs(minZ) < 1e-9) {
    return obstacle;
  }
  return withObstaclePose(obstacle, {
    ...obstacle.pose,
    position: [
      obstacle.pose.position[0],
      obstacle.pose.position[1],
      obstacle.pose.position[2] - minZ,
    ],
  });
}

export function createPlacementObstacle(
  preset: ScenePreset,
  pose: ScenePose = initialPose(DEFAULT_ADD_POSITION),
): SceneInlineObstacle {
  return withObstaclePose(createObstacle(preset, SCENE_DRAFT_ID), pose);
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
      return {
        type: "box",
        size: shape.size.map((n, i) => n * scale[i]!) as Vec3,
      };
    case "ellipsoid":
      return { ...shape, semiaxes: shape.semiaxes.map((n, i) => n * scale[i]!) as Vec3 };
    case "halfspaces":
      return {
        ...shape,
        halfspaces: shape.halfspaces.map(([nx, ny, nz, d]) => [nx / x, ny / y, nz / z, d]),
      };
    case "convex":
    case "mesh":
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
    case "ring":
      if (Math.abs(x - y) > 1e-5 || Math.abs(x - z) > 1e-5) {
        throw new Error("A ring needs uniform scaling. Edit its radii and tube radius instead.");
      }
      return {
        ...shape,
        radii: [shape.radii[0] * x, shape.radii[1] * x],
        tubeRadius: shape.tubeRadius * x,
      };
    case "capsule":
      if (Math.abs(x - y) > 1e-5 || Math.abs(x - z) > 1e-5) {
        throw new Error(
          "A capsule needs uniform scaling. Edit radius and cylinder height instead.",
        );
      }
      return { ...shape, radius: shape.radius * x, height: shape.height * z };
  }
}

export type SceneScaleConstraint = "xyz" | "radial" | "uniform";

/** The gizmo and numeric editor use the same exact primitive semantics. */
export function geometryScaleConstraint(shape: SceneGeometry): SceneScaleConstraint {
  switch (shape.type) {
    case "box":
    case "convex":
    case "mesh":
    case "halfspaces":
    case "ellipsoid":
      return "xyz";
    case "cylinder":
      return "radial";
    case "sphere":
    case "capsule":
    case "ring":
      return "uniform";
  }
}

/** Bake an equal-axis resize about the authored root, keeping each collision part separate. */
export function scaleObstacleUniformly(
  obstacle: SceneObstacle,
  factor: number,
): SceneInlineObstacle {
  if (!isInlineObstacle(obstacle)) {
    throw new Error("A model reference has no inline parts to scale.");
  }
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("Scale must be a positive finite number.");
  }
  return {
    ...obstacle,
    parts: obstacle.parts.map((scenePart) => ({
      ...scenePart,
      pose: {
        ...scenePart.pose,
        position: scenePart.pose.position.map((n) => n * factor) as Vec3,
      },
      geometry: scaleGeometry(scenePart.geometry, [factor, factor, factor]),
    })),
  };
}
