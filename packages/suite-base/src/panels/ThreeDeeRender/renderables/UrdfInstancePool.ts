// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import * as THREE from "three";

import { UrdfRobot, UrdfVisual } from "@lichtblick/den/urdf";

import type { IRenderer } from "../IRenderer";
import { LoadedModel } from "../ModelCache";
import { Renderable } from "../Renderable";
import { rgbToThreeColor } from "../color";
import { ColorRGBA, Vector3 } from "../ros";
import type { Pose } from "../transforms";
import {
  createGeometry as createCubeGeometry,
  createEdgesGeometry as createCubeEdgesGeometry,
} from "./markers/RenderableCube";
import {
  createGeometry as createCylinderGeometry,
  createEdgesGeometry as createCylinderEdgesGeometry,
} from "./markers/RenderableCylinder";
import { createGeometry as createSphereGeometry } from "./markers/RenderableSphere";
import { MeshStandardMaterialWithInstanceOpacity } from "./materials/MeshStandardMaterialWithInstanceOpacity";

const INITIAL_CAPACITY = 4;

/**
 * Instance matrices are Float32 while robot roots can sit at large map
 * coordinates. Like Axis.setPoses(), every batch rebases its Object3D near the
 * data and stores only origin-relative instance matrices. The origin snaps to
 * a power-of-two grid so minor robot motion does not force a full-batch
 * rewrite; 64m cells leave micrometer fp32 resolution inside a cell.
 */
const REBASE_GRID = 64;

const ZERO_MATRIX = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const IDENTITY_MATRIX = new THREE.Matrix4();

const tempColor = new THREE.Color();
const tempMatrix = new THREE.Matrix4();
const tempOrigin = new THREE.Vector3();

export type UrdfPrimitiveKind = "box" | "cylinder" | "sphere";

/** One pool instance: a slot in one batch's InstancedMesh. */
export type PoolSlot = {
  batch: UrdfInstanceBatch;
  index: number;
  /**
   * Constant transform of the model leaf within its model root; undefined (and
   * treated as identity) for primitive batches.
   */
  local: THREE.Matrix4 | undefined;
};

export type PrimitiveSlotSpec = {
  kind: UrdfPrimitiveKind;
  transparent: boolean;
  /** Baked marker color (`getColor(visual, robot) ?? fallbackColor ?? DEFAULT_COLOR`). */
  color: ColorRGBA;
  owner: Renderable;
};

export type MeshSlotSpec = {
  /** Resolved absolute mesh URL; the model identity shared across robots. */
  url: string;
  referenceUrl: string | undefined;
  embedded: boolean;
  transparent: boolean;
  color: ColorRGBA;
  owner: Renderable;
  reportError: (err: Error) => void;
};

export type AcquireMeshResult =
  | { status: "ready"; slots: PoolSlot[] }
  /** The model failed to load; the caller reports the settings error. */
  | { status: "failed" }
  /**
   * The model contains line/point renderables or multi-material meshes that
   * InstancedMesh cannot reproduce; the caller keeps the legacy per-link path.
   */
  | { status: "nonMesh" };

export type AcquireMeshOutcome =
  | AcquireMeshResult
  | { status: "pending"; promise: Promise<AcquireMeshResult> };

/** Per-visual pooled state for one static link of one robot. */
export type StaticVisualState = {
  /** Original parsed visual, used to create legacy children on migration. */
  visual: UrdfVisual;
  /** Index within the link's visuals/colliders array; keeps legacy child names stable. */
  visualIndex: number;
  /** Unscaled visual origin; the layer scale is folded into the instance matrix. */
  pose: Pose;
  /** Unscaled geometry dimensions (box size, cylinder/sphere diameters, mesh scale). */
  dims: Vector3;
  /** Baked color: `getColor(visual, robot) ?? fallbackColor ?? DEFAULT_COLOR`. */
  color: ColorRGBA;
  meshUrl: string | undefined;
  embedded: boolean;
  slots: PoolSlot[];
  /**
   * A permanent legacy child for visuals whose model cannot be instanced
   * (nonMesh fallback). Not affected by selection/rootedness migration.
   */
  legacyChild: Renderable | undefined;
  /** False while the visual is migrated to the legacy path; stale async acquires release. */
  pooled: boolean;
  /** Stale-acquire guard, incremented per acquireMeshSlots call. */
  loadId: number;
};

/** Per-link pooled state for one static link of one robot. */
export type StaticLinkState = {
  frameId: string;
  /** rootedIdentityPose memo key for the live root→link transform. */
  memoKey: THREE.Object3D;
  visuals: StaticVisualState[];
  /** Migration-created legacy children, while the link renders per-link. */
  legacyChildren: Renderable[] | undefined;
  /** Last composed root pose values (px,py,pz,qx,qy,qz,qw), or undefined when never written. */
  lastRoot: readonly number[] | undefined;
  /** Last composed root→link values, same layout. */
  lastRel: readonly number[] | undefined;
  /** Forces a matrix rewrite on the next update (visibility restore, slot assignment). */
  forceDirty: boolean;
};

/** Pooled static-subtree state of one robot (one URDF layer). */
export type RobotInstancingState = {
  staticLinks: StaticLinkState[];
  robot: UrdfRobot;
  baseUrl: string | undefined;
  fallbackColor: ColorRGBA | undefined;
  released: boolean;
};

type FlattenedModel = {
  leaves: {
    geometry: THREE.BufferGeometry;
    material: THREE.Material;
    /** Leaf transform relative to the model root, including the root's own. */
    local: THREE.Matrix4;
  }[];
  hasNonMesh: boolean;
};

type SlotRecord = {
  owner: Renderable;
  live: boolean;
  dirty: boolean;
  /** Latest composed world matrix (rebase-origin independent). */
  world: THREE.Matrix4;
};

/**
 * One draw call (plus one for the optional instanced outline) for every robot
 * sharing this batch key: a primitive kind × transparency class, or one
 * mesh-URL leaf × material class. Selection never flips layers on the batch —
 * a selected robot migrates back to per-link renderables instead.
 */
export class UrdfInstanceBatch extends Renderable {
  public override readonly pickableInstances = true;
  #mesh: THREE.InstancedMesh;
  #geometry: THREE.BufferGeometry;
  #geometryOwned: boolean;
  #material: THREE.Material;
  #instanceOpacity: THREE.InstancedBufferAttribute | undefined;
  #outline: THREE.LineSegments | undefined;
  #outlineGeometry: THREE.InstancedBufferGeometry | undefined;
  #outlineEdges: THREE.BufferGeometry | undefined;
  #capacity: number;
  #highWater = 0;
  #freeList: number[] = [];
  #records: (SlotRecord | undefined)[] = [];
  #origin = new THREE.Vector3();
  #disposed = false;

  public constructor(
    name: string,
    renderer: IRenderer,
    recipe: {
      geometry: THREE.BufferGeometry;
      geometryOwned: boolean;
      material: THREE.Material;
      perInstanceColor: boolean;
      perInstanceOpacity: boolean;
      /** Shared EdgesGeometry source for an instanced outline (box/cylinder). */
      edges?: THREE.BufferGeometry;
    },
  ) {
    super(name, renderer, {
      receiveTime: 0n,
      messageTime: 0n,
      frameId: "",
      pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      settingsPath: [],
      settings: { visible: true, frameLocked: true },
    });
    this.matrixAutoUpdate = false;
    this.#geometry = recipe.geometry;
    this.#geometryOwned = recipe.geometryOwned;
    this.#material = recipe.material;
    this.#capacity = INITIAL_CAPACITY;

    this.#mesh = new THREE.InstancedMesh(this.#geometry, this.#material, this.#capacity);
    this.#mesh.frustumCulled = false;
    this.#mesh.castShadow = true;
    this.#mesh.receiveShadow = true;
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (recipe.perInstanceColor) {
      this.#mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(this.#capacity * 3),
        3,
      );
      this.#mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    if (recipe.perInstanceOpacity) {
      // The geometry is batch-owned (cloned), so the attribute is ours.
      this.#instanceOpacity = new THREE.InstancedBufferAttribute(
        new Float32Array(this.#capacity),
        1,
      );
      this.#instanceOpacity.setUsage(THREE.DynamicDrawUsage);
      this.#geometry.setAttribute("instanceOpacity", this.#instanceOpacity);
    }
    this.#mesh.count = 0;
    this.#mesh.visible = false;
    this.add(this.#mesh);

    if (recipe.edges) {
      this.#outlineEdges = recipe.edges;
      this.#outlineGeometry = new THREE.InstancedBufferGeometry();
      (this.#outlineGeometry as THREE.BufferGeometry).copy(recipe.edges);
      this.#outlineGeometry.setAttribute("instanceMatrix", this.#mesh.instanceMatrix);
      this.#outlineGeometry.instanceCount = 0;
      this.#outline = new THREE.LineSegments(
        this.#outlineGeometry,
        renderer.instancedOutlineMaterial,
      );
      this.#outline.frustumCulled = false;
      this.#outline.userData.picking = false;
      this.add(this.#outline);
    }
  }

  /** Test/debug introspection: the current instanced draw mesh (replaced on growth). */
  public instancedMesh(): THREE.InstancedMesh {
    return this.#mesh;
  }

  /** Slot indices currently owned by robots (holes excluded). */
  public allocatedCount(): number {
    return this.#highWater - this.#freeList.length;
  }

  public acquireSlot(owner: Renderable): number {
    if (this.#disposed) {
      throw new Error("UrdfInstanceBatch is disposed");
    }
    let index: number;
    const reused = this.#freeList.pop();
    if (reused != undefined) {
      index = reused;
    } else {
      index = this.#highWater++;
      if (index >= this.#capacity) {
        this.#grow(Math.max(index + 1, this.#capacity * 2));
      }
    }
    this.#records[index] = { owner, live: false, dirty: false, world: new THREE.Matrix4() };
    this.#updateCounts();
    return index;
  }

  public releaseSlot(index: number): void {
    if (this.#disposed || this.#records[index] == undefined) {
      return;
    }
    this.#records[index] = undefined;
    this.#freeList.push(index);
    // Zero-scale matrices render nothing; writes land immediately so releases
    // between frames (layer removal, pick loops) never show stale geometry.
    this.#writeZeroMatrix(index);
    this.#updateCounts();
  }

  /** Store the latest world matrix; the origin-relative write happens in flush(). */
  public writeSlot(index: number, world: THREE.Matrix4): void {
    const record = this.#records[index];
    if (this.#disposed || !record) {
      return;
    }
    record.world.copy(world);
    record.live = true;
    record.dirty = true;
  }

  /** Hide one instance immediately, without waiting for the next flush. */
  public hideSlot(index: number): void {
    const record = this.#records[index];
    if (this.#disposed || !record) {
      return;
    }
    record.live = false;
    this.#writeZeroMatrix(index);
  }

  /** Per-instance RGB and alpha for non-embedded batches. */
  public writeSlotAppearance(index: number, color: ColorRGBA): void {
    const instanceColor = this.#mesh.instanceColor;
    if (this.#disposed || !instanceColor) {
      return;
    }
    rgbToThreeColor(tempColor, color).toArray(instanceColor.array as Float32Array, index * 3);
    instanceColor.needsUpdate = true;
    if (this.#instanceOpacity) {
      this.#instanceOpacity.setX(index, color.a);
      this.#instanceOpacity.needsUpdate = true;
    }
  }

  public override instanceOwner(instanceId: number): Renderable | undefined {
    return this.#records[instanceId]?.owner;
  }

  /**
   * Rebase the batch origin near the live data (fp32 precision, Axis
   * precedent) and upload dirty instance matrices. Returns true when the batch
   * holds no slots anymore and should be disposed by the pool.
   */
  public flush(): boolean {
    if (this.#disposed) {
      return true;
    }
    if (this.allocatedCount() === 0) {
      return true;
    }
    let firstLive: SlotRecord | undefined;
    for (const record of this.#records) {
      if (record?.live === true) {
        firstLive = record;
        break;
      }
    }
    this.#mesh.visible = firstLive != undefined;
    if (this.#outline) {
      this.#outline.visible = this.#mesh.visible;
    }
    let originChanged = false;
    if (firstLive) {
      const e = firstLive.world.elements;
      tempOrigin.set(snap(e[12]!), snap(e[13]!), snap(e[14]!));
      if (!tempOrigin.equals(this.#origin)) {
        originChanged = true;
        this.#origin.copy(tempOrigin);
        this.position.copy(tempOrigin);
        this.updateMatrix();
      }
    }
    let wrote = false;
    for (let i = 0; i < this.#highWater; i++) {
      const record = this.#records[i];
      if (record?.live !== true || (!record.dirty && !originChanged)) {
        continue;
      }
      tempMatrix.copy(record.world);
      tempMatrix.elements[12]! -= this.#origin.x;
      tempMatrix.elements[13]! -= this.#origin.y;
      tempMatrix.elements[14]! -= this.#origin.z;
      this.#mesh.setMatrixAt(i, tempMatrix);
      record.dirty = false;
      wrote = true;
    }
    if (wrote) {
      const attribute = this.#mesh.instanceMatrix;
      attribute.updateRange.offset = 0;
      attribute.updateRange.count = this.#highWater * 16;
      attribute.needsUpdate = true;
      // GPU picking uses the same instances; invalidate cached CPU raycast
      // bounds too. Frustum culling stays disabled.
      this.#mesh.boundingBox = null;
      this.#mesh.boundingSphere = null;
    }
    return false;
  }

  public override dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    // InstancedMesh.dispose() only releases the instance buffers, never the
    // geometry/material. Shared geometries (primitive units, ModelCache mesh
    // leaves) outlive the batch; only cloned geometries are disposed here.
    this.#mesh.dispose();
    this.#material.dispose();
    if (this.#geometryOwned) {
      this.#geometry.dispose();
    }
    this.#outlineGeometry?.dispose();
    this.removeFromParent();
    super.dispose();
  }

  #updateCounts(): void {
    this.#mesh.count = this.#highWater;
    if (this.#outlineGeometry) {
      this.#outlineGeometry.instanceCount = this.#highWater;
    }
  }

  #writeZeroMatrix(index: number): void {
    const attribute = this.#mesh.instanceMatrix;
    this.#mesh.setMatrixAt(index, ZERO_MATRIX);
    attribute.updateRange.offset = 0;
    attribute.updateRange.count = this.#highWater * 16;
    attribute.needsUpdate = true;
    this.#mesh.boundingBox = null;
    this.#mesh.boundingSphere = null;
  }

  #grow(newCapacity: number): void {
    const previous = this.#mesh;
    const mesh = new THREE.InstancedMesh(this.#geometry, this.#material, newCapacity);
    mesh.frustumCulled = previous.frustumCulled;
    mesh.castShadow = previous.castShadow;
    mesh.receiveShadow = previous.receiveShadow;
    mesh.count = previous.count;
    mesh.visible = previous.visible;
    (mesh.instanceMatrix.array as Float32Array).set(previous.instanceMatrix.array);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (previous.instanceColor) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(newCapacity * 3),
        3,
      );
      (mesh.instanceColor.array as Float32Array).set(previous.instanceColor.array);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    // Selection sets layers on descendants. Do not lose the highlight on growth.
    mesh.layers.mask = previous.layers.mask;
    this.remove(previous);
    this.add(mesh);
    this.#mesh = mesh;
    // Only instance storage is owned here. Geometry and the batch material
    // transfer to the replacement mesh until final disposal.
    previous.dispose();

    if (this.#instanceOpacity) {
      const previousOpacity = this.#instanceOpacity;
      this.#instanceOpacity = new THREE.InstancedBufferAttribute(
        new Float32Array(newCapacity),
        1,
      );
      (this.#instanceOpacity.array as Float32Array).set(previousOpacity.array);
      this.#instanceOpacity.setUsage(THREE.DynamicDrawUsage);
      this.#geometry.setAttribute("instanceOpacity", this.#instanceOpacity);
    }

    // THREE.js does not track a replaced instanceMatrix attribute on
    // InstancedBufferGeometry, so the outline geometry is rebuilt.
    if (this.#outline && this.#outlineEdges) {
      this.#outlineGeometry?.dispose();
      this.#outlineGeometry = new THREE.InstancedBufferGeometry();
      (this.#outlineGeometry as THREE.BufferGeometry).copy(this.#outlineEdges);
      this.#outlineGeometry.setAttribute("instanceMatrix", mesh.instanceMatrix);
      this.#outlineGeometry.instanceCount = previous.count;
      this.#outline.geometry = this.#outlineGeometry;
    }
  }
}

/**
 * Shared InstancedMesh pools for the STATIC link subtrees of same-model URDF
 * robots. Draw calls for static parts go from O(robots × parts) to O(unique
 * parts): one batch per primitive kind × transparency class, plus one batch
 * per mesh-URL leaf × material class. The per-robot layer scale is folded into
 * each instance matrix (matching the legacy Object3D T·R·S composition
 * exactly), so scale never fragments batch keys.
 */
export class UrdfInstancePool {
  #renderer: IRenderer;
  #parent: THREE.Object3D;
  #batches = new Map<string, UrdfInstanceBatch>();
  #models = new Map<string, Promise<FlattenedModel | undefined>>();
  #resolvedModels = new Map<string, FlattenedModel | undefined>();
  #disposed = false;

  public constructor(renderer: IRenderer, parent: THREE.Object3D) {
    this.#renderer = renderer;
    this.#parent = parent;
  }

  /** Test/debug introspection: the live batches. */
  public batches(): readonly UrdfInstanceBatch[] {
    return Array.from(this.#batches.values());
  }

  public acquirePrimitiveSlot(spec: PrimitiveSlotSpec): PoolSlot {
    const key = `primitive:${spec.kind}:${spec.transparent ? "alpha" : "opaque"}`;
    const batch = this.#batch(key, () => this.#createPrimitiveBatch(key, spec));
    const index = batch.acquireSlot(spec.owner);
    batch.writeSlotAppearance(index, spec.color);
    return { batch, index, local: undefined };
  }

  /**
   * Acquire one slot per leaf of the cached model. Resolves synchronously when
   * the model has been flattened before (selection migration back into the
   * pool), otherwise kicks the shared ModelCache load and reports "pending".
   */
  public acquireMeshSlots(spec: MeshSlotSpec): AcquireMeshOutcome {
    if (this.#disposed) {
      return { status: "failed" };
    }
    const resolved = this.#resolvedModels.get(spec.url);
    if (resolved != undefined) {
      return this.#acquireFromFlattened(spec, resolved);
    }
    let promise = this.#models.get(spec.url);
    if (!promise) {
      promise = this.#renderer.modelCache
        .load(spec.url, { referenceUrl: spec.referenceUrl }, spec.reportError)
        .then((model) => {
          const flattened = model ? flattenModel(model) : undefined;
          this.#resolvedModels.set(spec.url, flattened);
          return flattened;
        });
      this.#models.set(spec.url, promise);
    }
    return {
      status: "pending",
      promise: promise.then((flattened) => {
        if (this.#disposed || !flattened) {
          return { status: "failed" };
        }
        return this.#acquireFromFlattened(spec, flattened);
      }),
    };
  }

  public releaseSlots(slots: readonly PoolSlot[]): void {
    for (const slot of slots) {
      slot.batch.releaseSlot(slot.index);
    }
  }

  public hideSlots(slots: readonly PoolSlot[]): void {
    for (const slot of slots) {
      slot.batch.hideSlot(slot.index);
    }
  }

  /** Rebase and upload dirty instances; dispose batches that no robot uses. */
  public flush(): void {
    for (const [key, batch] of this.#batches) {
      if (batch.flush()) {
        batch.dispose();
        this.#batches.delete(key);
      }
    }
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const batch of this.#batches.values()) {
      batch.dispose();
    }
    this.#batches.clear();
    this.#models.clear();
    this.#resolvedModels.clear();
  }

  #acquireFromFlattened(spec: MeshSlotSpec, flattened: FlattenedModel): AcquireMeshResult {
    if (flattened.hasNonMesh) {
      return { status: "nonMesh" };
    }
    const slots: PoolSlot[] = [];
    for (let leafIndex = 0; leafIndex < flattened.leaves.length; leafIndex++) {
      const leaf = flattened.leaves[leafIndex]!;
      const key = spec.embedded
        ? `mesh:${spec.url}:${leafIndex}:embedded`
        : `mesh:${spec.url}:${leafIndex}:${spec.transparent ? "flat-alpha" : "flat-opaque"}`;
      const batch = this.#batch(key, () => this.#createMeshLeafBatch(key, leaf, spec));
      const index = batch.acquireSlot(spec.owner);
      if (!spec.embedded) {
        batch.writeSlotAppearance(index, spec.color);
      }
      slots.push({ batch, index, local: leaf.local });
    }
    return { status: "ready", slots };
  }

  #batch(key: string, create: () => UrdfInstanceBatch): UrdfInstanceBatch {
    if (this.#disposed) {
      throw new Error("UrdfInstancePool is disposed");
    }
    let batch = this.#batches.get(key);
    if (!batch) {
      batch = create();
      this.#batches.set(key, batch);
      this.#parent.add(batch);
    }
    return batch;
  }

  #createPrimitiveBatch(key: string, spec: PrimitiveSlotSpec): UrdfInstanceBatch {
    const lod = this.#renderer.maxLod;
    const sharedGeometry = this.#renderer.sharedGeometry;
    let geometry: THREE.BufferGeometry;
    let edges: THREE.BufferGeometry | undefined;
    if (spec.kind === "box") {
      geometry = sharedGeometry.getGeometry(`UrdfInstanceBatch-box`, createCubeGeometry);
      edges = sharedGeometry.getGeometry(`UrdfInstanceBatch-box-edges`, () =>
        createCubeEdgesGeometry(geometry as THREE.BoxGeometry),
      );
    } else if (spec.kind === "cylinder") {
      geometry = sharedGeometry.getGeometry(`UrdfInstanceBatch-cylinder-${lod}`, () =>
        createCylinderGeometry(lod),
      );
      edges = sharedGeometry.getGeometry(`UrdfInstanceBatch-cylinder-edges-${lod}`, () =>
        createCylinderEdgesGeometry(geometry as THREE.CylinderGeometry),
      );
    } else {
      // RenderableSphere has no outline; the instanced batch matches it.
      geometry = sharedGeometry.getGeometry(`UrdfInstanceBatch-sphere-${lod}`, () =>
        createSphereGeometry(lod),
      );
    }
    return new UrdfInstanceBatch(key, this.#renderer, {
      // Transparent batches attach a per-instance alpha attribute, which must
      // not leak into the shared unit geometry: they get a clone.
      geometry: spec.transparent ? geometry.clone() : geometry,
      geometryOwned: spec.transparent,
      material: spec.transparent
        ? new MeshStandardMaterialWithInstanceOpacity({
            metalness: 0,
            roughness: 1,
            dithering: true,
            transparent: true,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({ metalness: 0, roughness: 1, dithering: true }),
      perInstanceColor: true,
      perInstanceOpacity: spec.transparent,
      edges,
    });
  }

  #createMeshLeafBatch(
    key: string,
    leaf: { geometry: THREE.BufferGeometry; material: THREE.Material },
    spec: MeshSlotSpec,
  ): UrdfInstanceBatch {
    if (spec.embedded) {
      // One clone per batch, not per robot; the URDF/marker color does not
      // apply to embedded materials, matching RenderableMeshResource.
      return new UrdfInstanceBatch(key, this.#renderer, {
        geometry: leaf.geometry,
        geometryOwned: false,
        material: leaf.material.clone(),
        perInstanceColor: false,
        perInstanceOpacity: false,
      });
    }
    if (leaf.geometry.attributes.normal == undefined) {
      // Same shared-geometry fixup RenderableMeshResource applies to its clones.
      leaf.geometry.computeVertexNormals();
    }
    return new UrdfInstanceBatch(key, this.#renderer, {
      geometry: spec.transparent ? leaf.geometry.clone() : leaf.geometry,
      geometryOwned: spec.transparent,
      material: spec.transparent
        ? new MeshStandardMaterialWithInstanceOpacity({
            metalness: 0,
            roughness: 1,
            dithering: true,
            transparent: true,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({ metalness: 0, roughness: 1, dithering: true }),
      perInstanceColor: true,
      perInstanceOpacity: spec.transparent,
    });
  }
}

function snap(value: number): number {
  return Math.round(value / REBASE_GRID) * REBASE_GRID;
}

/**
 * Flatten a cached model into its mesh leaves with model-root-relative
 * transforms, so every leaf becomes one instanced batch. Models with line,
 * point, sprite, or multi-material renderables are reported via hasNonMesh and
 * keep the legacy per-link path; lights are ignored exactly like
 * RenderableMeshResource's removeLights().
 */
function flattenModel(model: LoadedModel): FlattenedModel {
  const leaves: FlattenedModel["leaves"] = [];
  let hasNonMesh = false;
  const walk = (node: THREE.Object3D, parentMatrix: THREE.Matrix4): void => {
    if (node.matrixAutoUpdate) {
      node.updateMatrix();
    }
    const world = new THREE.Matrix4().multiplyMatrices(parentMatrix, node.matrix);
    if (node instanceof THREE.Mesh) {
      if (Array.isArray(node.material)) {
        hasNonMesh = true;
      } else {
        leaves.push({ geometry: node.geometry, material: node.material, local: world });
      }
    } else if (
      node instanceof THREE.Line ||
      node instanceof THREE.Points ||
      node instanceof THREE.Sprite
    ) {
      hasNonMesh = true;
    }
    for (const child of node.children) {
      walk(child, world);
    }
  };
  walk(model, IDENTITY_MATRIX);
  return { leaves, hasNonMesh };
}
