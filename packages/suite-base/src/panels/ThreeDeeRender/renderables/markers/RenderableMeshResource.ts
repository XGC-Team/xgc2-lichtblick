import { supportsOpaqueVisual, type UrdfVisualGeometryPart } from "../urdfVisualInstances";
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
  #mesh: THREE.Object3D | undefined;
  #material: THREE.MeshStandardMaterial | undefined;
  #visualInstancesChanged: ((source: RenderableMeshResource) => void) | undefined;
  #instanceParts: readonly UrdfVisualGeometryPart[] = [];
  #instanceSourceLoaded = false;
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

  /** The existing mesh owner has attached a complete, successfully loaded model. */
  public hasLoadedModel(): boolean {
    return this.#mesh != undefined || this.#instanceSourceLoaded;
  }

  public constructor(
    topic: string,
    marker: Marker,
    receiveTime: bigint | undefined,
    renderer: IRenderer,
    options?: {
      referenceUrl?: string;
      visualInstancesChanged?: (source: RenderableMeshResource) => void;
    },
  ) {
    super(topic, marker, receiveTime, renderer);

    this.#visualInstancesChanged = options?.visualInstancesChanged;
    if (this.#visualInstancesChanged == undefined)
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
    this.#material?.dispose();
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
    if (this.#material != undefined) {
      if (transparent !== this.#material.transparent) {
        this.#material.transparent = transparent;
        this.#material.depthWrite = !transparent;
        this.#material.needsUpdate = true;
      }

      rgbToThreeColor(this.#material.color, marker.color);
      this.#material.opacity = marker.color.a;
    }

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
          const { mesh, materials, instanceParts } = loaded;
          if (this.#updateId !== curUpdateId) {
            // The cache owns geometry and textures; only these materials are ours.
            materials.forEach((material) => {
              material.dispose();
            });
            return;
          }
          this.#instanceParts = instanceParts ?? [];
          this.#instanceSourceLoaded = instanceParts != undefined;
          this.#visualInstancesChanged?.(this);
          this.#mesh = mesh;
          this.#meshMaterials = materials;
          if (mesh != undefined) this.add(mesh);
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

  public getVisualInstanceParts(): readonly UrdfVisualGeometryPart[] {
    return this.#instanceParts;
  }
  public extendVisualBounds(box: THREE.Box3): void {
    const matrix = new THREE.Matrix4(),
      local = new THREE.Box3();
    for (const part of this.#instanceParts) {
      if (part.geometry.boundingBox == undefined) part.geometry.computeBoundingBox();
      matrix.makeScale(this.scale.x, this.scale.y, this.scale.z).multiply(part.visualMatrix);
      if (part.geometry.boundingBox != undefined)
        box.union(local.copy(part.geometry.boundingBox).applyMatrix4(matrix));
    }
  }

  #releaseMesh(): void {
    this.#instanceParts = [];
    this.#instanceSourceLoaded = false;
    this.#visualInstancesChanged?.(this);
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
  ): Promise<
    | {
        mesh: THREE.Object3D | undefined;
        materials: Set<THREE.Material>;
        instanceParts?: readonly UrdfVisualGeometryPart[];
      }
    | undefined
  > {
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

    if (this.#visualInstancesChanged != undefined) {
      const parts: UrdfVisualGeometryPart[] = [];
      const materials = new Set<THREE.Material>();
      const clones = new Map<THREE.Material, THREE.Material>();
      const markerColor = opts.useEmbeddedMaterials ? undefined : { ...this.userData.marker.color };
      const scaleSign = this.scale.x * this.scale.y * this.scale.z;
      const visit = (
        node: THREE.Object3D,
        parentMatrix: THREE.Matrix4,
        parentVisible = true,
      ): THREE.Object3D | undefined => {
        if ((node as THREE.Light).isLight) return undefined;
        const local = node.matrixAutoUpdate
          ? new THREE.Matrix4().compose(node.position, node.quaternion, node.scale)
          : node.matrix.clone();
        const visualMatrix = new THREE.Matrix4().multiplyMatrices(parentMatrix, local);
        const mesh = node instanceof THREE.Mesh ? node : undefined;
        const eligible =
          mesh != undefined &&
          parentVisible &&
          node.visible &&
          node.layers.mask === 1 &&
          supportsOpaqueVisual(mesh, markerColor) &&
          scaleSign * visualMatrix.determinant() > 0;
        if (eligible) {
          if (markerColor != undefined && mesh.geometry.attributes.normal == undefined)
            mesh.geometry.computeVertexNormals();
          parts.push({
            geometry: mesh.geometry,
            material: mesh.material as THREE.Material,
            markerColor,
            visualMatrix,
            renderOrder: mesh.renderOrder,
            castShadow: mesh.castShadow,
            receiveShadow: mesh.receiveShadow,
          });
        }
        const copy = eligible ? new THREE.Group() : node.clone(false);
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(local);
        copy.visible = node.visible;
        copy.layers.mask = node.layers.mask;
        if (!eligible && copy instanceof THREE.Mesh) {
          if (opts.useEmbeddedMaterials) {
            const clone = (original: THREE.Material) => {
              let owned = clones.get(original);
              if (owned == undefined) {
                owned = original.clone();
                clones.set(original, owned);
                materials.add(owned);
              }
              return owned;
            };
            copy.material = Array.isArray(copy.material)
              ? copy.material.map(clone)
              : clone(copy.material);
          } else {
            this.#material ??= makeStandardMaterial(this.userData.marker.color);
            copy.material = this.#material;
            if (copy.geometry.attributes.normal == undefined) copy.geometry.computeVertexNormals();
          }
        }
        for (const child of node.children) {
          const owned = visit(child, visualMatrix, parentVisible && node.visible);
          if (owned != undefined) copy.add(owned);
        }
        // Empty wrapper groups do not keep an eligible clone scene alive.
        return copy.children.length === 0 &&
          (eligible ||
            ((copy instanceof THREE.Group || copy instanceof THREE.Scene) && parts.length > 0))
          ? undefined
          : copy;
      };
      const fallback = visit(cachedModel, new THREE.Matrix4());
      if (fallback != undefined) removeLights(fallback);
      return { mesh: fallback, materials, instanceParts: parts };
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
        childMesh.material = this.#material!;
        if (childMesh.geometry.attributes.normal == undefined) {
          childMesh.geometry.computeVertexNormals();
        }
      }
    });

    return { mesh, materials: new Set(materials.values()) };
  }
}
