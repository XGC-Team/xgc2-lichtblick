// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import type { IRenderer } from "../IRenderer";
import { arrowHeadSubdivisions, arrowShaftSubdivisions, DetailLevel } from "../lod";
import { ColorRGBA } from "../ros";
import type { Pose } from "../transforms";

const SHAFT_LENGTH = 0.154;
const SHAFT_DIAMETER = 0.02;
const HEAD_LENGTH = 0.046;
const HEAD_DIAMETER = 0.05;

export const AXIS_LENGTH = SHAFT_LENGTH + HEAD_LENGTH;

/** Convert a desired axis length in scene meters into the Axis Object3D scale. */
export function axisObjectScale(lengthMeters: number): number {
  return lengthMeters / AXIS_LENGTH;
}

const RED_COLOR = new THREE.Color(0x9c3948);
const GREEN_COLOR = new THREE.Color(0x88dd04);
const BLUE_COLOR = new THREE.Color(0x2b90fb);

const COLOR_WHITE = { r: 1, g: 1, b: 1, a: 1 };

const PI_2 = Math.PI / 2;

const tempMat4 = new THREE.Matrix4();
const tempVec = new THREE.Vector3();
const tempPosition = new THREE.Vector3();
const tempQuaternion = new THREE.Quaternion();
const tempScale = new THREE.Vector3();
const tempPoseMatrix = new THREE.Matrix4();

export class Axis extends THREE.Object3D {
  readonly #renderer: IRenderer;
  #shaftMesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  #headMesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

  #localShaftMatrices?: THREE.Matrix4[];
  #localHeadMatrices?: THREE.Matrix4[];
  #disposed = false;

  public constructor(name: string, renderer: IRenderer) {
    super();
    this.name = name;
    this.#renderer = renderer;

    // Create three arrow shafts
    const shaftGeometry = this.#renderer.sharedGeometry.getGeometry(
      `${this.constructor.name}-shaft-${this.#renderer.maxLod}`,
      () => createShaftGeometry(this.#renderer.maxLod),
    );
    this.#shaftMesh = new THREE.InstancedMesh(shaftGeometry, standardMaterial(COLOR_WHITE), 3);
    this.#shaftMesh.frustumCulled = false;
    this.#shaftMesh.castShadow = true;
    this.#shaftMesh.receiveShadow = true;

    // Create three arrow heads
    const headGeometry = this.#renderer.sharedGeometry.getGeometry(
      `${this.constructor.name}-head-${this.#renderer.maxLod}`,
      () => createHeadGeometry(this.#renderer.maxLod),
    );

    this.#headMesh = new THREE.InstancedMesh(headGeometry, standardMaterial(COLOR_WHITE), 3);
    this.#headMesh.frustumCulled = false;
    this.#headMesh.castShadow = true;
    this.#headMesh.receiveShadow = true;

    Axis.#UpdateInstances(this.#shaftMesh, this.#headMesh, 0);

    this.add(this.#shaftMesh);
    this.add(this.#headMesh);
  }

  /**
   * Draw every supplied pose using two meshes, rather than two meshes per pose.
   * Single-axis users need not call this method and retain the original behavior.
   * Poses are in this object's parent frame; their quaternions are not normalized
   * or synthesized here. The parent Renderable still owns the timestamped TF.
   */
  public setPoses(poses: readonly Pose[], lengthMeters: number): void {
    if (this.#disposed) {
      return;
    }
    if (this.#localShaftMatrices == undefined || this.#localHeadMatrices == undefined) {
      // Capture the original Float32 local transforms before the first batch.
      this.#localShaftMatrices = [];
      this.#localHeadMatrices = [];
      for (let i = 0; i < 3; i++) {
        const shaft = new THREE.Matrix4();
        const head = new THREE.Matrix4();
        this.#shaftMesh.getMatrixAt(i, shaft);
        this.#headMesh.getMatrixAt(i, head);
        this.#localShaftMatrices.push(shaft);
        this.#localHeadMatrices.push(head);
      }
    }

    const capacity = this.#shaftMesh.instanceMatrix.count / 3;
    if (poses.length > capacity) {
      const nextCapacity = Math.max(poses.length, capacity * 2);
      this.#shaftMesh = this.#growMesh(this.#shaftMesh, nextCapacity);
      this.#headMesh = this.#growMesh(this.#headMesh, nextCapacity);
    }

    // Rebase near the data before conversion to Float32 instance matrices.
    // Otherwise small movements around large map coordinates lose precision.
    const origin = poses[0]?.position;
    this.position.set(origin?.x ?? 0, origin?.y ?? 0, origin?.z ?? 0);
    this.quaternion.identity();
    this.scale.set(1, 1, 1);
    this.matrixAutoUpdate = false;
    this.updateMatrix();
    this.visible = poses.length > 0;
    const scale = axisObjectScale(lengthMeters);
    tempScale.set(scale, scale, scale);

    for (let i = 0; i < poses.length; i++) {
      const { position: p, orientation: q } = poses[i]!;
      tempPosition.set(p.x - this.position.x, p.y - this.position.y, p.z - this.position.z);
      tempQuaternion.set(q.x, q.y, q.z, q.w);
      tempPoseMatrix.compose(tempPosition, tempQuaternion, tempScale);
      for (let axis = 0; axis < 3; axis++) {
        tempMat4.multiplyMatrices(tempPoseMatrix, this.#localShaftMatrices[axis]!);
        this.#shaftMesh.setMatrixAt(i * 3 + axis, tempMat4);
        tempMat4.multiplyMatrices(tempPoseMatrix, this.#localHeadMatrices[axis]!);
        this.#headMesh.setMatrixAt(i * 3 + axis, tempMat4);
      }
    }
    this.#updateMesh(this.#shaftMesh, poses.length * 3);
    this.#updateMesh(this.#headMesh, poses.length * 3);
  }

  #growMesh(
    previous: THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    poseCapacity: number,
  ): THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
    const mesh = new THREE.InstancedMesh(previous.geometry, previous.material, poseCapacity * 3);
    mesh.frustumCulled = previous.frustumCulled;
    mesh.castShadow = previous.castShadow;
    mesh.receiveShadow = previous.receiveShadow;
    // Selection sets layers on descendants. Do not lose the highlight on growth.
    mesh.layers.mask = previous.layers.mask;
    for (let i = 0; i < poseCapacity; i++) {
      mesh.setColorAt(i * 3, RED_COLOR);
      mesh.setColorAt(i * 3 + 1, GREEN_COLOR);
      mesh.setColorAt(i * 3 + 2, BLUE_COLOR);
    }
    this.remove(previous);
    this.add(mesh);
    // Only instance storage is owned here. Geometry is renderer-shared and
    // the material transfers to the replacement mesh until final disposal.
    previous.dispose();
    return mesh;
  }

  #updateMesh(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count;
    mesh.matrixAutoUpdate = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (count > 0) {
      mesh.instanceMatrix.updateRange.offset = 0;
      mesh.instanceMatrix.updateRange.count = count * 16;
      mesh.instanceMatrix.needsUpdate = true;
    }
    // GPU picking uses the same instances; invalidate cached CPU raycast bounds
    // too. Frustum culling stays disabled, as in the original Axis.
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#shaftMesh.material.dispose();
    this.#shaftMesh.dispose();
    this.#headMesh.material.dispose();
    this.#headMesh.dispose();
  }

  static #UpdateInstances(
    shaft: THREE.InstancedMesh,
    head: THREE.InstancedMesh,
    axisIndex: number,
  ): void {
    const indexX = axisIndex * 3 + 0;
    const indexY = axisIndex * 3 + 1;
    const indexZ = axisIndex * 3 + 2;

    // Set x, y, and z axis arrow shaft directions
    tempVec.set(SHAFT_LENGTH, SHAFT_DIAMETER, SHAFT_DIAMETER);
    shaft.setMatrixAt(indexX, tempMat4.identity().scale(tempVec));
    shaft.setMatrixAt(indexY, tempMat4.makeRotationZ(PI_2).scale(tempVec));
    shaft.setMatrixAt(indexZ, tempMat4.makeRotationY(-PI_2).scale(tempVec));

    // Set x, y, and z axis arrow head directions
    tempVec.set(HEAD_LENGTH, HEAD_DIAMETER, HEAD_DIAMETER);
    tempMat4.identity().scale(tempVec).setPosition(SHAFT_LENGTH, 0, 0);
    head.setMatrixAt(indexX, tempMat4);
    tempMat4.makeRotationZ(PI_2).scale(tempVec).setPosition(0, SHAFT_LENGTH, 0);
    head.setMatrixAt(indexY, tempMat4);
    tempMat4.makeRotationY(-PI_2).scale(tempVec).setPosition(0, 0, SHAFT_LENGTH);
    head.setMatrixAt(indexZ, tempMat4);

    // Set x, y, and z axis arrow shaft colors
    shaft.setColorAt(indexX, RED_COLOR);
    shaft.setColorAt(indexY, GREEN_COLOR);
    shaft.setColorAt(indexZ, BLUE_COLOR);

    // Set x, y, and z axis arrow head colors
    head.setColorAt(indexX, RED_COLOR);
    head.setColorAt(indexY, GREEN_COLOR);
    head.setColorAt(indexZ, BLUE_COLOR);
  }
}

function createShaftGeometry(lod: DetailLevel): THREE.CylinderGeometry {
  const subdivs = arrowShaftSubdivisions(lod);
  const shaftGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, subdivs, 1, false);
  shaftGeometry.rotateZ(-PI_2);
  shaftGeometry.translate(0.5, 0, 0);
  shaftGeometry.computeBoundingSphere();
  return shaftGeometry;
}

function createHeadGeometry(lod: DetailLevel): THREE.ConeGeometry {
  const subdivs = arrowHeadSubdivisions(lod);
  const headGeometry = new THREE.ConeGeometry(0.5, 1, subdivs, 1, false);
  headGeometry.rotateZ(-PI_2);
  headGeometry.translate(0.5, 0, 0);
  headGeometry.computeBoundingSphere();
  return headGeometry;
}
function standardMaterial(color: ColorRGBA): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color.r, color.g, color.b).convertSRGBToLinear(),
    metalness: 0,
    roughness: 1,
    dithering: true,
    opacity: color.a,
    transparent: color.a < 1,
    depthWrite: color.a === 1,
  });
}
