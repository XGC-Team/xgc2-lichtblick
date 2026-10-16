// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { createGeometry } from "./geometry";
import type { SceneGeometry } from "./types";
import { trimSharedFaces } from "./visuals";

/**
 * K shared buffers for one accepted revision. Instances only borrow them.
 * Image-pane seam trim stores one derived buffer per model part, not per instance.
 * Drafts and previews construct a separate table and dispose it themselves.
 */
export class SceneGeometryTable {
  public readonly shapes: readonly SceneGeometry[];
  public readonly geometries: THREE.BufferGeometry[];
  #derived = new Map<string, THREE.BufferGeometry>();
  #edges = new Map<string, THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | undefined>();
  #disposed = false;

  public constructor(shapes: readonly SceneGeometry[]) {
    this.shapes = shapes;
    this.geometries = shapes.map((shape) => createGeometry(shape));
  }

  public shared(index: number): THREE.BufferGeometry {
    this.#live();
    const geometry = this.geometries[index];
    if (!geometry) {
      throw new Error("Compiled geometry index is out of range.");
    }
    return geometry;
  }

  public imagePart(
    key: string,
    index: number,
    blockers: THREE.Plane[][],
  ): THREE.BufferGeometry {
    this.#live();
    const existing = this.#derived.get(key);
    if (existing) {
      return existing;
    }
    const derived = trimSharedFaces(this.shared(index).clone(), blockers);
    this.#derived.set(key, derived);
    return derived;
  }

  public imageEdges(
    key: string,
    create: () => THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | undefined,
  ): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | undefined {
    this.#live();
    if (this.#edges.has(key)) {
      return this.#edges.get(key);
    }
    const edges = create();
    this.#edges.set(key, edges);
    return edges;
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const geometry of this.geometries) {
      geometry.dispose();
    }
    for (const geometry of this.#derived.values()) {
      geometry.dispose();
    }
    for (const edges of this.#edges.values()) {
      edges?.geometry.dispose();
      edges?.material.dispose();
    }
    this.#derived.clear();
    this.#edges.clear();
  }

  #live(): void {
    if (this.#disposed) {
      throw new Error("Scene geometry table is already disposed.");
    }
  }
}
