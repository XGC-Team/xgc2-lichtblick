// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";

import { RenderableMarker } from "./RenderableMarker";
import {
  makeLineMaterial,
  makeLinePrepassMaterial,
  makeLinePickingMaterial,
  markerHasTransparency,
} from "./materials";
import { DynamicLineGeometry } from "../../DynamicLineGeometry";
import type { IRenderer } from "../../IRenderer";
import { LineMaterialWithAlphaVertex } from "../../LineMaterialWithAlphaVertex";
import { Marker } from "../../ros";

const tempTuple4: THREE.Vector4Tuple = [0, 0, 0, 0];

/**
 * Element-wise point equality. Publishers re-publish whole paths every cycle,
 * usually with identical points; comparing a thousand xyz triples is
 * microseconds, while a redundant setPoints is a full GPU buffer re-upload.
 */
export function lineStripPointsEqual(
  a: readonly { x: number; y: number; z: number }[] | undefined,
  b: readonly { x: number; y: number; z: number }[],
): boolean {
  if (a?.length !== b.length) {
    return false;
  }
  return lineStripPointsRangeEqual(a, b, a.length);
}

/**
 * True when `next` is `prev` plus appended tail points — the append-only
 * history pattern of nav_msgs/Path-style strips — so only the tail needs
 * uploading. Equal-length arrays return false (handled by the skip path).
 */
export function lineStripPointsExtendedBy(
  prev: readonly { x: number; y: number; z: number }[],
  next: readonly { x: number; y: number; z: number }[],
): boolean {
  return next.length > prev.length && lineStripPointsRangeEqual(prev, next, prev.length);
}

function lineStripPointsRangeEqual(
  a: readonly { x: number; y: number; z: number }[],
  b: readonly { x: number; y: number; z: number }[],
  count: number,
): boolean {
  for (let i = 0; i < count; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.x !== pb.x || pa.y !== pb.y || pa.z !== pb.z) {
      return false;
    }
  }
  return true;
}

export class RenderableLineStrip extends RenderableMarker {
  #geometry: DynamicLineGeometry;
  #linePrepass: Line2;
  #line: Line2;
  #lastUploadedPoints: Marker["points"] | undefined;
  #lastUploadedColor: Marker["color"] | undefined;
  #lastUploadedColors: Marker["colors"] | undefined;

  public constructor(
    topic: string,
    marker: Marker,
    receiveTime: bigint | undefined,
    renderer: IRenderer,
  ) {
    super(topic, marker, receiveTime, renderer);

    this.#geometry = new DynamicLineGeometry();

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
    this.#linePrepass.material.dispose();
    this.#line.material.dispose();

    const pickingMaterial = this.#line.userData.pickingMaterial as THREE.ShaderMaterial;
    pickingMaterial.dispose();
    this.#line.userData.pickingMaterial = undefined;

    this.#geometry.dispose();
    super.dispose();
  }

  public override update(newMarker: Marker, receiveTime: bigint | undefined): void {
    super.update(newMarker, receiveTime);
    const marker = this.userData.marker;

    const pointsLength = marker.points.length;
    const lineWidth = marker.scale.x;
    const transparent = markerHasTransparency(marker);

    // Compare with material state, not the previous message: empty messages and
    // pooled renderables must not leave stale transparency when data returns.
    if (transparent !== this.#line.material.transparent) {
      this.#linePrepass.material.transparent = transparent;
      this.#linePrepass.material.depthWrite = !transparent;
      this.#linePrepass.material.needsUpdate = true;
      this.#line.material.transparent = transparent;
      this.#line.material.depthWrite = !transparent;
      this.#line.material.needsUpdate = true;
    }

    const matLinePrepass = this.#linePrepass.material as LineMaterialWithAlphaVertex;
    matLinePrepass.lineWidth = lineWidth;
    const matLine = this.#line.material as LineMaterialWithAlphaVertex;
    matLine.lineWidth = lineWidth;

    // Picking renders at 1.2x width; keep it in sync with the visible width.
    const pickingMaterial = this.#line.userData.pickingMaterial as THREE.ShaderMaterial;
    pickingMaterial.uniforms["linewidth"]!.value = lineWidth * 1.2;

    // Skip the GPU re-upload when the path itself has not changed; marker
    // messages are immutable, so keeping the reference is safe. A path that
    // only grew by appended tail points uploads just the new segments.
    const prevPoints = this.#lastUploadedPoints;
    let appendedFrom = 0; // Index of the first appended point; 0 when not appended
    if (lineStripPointsEqual(prevPoints, marker.points)) {
      // Identical path: nothing to upload.
    } else if (prevPoints != undefined && lineStripPointsExtendedBy(prevPoints, marker.points)) {
      this.#geometry.appendPoints(marker.points, prevPoints.length);
      this.#lastUploadedPoints = marker.points;
      appendedFrom = prevPoints.length;
    } else {
      this.#geometry.setPoints(marker.points, "strip");
      this.#lastUploadedPoints = marker.points;
    }
    const visible = this.#geometry.instanceCount > 0;
    this.#linePrepass.visible = visible;
    this.#line.visible = visible;
    if (visible) {
      // Endpoint colors chain from the previous point, so an append can seed
      // from the old end point and write only the new pairs. That reuses the
      // buffered prefix colors, which is only valid while every prefix point
      // keeps its color (marker.color and colors[0..appendedFrom-1] unchanged);
      // otherwise those buffered pairs are stale and all pairs are rewritten.
      const colorStart =
        appendedFrom > 1 && this.#prefixColorsUnchanged(marker, appendedFrom)
          ? appendedFrom - 1
          : 0;
      this.#setColors(marker, pointsLength, colorStart);
      this.#geometry.updateColors(colorStart);
      this.#lastUploadedColor = marker.color;
      this.#lastUploadedColors = marker.colors;
    }
  }

  #prefixColorsUnchanged(marker: Marker, prefixLength: number): boolean {
    const lastColor = this.#lastUploadedColor;
    const lastColors = this.#lastUploadedColors;
    if (lastColor == undefined || lastColors == undefined) {
      return false;
    }
    const color = marker.color;
    if (
      color.r !== lastColor.r ||
      color.g !== lastColor.g ||
      color.b !== lastColor.b ||
      color.a !== lastColor.a
    ) {
      return false;
    }
    const colors = marker.colors;
    for (let i = 0; i < prefixLength; i++) {
      const prev = lastColors[i];
      const next = colors[i];
      if (prev == undefined || next == undefined) {
        if (prev !== next) {
          return false;
        }
      } else if (prev.r !== next.r || prev.g !== next.g || prev.b !== next.b || prev.a !== next.a) {
        return false;
      }
    }
    return true;
  }

  #setColors(marker: Marker, pointsLength: number, startIndex = 0): void {
    const colorBuffer = this.#geometry.colorBuffer;
    const color1: THREE.Vector4Tuple = tempTuple4;
    color1[0] = 0;
    color1[1] = 0;
    color1[2] = 0;
    color1[3] = 0;
    this._markerColorsToLinear(
      marker,
      pointsLength,
      (color2, ii) => {
        if (ii === startIndex) {
          copyTuple4(color2, color1);
          return;
        }
        const i = ii - 1;
        const offset = i * 8;

        colorBuffer[offset + 0] = Math.floor(255 * color1[0]);
        colorBuffer[offset + 1] = Math.floor(255 * color1[1]);
        colorBuffer[offset + 2] = Math.floor(255 * color1[2]);
        colorBuffer[offset + 3] = Math.floor(255 * color1[3]);

        colorBuffer[offset + 4] = Math.floor(255 * color2[0]);
        colorBuffer[offset + 5] = Math.floor(255 * color2[1]);
        colorBuffer[offset + 6] = Math.floor(255 * color2[2]);
        colorBuffer[offset + 7] = Math.floor(255 * color2[3]);

        copyTuple4(color2, color1);
      },
      startIndex,
    );
  }
}

function copyTuple4(from: THREE.Vector4Tuple, to: THREE.Vector4Tuple): void {
  to[0] = from[0];
  to[1] = from[1];
  to[2] = from[2];
  to[3] = from[3];
}
