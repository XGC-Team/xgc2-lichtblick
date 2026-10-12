// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team

import * as THREE from "three";

import type { Renderable } from "./Renderable";
import type { CameraState } from "./camera";

const point = new THREE.Vector3();
const instanceMatrix = new THREE.Matrix4();
const worldMatrix = new THREE.Matrix4();

function finitePoint(value: THREE.Vector3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function geometryBounds(geometry: THREE.BufferGeometry): THREE.Box3 {
  const box = new THREE.Box3();
  // Native wide lines store endpoints in active instances, not in position.
  if (
    geometry instanceof THREE.InstancedBufferGeometry &&
    geometry.hasAttribute("instanceStart") &&
    geometry.hasAttribute("instanceEnd")
  ) {
    const start = geometry.getAttribute("instanceStart");
    const end = geometry.getAttribute("instanceEnd");
    const count = Math.min(geometry.instanceCount, start.count, end.count);
    for (let i = 0; i < count; i++) {
      for (const attribute of [start, end]) {
        point.fromBufferAttribute(attribute, i);
        if (finitePoint(point)) {
          box.expandByPoint(point);
        }
      }
    }
    return box;
  }
  if (!geometry.hasAttribute("position")) {
    return box;
  }
  const positions = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const first = Math.max(0, geometry.drawRange.start);
  const last = Math.min(index?.count ?? positions.count, first + geometry.drawRange.count);
  for (let i = first; i < last; i++) {
    point.fromBufferAttribute(positions, index ? index.getX(i) : i);
    if (finitePoint(point)) {
      box.expandByPoint(point);
    }
  }
  return box;
}

/** Current visible drawing only: no unused point capacity or hidden pooled links. */
export function visibleContentBounds(roots: Iterable<THREE.Object3D>): THREE.Box3 {
  const bounds = new THREE.Box3();
  const geometries = new Map<THREE.BufferGeometry, THREE.Box3>();
  const localBox = new THREE.Box3();
  function visit(object: THREE.Object3D, owner?: Renderable) {
    if (!object.visible || object.type === "TransformControls" || object.type === "Sprite") {
      return;
    }
    const renderable = object as Partial<Renderable>;
    const currentOwner = renderable.isRenderable ? (object as Renderable) : owner;
    const drawable = object as THREE.Mesh | THREE.Points | THREE.Line;
    if (drawable.geometry instanceof THREE.BufferGeometry) {
      const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
      if (materials.some((material) => material.visible && material.opacity > 0)) {
        let box = geometries.get(drawable.geometry);
        if (!box) {
          box = geometryBounds(drawable.geometry);
          geometries.set(drawable.geometry, box);
        }
        if (!box.isEmpty()) {
          if (object instanceof THREE.InstancedMesh) {
            for (let i = 0; i < object.count; i++) {
              const instanceOwner = currentOwner?.instanceOwner(i);
              if (instanceOwner && !instanceOwner.visible) {
                continue;
              }
              object.getMatrixAt(i, instanceMatrix);
              // Released/hidden pool slots are zero-scale matrices.
              if (instanceMatrix.determinant() === 0) {
                continue;
              }
              worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
              localBox.copy(box).applyMatrix4(worldMatrix);
              if (finitePoint(localBox.min) && finitePoint(localBox.max)) {
                bounds.union(localBox);
              }
            }
          } else {
            localBox.copy(box).applyMatrix4(object.matrixWorld);
            if (finitePoint(localBox.min) && finitePoint(localBox.max)) {
              bounds.union(localBox);
            }
          }
        }
      }
    }
    for (const child of object.children) {
      visit(child, currentOwner);
    }
  }
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    visit(root);
  }
  return bounds;
}

/** Fit the native projection to the content; preserve the Overview's orientation and mode. */
export function cameraStateForBounds(
  bounds: THREE.Box3,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  state: CameraState,
  viewport: THREE.Vector2,
): CameraState | undefined {
  if (
    bounds.isEmpty() ||
    !finitePoint(bounds.min) ||
    !finitePoint(bounds.max) ||
    !Number.isFinite(viewport.x) ||
    !Number.isFinite(viewport.y) ||
    viewport.x <= 0 ||
    viewport.y <= 0
  ) {
    return;
  }
  const center = bounds.getCenter(new THREE.Vector3());
  camera.updateWorldMatrix(true, false);
  const inverseRotation = camera.getWorldQuaternion(new THREE.Quaternion()).invert();
  const aspect = viewport.x / viewport.y;
  const tangentY =
    camera instanceof THREE.PerspectiveCamera
      ? Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2)
      : 0;
  const tangentX = tangentY * aspect;
  let distance = 0;
  let depth = 0;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        point.set(x, y, z).sub(center).applyQuaternion(inverseRotation);
        depth = Math.max(depth, Math.abs(point.z));
        distance = Math.max(
          distance,
          camera instanceof THREE.PerspectiveCamera
            ? point.z +
                Math.max(Math.abs(point.x) / tangentX, Math.abs(point.y) / tangentY, camera.near)
            : 2 * Math.max(Math.abs(point.y), Math.abs(point.x) / aspect),
        );
      }
    }
  }
  // A small proportional inset keeps boundary geometry inside the viewport.
  distance = distance > 0 ? distance * 1.05 : state.distance;
  if (!Number.isFinite(distance) || distance <= 0) {
    return;
  }
  return {
    ...state,
    targetOffset: center.toArray(),
    distance,
    far: Math.max(
      state.far,
      distance + depth + state.near,
      2 * (Math.abs(center.z) + depth + state.near),
    ),
  };
}
