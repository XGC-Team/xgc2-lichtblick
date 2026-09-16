// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";

import { LineStripBuffers } from "./LineStripBuffers";
import { RenderableMarker } from "./RenderableMarker";
import {
  makeLineMaterial,
  makeLinePrepassMaterial,
  makeLinePickingMaterial,
  markerHasTransparency,
} from "./materials";
import type { IRenderer } from "../../IRenderer";
import { LineMaterialWithAlphaVertex } from "../../LineMaterialWithAlphaVertex";
import { Marker } from "../../ros";

const tempTuple4: THREE.Vector4Tuple = [0, 0, 0, 0];

export class RenderableLineStrip extends RenderableMarker {
  #geometry: LineGeometry;
  #linePrepass: Line2;
  #line: Line2;
  #buffers = new LineStripBuffers();
  #positionBuffer?: THREE.InstancedInterleavedBuffer;
  #colorBuffer?: THREE.InstancedInterleavedBuffer;
  #distanceBuffer?: THREE.InstancedInterleavedBuffer;

  public constructor(
    topic: string,
    marker: Marker,
    receiveTime: bigint | undefined,
    renderer: IRenderer,
  ) {
    super(topic, marker, receiveTime, renderer);

    this.#geometry = new LineGeometry();
    this.#geometry.instanceCount = 0;

    const options = { resolution: renderer.input.canvasSize, worldUnits: true };

    // We alleviate corner artifacts using a two-pass render for lines. The
    // first pass writes to depth only, followed by a color pass with stencil
    // operations. The source for this technique is:
    // <https://github.com/mrdoob/three.js/issues/23680#issuecomment-1063294691>
    // <https://gkjohnson.github.io/threejs-sandbox/fat-line-opacity/webgl_lines_fat.html>

    // Depth pass 1
    const matLinePrepass = makeLinePrepassMaterial(marker, options);
    this.#linePrepass = new Line2(this.#geometry, matLinePrepass);
    this.#linePrepass.renderOrder = 1;
    this.#linePrepass.userData.picking = false;
    this.add(this.#linePrepass);

    // Color pass 2
    const matLine = makeLineMaterial(marker, options);
    this.#line = new Line2(this.#geometry, matLine);
    this.#line.renderOrder = 2;
    const pickingLineWidth = marker.scale.x * 1.2;
    this.#line.userData.pickingMaterial = makeLinePickingMaterial(pickingLineWidth, options);
    this.add(this.#line);

    this.update(marker, receiveTime);
  }

  public override dispose(): void {
    // The two passes share this geometry. Neither the base class nor Line2
    // releases it, so dispose it once, including its instanced GPU buffers.
    this.#geometry.dispose();
    this.#linePrepass.material.dispose();
    this.#line.material.dispose();

    const pickingMaterial = this.#line.userData.pickingMaterial as THREE.ShaderMaterial;
    pickingMaterial.dispose();
    this.#line.userData.pickingMaterial = undefined;

    super.dispose();
  }

  public override update(newMarker: Marker, receiveTime: bigint | undefined): void {
    super.update(newMarker, receiveTime);
    const marker = this.userData.marker;
    const pointsLength = marker.points.length;
    const lineWidth = marker.scale.x;
    const transparent = markerHasTransparency(marker);

    // Apply styles even while empty; comparing against the previous message
    // misses an alpha transition that happened while there were no segments.
    const matLinePrepass = this.#linePrepass.material as LineMaterialWithAlphaVertex;
    const matLine = this.#line.material as LineMaterialWithAlphaVertex;
    if (matLine.transparent !== transparent) {
      matLinePrepass.transparent = transparent;
      matLinePrepass.depthWrite = !transparent;
      matLinePrepass.needsUpdate = true;
      matLine.transparent = transparent;
      matLine.depthWrite = !transparent;
      matLine.needsUpdate = true;
    }
    matLinePrepass.lineWidth = lineWidth;
    matLine.lineWidth = lineWidth;
    this.#linePrepass.visible = pointsLength > 1;
    this.#line.visible = pointsLength > 1;
    const pickingMaterial = this.#line.userData.pickingMaterial as THREE.ShaderMaterial;
    pickingMaterial.uniforms["linewidth"]!.value = lineWidth * 1.2;

    if (this.#buffers.update(marker.points)) {
      this.#bindBuffers();
    }
    this.#geometry.instanceCount = this.#buffers.segmentCount;
    const { min, max, center, radius } = this.#buffers;
    this.#geometry.boundingBox ??= new THREE.Box3();
    this.#geometry.boundingBox.min.set(min.x, min.y, min.z);
    this.#geometry.boundingBox.max.set(max.x, max.y, max.z);
    this.#geometry.boundingSphere ??= new THREE.Sphere();
    this.#geometry.boundingSphere.center.set(center.x, center.y, center.z);
    this.#geometry.boundingSphere.radius = radius;

    if (this.#buffers.segmentCount === 0) {
      return;
    }
    this.#setColors(marker, pointsLength);
    markUpdated(this.#positionBuffer!, this.#buffers.segmentCount * 6);
    markUpdated(this.#colorBuffer!, this.#buffers.segmentCount * 8);
    markUpdated(this.#distanceBuffer!, this.#buffers.segmentCount * 2);
  }

  #bindBuffers(): void {
    // WebGL cannot resize an uploaded attribute. Release the old allocation
    // only when capacity grows, never for an ordinary update or path shrink.
    this.#geometry.dispose();
    const geometry = (this.#geometry = new LineGeometry());
    this.#linePrepass.geometry = geometry;
    this.#line.geometry = geometry;
    const positions = (this.#positionBuffer = new THREE.InstancedInterleavedBuffer(
      this.#buffers.positions,
      6,
      1,
    ));
    const colors = (this.#colorBuffer = new THREE.InstancedInterleavedBuffer(
      this.#buffers.colors,
      8,
      1,
    ));
    const distances = (this.#distanceBuffer = new THREE.InstancedInterleavedBuffer(
      this.#buffers.distances,
      2,
      1,
    ));
    positions.setUsage(THREE.DynamicDrawUsage);
    colors.setUsage(THREE.DynamicDrawUsage);
    distances.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("instanceStart", new THREE.InterleavedBufferAttribute(positions, 3, 0));
    geometry.setAttribute("instanceEnd", new THREE.InterleavedBufferAttribute(positions, 3, 3));
    geometry.setAttribute(
      "instanceColorStart",
      new THREE.InterleavedBufferAttribute(colors, 4, 0, true),
    );
    geometry.setAttribute(
      "instanceColorEnd",
      new THREE.InterleavedBufferAttribute(colors, 4, 4, true),
    );
    geometry.setAttribute(
      "instanceDistanceStart",
      new THREE.InterleavedBufferAttribute(distances, 1, 0),
    );
    geometry.setAttribute(
      "instanceDistanceEnd",
      new THREE.InterleavedBufferAttribute(distances, 1, 1),
    );
  }

  #setColors(marker: Marker, pointsLength: number): void {
    const colorBuffer = this.#buffers.colors;
    const color1: THREE.Vector4Tuple = tempTuple4;
    this._markerColorsToLinear(marker, pointsLength, (color2, ii) => {
      if (ii === 0) {
        copyTuple4(color2, color1);
        return;
      }
      const offset = (ii - 1) * 8;
      colorBuffer[offset + 0] = Math.floor(255 * color1[0]);
      colorBuffer[offset + 1] = Math.floor(255 * color1[1]);
      colorBuffer[offset + 2] = Math.floor(255 * color1[2]);
      colorBuffer[offset + 3] = Math.floor(255 * color1[3]);
      colorBuffer[offset + 4] = Math.floor(255 * color2[0]);
      colorBuffer[offset + 5] = Math.floor(255 * color2[1]);
      colorBuffer[offset + 6] = Math.floor(255 * color2[2]);
      colorBuffer[offset + 7] = Math.floor(255 * color2[3]);
      copyTuple4(color2, color1);
    });
  }
}

// Three r156 uses one updateRange per interleaved buffer. Keep attribute counts
// at capacity (the VAO caches that limit); instanceCount selects active segments.
function markUpdated(buffer: THREE.InstancedInterleavedBuffer, count: number): void {
  buffer.updateRange.offset = 0;
  buffer.updateRange.count = count;
  buffer.needsUpdate = true;
}

function copyTuple4(from: THREE.Vector4Tuple, to: THREE.Vector4Tuple): void {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
  to[3] = from[3];
}
