// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";

import type { Vector3 } from "./ros";

const tempPoint = new THREE.Vector3();

/**
 * Fat-line geometry with stable position, RGBA and distance attributes. Calling
 * Three.js setPositions/computeLineDistances on every message replaces GPU-backed
 * attributes, even when their capacity is sufficient. Both line passes share this
 * geometry; update it once, without dropping points or changing message cadence.
 */
export class DynamicLineGeometry extends LineGeometry {
  public colorBuffer = new Uint8Array();
  #positions = new Float32Array();
  #distances = new Float32Array();
  #capacity = 0;

  public constructor() {
    super();
    this.instanceCount = 0;
    this.boundingBox = new THREE.Box3();
    this.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  }

  public setPoints(points: readonly Vector3[], topology: "strip" | "list"): void {
    const count =
      topology === "strip" ? Math.max(0, points.length - 1) : Math.floor(points.length / 2);
    if (count > this.#capacity) {
      this.#grow(Math.max(count, Math.ceil(this.#capacity * 1.5)));
    }
    this.instanceCount = count;

    for (let i = 0; i < count; i++) {
      const pointIndex = topology === "strip" ? i : 2 * i;
      const start = points[pointIndex]!;
      const end = points[pointIndex + 1]!;
      const offset = 6 * i;
      this.#positions[offset] = start.x;
      this.#positions[offset + 1] = start.y;
      this.#positions[offset + 2] = start.z;
      this.#positions[offset + 3] = end.x;
      this.#positions[offset + 4] = end.y;
      this.#positions[offset + 5] = end.z;

      // Match LineSegments2.computeLineDistances, including Float32 rounding and
      // cumulative distance across disconnected segments. Do this once per update.
      const dx = this.#positions[offset + 3]! - this.#positions[offset];
      const dy = this.#positions[offset + 4]! - this.#positions[offset + 1]!;
      const dz = this.#positions[offset + 5]! - this.#positions[offset + 2]!;
      const distance = i === 0 ? 0 : this.#distances[2 * i - 1]!;
      this.#distances[2 * i] = distance;
      this.#distances[2 * i + 1] = distance + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    if (count > 0) {
      this.#markUpdated("instanceStart", count * 6);
      this.#markUpdated("instanceDistanceStart", count * 2);
    }
    this.computeBoundingBox();
    this.computeBoundingSphere();
  }

  /** Call after writing the active endpoint RGBA values to colorBuffer. */
  public updateColors(): void {
    if (this.instanceCount > 0) {
      this.#markUpdated("instanceColorStart", this.instanceCount * 8);
    }
  }

  // Bounds must exclude spare capacity and stale endpoints after a shorter path.
  public override computeBoundingBox(): void {
    const box = (this.boundingBox ??= new THREE.Box3());
    box.makeEmpty();
    for (let i = 0; i < this.instanceCount * 6; i += 3) {
      box.expandByPoint(tempPoint.fromArray(this.#positions, i));
    }
  }

  public override computeBoundingSphere(): void {
    const sphere = (this.boundingSphere ??= new THREE.Sphere());
    if (this.instanceCount === 0) {
      sphere.center.set(0, 0, 0);
      sphere.radius = 0;
      return;
    }
    if (this.boundingBox == undefined) {
      this.computeBoundingBox();
    }
    this.boundingBox!.getCenter(sphere.center);
    let radiusSquared = 0;
    for (let i = 0; i < this.instanceCount * 6; i += 3) {
      tempPoint.fromArray(this.#positions, i);
      radiusSquared = Math.max(radiusSquared, sphere.center.distanceToSquared(tempPoint));
    }
    sphere.radius = Math.sqrt(radiusSquared);
  }

  #markUpdated(name: string, count: number): void {
    const attribute = this.getAttribute(name) as THREE.InterleavedBufferAttribute;
    attribute.data.updateRange.offset = 0;
    attribute.data.updateRange.count = count;
    attribute.data.needsUpdate = true;
  }

  #grow(capacity: number): void {
    // Allocate everything before disposing: allocation failure leaves old GPU
    // attributes reachable. Every active element is rewritten by the caller.
    const positions = new Float32Array(capacity * 6);
    const colors = new Uint8Array(capacity * 8);
    const distances = new Float32Array(capacity * 2);
    const positionData = new THREE.InstancedInterleavedBuffer(positions, 6, 1);
    const colorData = new THREE.InstancedInterleavedBuffer(colors, 8, 1);
    const distanceData = new THREE.InstancedInterleavedBuffer(distances, 2, 1);
    positionData.setUsage(THREE.DynamicDrawUsage);
    colorData.setUsage(THREE.DynamicDrawUsage);
    distanceData.setUsage(THREE.DynamicDrawUsage);
    const attributes = {
      instanceStart: new THREE.InterleavedBufferAttribute(positionData, 3, 0),
      instanceEnd: new THREE.InterleavedBufferAttribute(positionData, 3, 3),
      instanceColorStart: new THREE.InterleavedBufferAttribute(colorData, 4, 0, true),
      instanceColorEnd: new THREE.InterleavedBufferAttribute(colorData, 4, 4, true),
      instanceDistanceStart: new THREE.InterleavedBufferAttribute(distanceData, 1, 0),
      instanceDistanceEnd: new THREE.InterleavedBufferAttribute(distanceData, 1, 1),
    };

    // WebGLGeometries must still see the OLD buffers in its dispose listener.
    // Keep this geometry's identity, so depth, color and picking stay in sync.
    this.dispose();
    for (const [name, attribute] of Object.entries(attributes)) {
      this.setAttribute(name, attribute);
    }
    this.#positions = positions;
    this.colorBuffer = colors;
    this.#distances = distances;
    this.#capacity = capacity;
  }
}
