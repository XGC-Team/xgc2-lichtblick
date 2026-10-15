// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

/** Polygon-envelope lowering of the Euclidean ellipse tube. No inward offset sheets. */
export function createRingGeometry(
  radii: readonly [number, number],
  r: number,
): THREE.BufferGeometry {
  const [a, b] = radii;
  const hole = Math.min(a, b) - r;
  if (![a, b, r].every((v) => Number.isFinite(v) && v > 0) || hole <= 0) {
    throw new Error("Ring requires positive radii and tube radius smaller than both radii.");
  }
  const tolerance = Math.min(0.0005, r * 0.01, hole * 0.01);
  const major = Math.max(a, b);
  const requested = Math.ceil(Math.PI * Math.sqrt(major / (2 * tolerance)));
  const requestedSides = Math.ceil(Math.PI * Math.sqrt(r / (2 * tolerance)));
  const n = Math.max(32, 4 * Math.ceil(requested / 4));
  const m = Math.max(16, 4 * Math.ceil(requestedSides / 4));
  if (n > 8192 || m > 2048 || n * m > 4000000) {
    throw new Error("Ring preview precision exceeds backend capacity.");
  }
  const points: [number, number][] = [];
  const normals: [number, number][] = [];
  const supports: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = (2 * Math.PI * i) / n;
    points.push([a * Math.cos(u), b * Math.sin(u)]);
  }
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % n]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const length = Math.hypot(ex, ey);
    const normal: [number, number] = [ey / length, -ex / length];
    normals.push(normal);
    supports.push(normal[0] * p[0] + normal[1] * p[1]);
  }
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = Math.hypot(...points[i]!);
    const dx = points[i]![0] / base;
    const dy = points[i]![1] / base;
    for (let j = 0; j < m; j++) {
      const v = (2 * Math.PI * j) / m;
      const cosine = Math.cos(v);
      const s = r * Math.abs(cosine);
      let rho = base;
      if (j !== m / 4 && j !== (3 * m) / 4) {
        if (cosine < 0) {
          rho = Infinity;
          for (let k = 0; k < n; k++) {
            const dot = normals[k]![0] * dx + normals[k]![1] * dy;
            if (dot > 0) {
              rho = Math.min(rho, (supports[k]! - s) / dot);
            }
          }
        } else {
          for (let k = 0; k < n; k++) {
            const p = points[k]!;
            const q = points[(k + 1) % n]!;
            const projection = p[0] * dx + p[1] * dy;
            const perpendicular = p[0] * dy - p[1] * dx;
            const discriminant = s * s - perpendicular * perpendicular;
            if (discriminant >= 0) {
              rho = Math.max(rho, projection + Math.sqrt(discriminant));
            }
            const dot = normals[k]![0] * dx + normals[k]![1] * dy;
            if (dot > 0) {
              const candidate = (supports[k]! + s) / dot;
              const ex = q[0] - p[0];
              const ey = q[1] - p[1];
              const t =
                ((candidate * dx - p[0]) * ex + (candidate * dy - p[1]) * ey) / (ex * ex + ey * ey);
              if (t >= 0 && t <= 1) {
                rho = Math.max(rho, candidate);
              }
            }
          }
        }
      }
      positions.push(rho * dx, rho * dy, r * Math.sin(v));
      const p = i * m + j;
      const q = ((i + 1) % n) * m + j;
      const nextP = i * m + ((j + 1) % m);
      const nextQ = ((i + 1) % n) * m + ((j + 1) % m);
      indices.push(p, q, nextQ, p, nextQ, nextP);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const centerlineError = (major * ((2 * Math.PI) / n) ** 2) / 8;
  const h = hole - centerlineError;
  const radius = major + r;
  geometry.userData.ringApproximation = {
    centerlineError,
    // Conservative enclosure, not a claim that total surface error is 0.5 mm.
    surfaceErrorBound:
      centerlineError +
      ((radius ** 2 / h) * (major / Math.min(a, b)) * 2 * Math.PI) / n +
      ((radius / h + 1) * r * 2 * Math.PI) / m,
  };
  return geometry;
}
