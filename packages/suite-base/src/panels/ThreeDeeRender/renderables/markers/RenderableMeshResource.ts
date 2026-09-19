// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as THREE from "three";

import { EDGE_LINE_SEGMENTS_NAME } from "@lichtblick/suite-base/panels/ThreeDeeRender/ModelCache";

import { RenderableMarker } from "./RenderableMarker";
import { makeStandardMaterial } from "./materials";
import type { IRenderer } from "../../IRenderer";
import { rgbToThreeColor } from "../../color";
import { Marker } from "../../ros";
import { removeLights } from "../models";

const MESH_FETCH_FAILED = "MESH_FETCH_FAILED";

export class RenderableMeshResource extends RenderableMarker {
  #mesh: THREE.Group | THREE.Scene | undefined;
  #material: THREE.MeshStandardMaterial;
  #referenceUrl: string | undefined;
  #meshMaterials = new Set<THREE.Material>();

  /** Track updates to avoid race conditions when asynchronously loading models */
  #updateId = 0;
  #disposed = false;
  #loading: Promise<void> = Promise.resolve();

  /** Resolves after the current mesh has attached or its settings error is recorded. */
  public async settleLoading(): Promise<void> {
    let loading: Promise<void>;
    do {
      loading = this.#loading;
      await loading;
    } while (loading !== this.#loading);
  }

  public constructor(
    topic: string,
    marker: Marker,
    receiveTime: bigint | undefined,
    renderer: IRenderer,
    options?: { referenceUrl?: string },
  ) {
    super(topic, marker, receiveTime, renderer);

    this.#material = makeStandardMaterial(marker.color);
    this.#referenceUrl = options?.referenceUrl;
    this.update(marker, receiveTime, true);
  }

  public override dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    ++this.#updateId;
    this.#releaseMesh();
    this.#material.dispose();
    super.dispose();
  }

  public override update(
    newMarker: Marker,
    receiveTime: bigint | undefined,
    // eslint-disable-next-line @lichtblick/no-boolean-parameters
    forceLoad?: boolean,
  ): void {
    if (this.#disposed) {
      return;
    }
    const prevMarker = this.userData.marker;
    super.update(newMarker, receiveTime);
    const marker = this.userData.marker;

    const transparent = marker.color.a < 1;
    if (transparent !== this.#material.transparent) {
      this.#material.transparent = transparent;
      this.#material.depthWrite = !transparent;
      this.#material.needsUpdate = true;
    }

    rgbToThreeColor(this.#material.color, marker.color);
    this.#material.opacity = marker.color.a;

    if (forceLoad === true || marker.mesh_resource !== prevMarker.mesh_resource) {
      const curUpdateId = ++this.#updateId;

      const opts = { useEmbeddedMaterials: marker.mesh_use_embedded_materials };
      const errors = this.renderer.settings.errors;
      this.#releaseMesh();
      this.#loading = this.#loadModel(marker.mesh_resource, opts, curUpdateId)
        .then((loaded) => {
          if (!loaded) {
            return;
          }
          const { mesh, materials } = loaded;
          if (this.#updateId !== curUpdateId) {
            // The cache owns geometry and textures; only these materials are ours.
            materials.forEach((material) => {
              material.dispose();
            });
            return;
          }
          this.#mesh = mesh;
          this.#meshMaterials = materials;
          this.add(mesh);
          this.#updateOutlineVisibility();

          // Remove any mesh fetch error message since loading was successful
          this.renderer.settings.errors.remove(this.userData.settingsPath, MESH_FETCH_FAILED);
          // Render a new frame now that the model is loaded
          this.renderer.queueAnimationFrame();
        })
        .catch((err: unknown) => {
          if (this.#updateId !== curUpdateId) {
            return;
          }
          errors.add(
            this.userData.settingsPath,
            MESH_FETCH_FAILED,
            `Unhandled error loading mesh from "${marker.mesh_resource}": ${(err as Error).message}`,
          );
        });
    }
    this.#updateOutlineVisibility();

    this.scale.set(marker.scale.x, marker.scale.y, marker.scale.z);
  }

  #releaseMesh(): void {
    if (this.#mesh) {
      this.remove(this.#mesh);
      this.#mesh = undefined;
    }
    this.#meshMaterials.forEach((material) => {
      material.dispose();
    });
    this.#meshMaterials.clear();
  }

  #updateOutlineVisibility(): void {
    const showOutlines = this.getSettings()?.showOutlines ?? true;
    this.traverse((lineSegments) => {
      // Want to avoid picking up the LineSegments from the model itself
      // only update line segments that we've added with the special name
      if (
        lineSegments instanceof THREE.LineSegments &&
        lineSegments.name === EDGE_LINE_SEGMENTS_NAME
      ) {
        lineSegments.visible = showOutlines;
      }
    });
  }

  async #loadModel(
    url: string,
    opts: { useEmbeddedMaterials: boolean },
    updateId: number,
  ): Promise<{ mesh: THREE.Group | THREE.Scene; materials: Set<THREE.Material> } | undefined> {
    const cachedModel = await this.renderer.modelCache.load(
      url,
      { referenceUrl: this.#referenceUrl },
      (err) => {
        if (this.#updateId !== updateId) {
          return;
        }
        this.renderer.settings.errors.add(
          this.userData.settingsPath,
          MESH_FETCH_FAILED,
          `Error loading mesh from "${url}": ${err.message}`,
        );
      },
    );

    if (this.#updateId !== updateId) {
      return undefined;
    }

    if (!cachedModel) {
      if (!this.renderer.settings.errors.hasError(this.userData.settingsPath, MESH_FETCH_FAILED)) {
        this.renderer.settings.errors.add(
          this.userData.settingsPath,
          MESH_FETCH_FAILED,
          `Failed to load mesh from "${url}"`,
        );
      }
      return undefined;
    }

    const mesh = cachedModel.clone(true);
    removeLights(mesh);
    const materials = new Map<THREE.Material, THREE.Material>();
    const cloneMaterial = (original: THREE.Material) => {
      let owned = materials.get(original);
      if (!owned) {
        owned = original.clone();
        materials.set(original, owned);
      }
      return owned;
    };
    mesh.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const childMesh = child as THREE.Mesh;
      if (opts.useEmbeddedMaterials) {
        childMesh.material = Array.isArray(childMesh.material)
          ? childMesh.material.map(cloneMaterial)
          : cloneMaterial(childMesh.material);
      } else {
        // Do not dispose the cache's embedded materials or texture maps.
        childMesh.material = this.#material;
        if (childMesh.geometry.attributes.normal == undefined) {
          childMesh.geometry.computeVertexNormals();
        }
      }
    });

    return { mesh, materials: new Set(materials.values()) };
  }
}
