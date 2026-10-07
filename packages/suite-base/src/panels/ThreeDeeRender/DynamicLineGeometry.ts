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
      this.#markUpdated("instanceStart", 0, count * 6);
      this.#markUpdated("instanceDistanceStart", 0, count * 2);
    }
    this.computeBoundingBox();
    this.computeBoundingSphere();
  }

  /**
   * Append tail points to a line strip whose prefix is already uploaded.
   * `startIndex` is the index in `points` of the first new point, so it must
   * equal the number of previously uploaded points; the first new segment then
   * connects points[startIndex - 1] to points[startIndex] and the cumulative
   * distances continue from the last uploaded value. Any other `startIndex`
   * means the buffered prefix does not match: fall back to a full setPoints.
   */
  public appendPoints(points: readonly Vector3[], startIndex: number): void {
    if (startIndex !== this.instanceCount + 1) {
      this.setPoints(points, "strip");
      return;
    }
    const count = points.length - 1;
    if (count > this.#capacity) {
      this.#growPreservingPrefix(Math.max(count, Math.ceil(this.#capacity * 1.5)));
    }
    const first = startIndex - 1;
    for (let i = first; i < count; i++) {
      const start = points[i]!;
      const end = points[i + 1]!;
      const offset = 6 * i;
      this.#positions[offset] = start.x;
      this.#positions[offset + 1] = start.y;
      this.#positions[offset + 2] = start.z;
      this.#positions[offset + 3] = end.x;
      this.#positions[offset + 4] = end.y;
      this.#positions[offset + 5] = end.z;

      const dx = this.#positions[offset + 3]! - this.#positions[offset];
      const dy = this.#positions[offset + 4]! - this.#positions[offset + 1]!;
      const dz = this.#positions[offset + 5]! - this.#positions[offset + 2]!;
      const distance = i === 0 ? 0 : this.#distances[2 * i - 1]!;
      this.#distances[2 * i] = distance;
      this.#distances[2 * i + 1] = distance + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.instanceCount = count;
    if (count > first) {
      this.#markUpdated("instanceStart", first * 6, (count - first) * 6);
      this.#markUpdated("instanceDistanceStart", first * 2, (count - first) * 2);
    }

    // The box of an unchanged prefix plus a tail is the old box expanded by the
    // new endpoints. Read them back from the float32 buffer (as a full recompute
    // would) and include the connecting point: while it formed no segment
    // (singleton input) it was never bounded. The sphere center follows the box
    // center, so old radii do not transfer and a rescan is required.
    const box = (this.boundingBox ??= new THREE.Box3());
    for (let i = first * 6; i < count * 6; i += 3) {
      box.expandByPoint(tempPoint.fromArray(this.#positions, i));
    }
    this.computeBoundingSphere();
  }

  /**
   * Call after writing the active endpoint RGBA values to colorBuffer. Pass
   * `firstSegment` when an append rewrote only the tail pairs.
   */
  public updateColors(firstSegment = 0): void {
    if (this.instanceCount > firstSegment) {
      this.#markUpdated(
        "instanceColorStart",
        firstSegment * 8,
        (this.instanceCount - firstSegment) * 8,
      );
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

  #markUpdated(name: string, offset: number, count: number): void {
    const attribute = this.getAttribute(name) as THREE.InterleavedBufferAttribute;
    attribute.data.updateRange.offset = offset;
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

  // #grow replaces every buffer without copying; appends instead keep the
  // unchanged prefix so only the tail needs writing afterwards. The fresh GPU
  // buffers upload in full on first use, so the prefix copy reaches the GPU
  // even though only the tail range is marked.
  #growPreservingPrefix(capacity: number): void {
    const active = this.instanceCount;
    const positions = this.#positions.subarray(0, active * 6);
    const colors = this.colorBuffer.subarray(0, active * 8);
    const distances = this.#distances.subarray(0, active * 2);
    this.#grow(capacity);
    this.#positions.set(positions);
    this.colorBuffer.set(colors);
    this.#distances.set(distances);
  }
}
