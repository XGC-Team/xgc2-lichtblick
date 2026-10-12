// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team

import * as THREE from "three";

import { DynamicBufferGeometry } from "./DynamicBufferGeometry";
import { DynamicLineGeometry } from "./DynamicLineGeometry";
import { DEFAULT_CAMERA_STATE } from "./camera";
import { cameraStateForBounds, visibleContentBounds } from "./visibleContentBounds";

describe("visible drawing bounds", () => {
  it("uses active point lengths, ignores NaN and stale capacity, and applies the displayed transform", () => {
    const geometry = new DynamicBufferGeometry(THREE.DynamicDrawUsage);
    geometry.createAttribute("position", Float32Array, 3);
    geometry.resize(3);
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
    positions.setXYZ(0, 1, 2, 3);
    positions.setXYZ(1, NaN, 8, 9);
    positions.setXYZ(2, 1000, 1000, 1000);
    geometry.resize(2);
    const cloud = new THREE.Points(geometry, new THREE.PointsMaterial());
    cloud.position.set(10, 20, 30);
    cloud.scale.setScalar(2);
    const bounds = visibleContentBounds([cloud]);
    expect(bounds.min.toArray()).toEqual([12, 24, 36]);
    expect(bounds.max.toArray()).toEqual([12, 24, 36]);
  });

  it("excludes hidden ancestors, zero-draw geometry, invisible materials, and edit tools", () => {
    const root = new THREE.Group();
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.add(
      new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial()),
    );
    const empty = new THREE.Points(new THREE.BoxGeometry(), new THREE.PointsMaterial());
    empty.geometry.setDrawRange(0, 0);
    const tool = Object.assign(new THREE.Group(), { type: "TransformControls" });
    tool.add(
      new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000), new THREE.MeshBasicMaterial()),
    );
    root.add(
      hidden,
      empty,
      tool,
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ visible: false })),
    );
    expect(visibleContentBounds([root]).isEmpty()).toBe(true);
  });

  it("includes live pooled URDF instances in their rebased world space and excludes hidden or released slots", () => {
    const batch = Object.assign(new THREE.Group(), {
      isRenderable: true,
      instanceOwner: (index: number) => (index === 1 ? { visible: false } : undefined),
    });
    batch.position.set(100, 200, 0);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2, 2, 2),
      new THREE.MeshBasicMaterial(),
      3,
    );
    mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(20, 30, 4));
    mesh.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1000, 1000, 1000));
    mesh.setMatrixAt(2, new THREE.Matrix4().makeScale(0, 0, 0));
    batch.add(mesh);
    const bounds = visibleContentBounds([batch]);
    expect(bounds.min.toArray()).toEqual([119, 229, 3]);
    expect(bounds.max.toArray()).toEqual([121, 231, 5]);
  });

  it("uses active wide-line endpoints after a shorter path replaces a longer one", () => {
    const geometry = new DynamicLineGeometry();
    geometry.setPoints(
      [
        { x: 1000, y: 1000, z: 1000 },
        { x: 2000, y: 2000, z: 2000 },
      ],
      "strip",
    );
    geometry.setPoints(
      [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
      ],
      "strip",
    );
    const line = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    expect(visibleContentBounds([line]).min.toArray()).toEqual([1, 2, 3]);
    expect(visibleContentBounds([line]).max.toArray()).toEqual([4, 5, 6]);
  });
});

describe("native camera framing", () => {
  const bounds = new THREE.Box3(
    new THREE.Vector3(-33, -27.5, -1),
    new THREE.Vector3(27.5, 27.5, 3),
  );

  it.each([
    0.35,
    1080 / 1920,
    1,
    1920 / 1080,
  ])("keeps every world-bound corner in a perspective pane of aspect %s", (aspect) => {
    const state = { ...DEFAULT_CAMERA_STATE, targetOffset: [-32, 0, 0] as const };
    const camera = new THREE.PerspectiveCamera(state.fovy, aspect, state.near, state.far);
    camera.quaternion.setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(state.phi),
        0,
        -THREE.MathUtils.degToRad(state.thetaOffset),
        "ZYX",
      ),
    );
    const next = cameraStateForBounds(
      bounds,
      camera,
      state,
      new THREE.Vector2(1000 * aspect, 1000),
    )!;
    expect(next.perspective).toBe(true);
    expect(next.phi).toBe(state.phi);
    expect(next.thetaOffset).toBe(state.thetaOffset);
    camera.position
      .set(0, 0, next.distance)
      .applyQuaternion(camera.quaternion)
      .add(new THREE.Vector3(...next.targetOffset));
    camera.far = next.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThan(1);
          expect(Math.abs(projected.y)).toBeLessThan(1);
          expect(Math.abs(projected.z)).toBeLessThan(1);
        }
      }
    }
    expect(state.targetOffset).toEqual([-32, 0, 0]);
  });

  it.each([
    0.35, 1.7,
  ])("fits the native 2D span at aspect %s without switching projection", (aspect) => {
    const state = { ...DEFAULT_CAMERA_STATE, perspective: false };
    const camera = new THREE.OrthographicCamera(
      -10 * aspect,
      10 * aspect,
      10,
      -10,
      state.near,
      state.far,
    );
    camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 4);
    const next = cameraStateForBounds(
      bounds,
      camera,
      state,
      new THREE.Vector2(1000 * aspect, 1000),
    )!;
    expect(next.perspective).toBe(false);
    camera.left = (-next.distance * aspect) / 2;
    camera.right = (next.distance * aspect) / 2;
    camera.top = next.distance / 2;
    camera.bottom = -next.distance / 2;
    camera.position.set(next.targetOffset[0], next.targetOffset[1], next.far / 2);
    camera.far = next.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const projected = new THREE.Vector3(x, y, z).project(camera);
          expect(Math.abs(projected.x)).toBeLessThan(1);
          expect(Math.abs(projected.y)).toBeLessThan(1);
        }
      }
    }
  });

  it("retains the existing Overview for missing geometry or an unavailable pane", () => {
    const camera = new THREE.PerspectiveCamera();
    expect(
      cameraStateForBounds(
        new THREE.Box3(),
        camera,
        DEFAULT_CAMERA_STATE,
        new THREE.Vector2(100, 100),
      ),
    ).toBeUndefined();
    expect(
      cameraStateForBounds(bounds, camera, DEFAULT_CAMERA_STATE, new THREE.Vector2(0, 100)),
    ).toBeUndefined();
  });
});
