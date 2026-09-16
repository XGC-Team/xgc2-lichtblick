// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { Axis, AXIS_LENGTH, axisObjectScale } from "./Axis";
import type { IRenderer } from "../IRenderer";
import { SharedGeometry } from "../SharedGeometry";
import { DetailLevel } from "../lod";
import type { Pose } from "../transforms";

function pose(x: number, y = 0, z = 0): Pose {
  return { position: { x, y, z }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
}

function meshes(axis: Axis): THREE.InstancedMesh[] {
  return axis.children as THREE.InstancedMesh[];
}

function worldInstance(mesh: THREE.InstancedMesh, index: number): THREE.Matrix4 {
  const instance = new THREE.Matrix4();
  mesh.getMatrixAt(index, instance);
  return new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, instance);
}

describe("Axis pose instancing", () => {
  let sharedGeometry: SharedGeometry;
  let renderer: IRenderer;
  let allocated: Axis[];

  function createAxis(): Axis {
    const axis = new Axis("/prediction", renderer);
    allocated.push(axis);
    return axis;
  }

  beforeEach(() => {
    sharedGeometry = new SharedGeometry();
    renderer = { sharedGeometry, maxLod: DetailLevel.High } as unknown as IRenderer;
    allocated = [];
  });

  afterEach(() => {
    for (const axis of allocated) {
      axis.dispose();
    }
    sharedGeometry.dispose();
  });

  it("keeps the legacy single-axis shape and material settings", () => {
    const axis = createAxis();
    expect(axis.children).toHaveLength(2);
    for (const mesh of meshes(axis)) {
      expect(mesh.count).toBe(3);
      expect(mesh.frustumCulled).toBe(false);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.roughness).toBe(1);
      expect(material.transparent).toBe(false);
    }
    expect(axis.matrixAutoUpdate).toBe(true);
  });

  it("keeps every pose and RGB direction with only two meshes and two materials", () => {
    const axis = createAxis();
    const originalColors = Array.from(meshes(axis)[0]!.instanceColor!.array);
    const poses = Array.from({ length: 1000 }, (_, i) => pose(i * 0.01));
    axis.setPoses(poses, AXIS_LENGTH);
    expect(axis.children).toHaveLength(2);
    const materials = new Set(meshes(axis).map((mesh) => mesh.material));
    expect(materials.size).toBe(2);
    for (const mesh of meshes(axis)) {
      expect(mesh.count).toBe(3000);
      expect(mesh.instanceMatrix.updateRange.count).toBe(3000 * 16);
      expect(mesh.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
      for (let i = 0; i < poses.length; i++) {
        expect(Array.from(mesh.instanceColor!.array.slice(i * 9, i * 9 + 9))).toEqual(
          originalColors,
        );
      }
    }
  });

  it("matches original axes for all quaternion directions, scale and parent TF", () => {
    const batch = createAxis();
    const poses = Array.from({ length: 16 }, (_, i) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.19, i * -0.23, i * 0.41));
      return {
        position: { x: i * 0.37, y: i * -0.11, z: i * 0.07 },
        orientation: { x: q.x, y: q.y, z: q.z, w: q.w },
      };
    });
    const parent = new THREE.Group();
    parent.position.set(17, -9, 4);
    parent.quaternion.setFromEuler(new THREE.Euler(0.3, -0.2, 0.8));
    parent.add(batch);
    batch.setPoses(poses, 0.15);
    for (let i = 0; i < poses.length; i++) {
      const reference = createAxis();
      const { position: p, orientation: q } = poses[i]!;
      reference.position.set(p.x, p.y, p.z);
      reference.quaternion.set(q.x, q.y, q.z, q.w);
      reference.scale.setScalar(axisObjectScale(0.15));
      parent.add(reference);
      parent.updateMatrixWorld(true);
      for (let part = 0; part < 2; part++) {
        for (let direction = 0; direction < 3; direction++) {
          const expected = worldInstance(meshes(reference)[part]!, direction);
          const actual = worldInstance(meshes(batch)[part]!, i * 3 + direction);
          for (let element = 0; element < 16; element++) {
            expect(actual.elements[element]).toBeCloseTo(expected.elements[element]!, 5);
          }
        }
      }
    }
  });

  it("rebases large coordinates before Float32 upload and never mutates authored poses", () => {
    const axis = createAxis();
    const poses = [pose(1e9, -1e9, 1e9), pose(1e9 + 0.001, -1e9, 1e9)];
    poses[1]!.orientation = { x: 0, y: 0, z: 0.6, w: 0.8 };
    const before = JSON.stringify(poses);
    for (const p of poses) {
      Object.freeze(p.position);
      Object.freeze(p.orientation);
      Object.freeze(p);
    }
    Object.freeze(poses);
    axis.setPoses(poses, 0.15);
    expect(axis.position.x).toBe(1e9);
    const matrix = new THREE.Matrix4();
    meshes(axis)[0]!.getMatrixAt(3, matrix);
    expect(matrix.elements[12]).toBeCloseTo(poses[1]!.position.x - 1e9, 9);
    expect(matrix.elements[12]).toBeGreaterThan(0);
    expect(JSON.stringify(poses)).toBe(before);
  });

  it("reuses mesh, material and buffer identity through update, shrink, empty and regrow", () => {
    const axis = createAxis();
    axis.setPoses([pose(0), pose(1), pose(2), pose(3)], 0.15);
    const before = meshes(axis).map((mesh) => ({
      mesh,
      matrix: mesh.instanceMatrix,
      color: mesh.instanceColor,
      material: mesh.material,
    }));
    for (const count of [4, 2, 0, 1, 4]) {
      axis.setPoses(Array.from({ length: count }, (_, i) => pose(i * 2)), 0.3);
      expect(axis.visible).toBe(count > 0);
      for (let i = 0; i < 2; i++) {
        const mesh = meshes(axis)[i]!;
        expect(mesh).toBe(before[i]!.mesh);
        expect(mesh.instanceMatrix).toBe(before[i]!.matrix);
        expect(mesh.instanceColor).toBe(before[i]!.color);
        expect(mesh.material).toBe(before[i]!.material);
        expect(mesh.count).toBe(count * 3);
      }
    }
  });

  it("grows storage amortized without reducing the active pose count", () => {
    const axis = createAxis();
    const poses: Pose[] = [];
    let previous = meshes(axis)[0]!;
    let growths = 0;
    for (let i = 0; i < 1024; i++) {
      poses.push(pose(i * 0.01));
      axis.setPoses(poses, 0.15);
      const current = meshes(axis)[0]!;
      if (current !== previous) {
        growths++;
        previous = current;
      }
      expect(current.count).toBe(poses.length * 3);
    }
    expect(growths).toBe(10);
    expect(axis.children).toHaveLength(2);
  });

  it("preserves selected layers on growth and does not dispose shared resources", () => {
    const axis = createAxis();
    axis.traverse((object) => object.layers.set(1));
    const previous = meshes(axis).slice();
    const instanceDisposals = previous.map((mesh) => jest.spyOn(mesh, "dispose"));
    const geometryDisposals = previous.map((mesh) => jest.spyOn(mesh.geometry, "dispose"));
    const materialDisposals = previous.map((mesh) =>
      jest.spyOn(mesh.material as THREE.Material, "dispose"),
    );
    axis.setPoses([pose(0), pose(1)], 0.15);
    for (let i = 0; i < 2; i++) {
      expect(meshes(axis)[i]!.layers.mask).toBe(2);
      expect(meshes(axis)[i]!.geometry).toBe(previous[i]!.geometry);
      expect(meshes(axis)[i]!.material).toBe(previous[i]!.material);
      expect(instanceDisposals[i]).toHaveBeenCalledTimes(1);
      expect(geometryDisposals[i]).not.toHaveBeenCalled();
      expect(materialDisposals[i]).not.toHaveBeenCalled();
    }
    const finalDisposals = meshes(axis).map((mesh) => jest.spyOn(mesh, "dispose"));
    axis.dispose();
    axis.dispose();
    axis.setPoses([pose(9)], 0.2);
    for (let i = 0; i < 2; i++) {
      expect(finalDisposals[i]).toHaveBeenCalledTimes(1);
      expect(materialDisposals[i]).toHaveBeenCalledTimes(1);
      expect(geometryDisposals[i]).not.toHaveBeenCalled();
    }
  });

  it("invalidates raycast bounds and excludes stale instances after shrink", () => {
    const axis = createAxis();
    axis.setPoses([pose(0), pose(3)], AXIS_LENGTH);
    axis.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(3.05, 0, 1), new THREE.Vector3(0, 0, -1));
    expect(ray.intersectObject(axis, true).length).toBeGreaterThan(0);
    axis.setPoses([pose(0)], AXIS_LENGTH);
    for (const mesh of meshes(axis)) {
      expect(mesh.boundingSphere).toBeNull();
    }
    axis.updateMatrixWorld(true);
    expect(ray.intersectObject(axis, true)).toHaveLength(0);
  });
});
