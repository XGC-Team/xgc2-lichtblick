// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { SceneEntity, SceneEntityDeletion, SceneEntityDeletionType } from "@foxglove/schemas";

import { toNanoSec } from "@lichtblick/rostime";

import { PrimitivePool } from "./primitives/PrimitivePool";
import { RenderableArrows } from "./primitives/RenderableArrows";
import { RenderableCubes } from "./primitives/RenderableCubes";
import { RenderableCylinders } from "./primitives/RenderableCylinders";
import { RenderableLines } from "./primitives/RenderableLines";
import { RenderableModels } from "./primitives/RenderableModels";
import { RenderableSpheres } from "./primitives/RenderableSpheres";
import { RenderableTexts } from "./primitives/RenderableTexts";
import { RenderableTriangles } from "./primitives/RenderableTriangles";
import { ALL_PRIMITIVE_TYPES, PrimitiveType } from "./primitives/constants";
import { hashSceneEntityContent } from "./sceneEntityHash";
import { missingTransformMessage, MISSING_TRANSFORM } from "./transforms";
import type { IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { LayerSettingsEntity } from "../settings";
import { updatePose } from "../updatePose";

const INVALID_DELETION_TYPE = "INVALID_DELETION_TYPE";

export type EntityTopicUserData = BaseUserData & {
  topic: string;
  settings: LayerSettingsEntity;
};

type EntityRenderables = {
  [PrimitiveType.CUBES]?: RenderableCubes;
  [PrimitiveType.MODELS]?: RenderableModels;
  [PrimitiveType.LINES]?: RenderableLines;
  [PrimitiveType.CYLINDERS]?: RenderableCylinders;
  [PrimitiveType.ARROWS]?: RenderableArrows;
  [PrimitiveType.SPHERES]?: RenderableSpheres;
  [PrimitiveType.TEXTS]?: RenderableTexts;
  [PrimitiveType.TRIANGLES]?: RenderableTriangles;
};

const PRIMITIVE_KEYS = {
  [PrimitiveType.CUBES]: "cubes",
  [PrimitiveType.MODELS]: "models",
  [PrimitiveType.LINES]: "lines",
  [PrimitiveType.CYLINDERS]: "cylinders",
  [PrimitiveType.ARROWS]: "arrows",
  [PrimitiveType.SPHERES]: "spheres",
  [PrimitiveType.TEXTS]: "texts",
  [PrimitiveType.TRIANGLES]: "triangles",
} as const;

export class TopicEntities extends Renderable<EntityTopicUserData> {
  public override pickable = false;
  #renderablesById = new Map<string, EntityRenderables>();
  /**
   * Last-seen content hash per entity id, for skipping renderable.update() when
   * a republished entity is unchanged. Entries must be evicted wherever
   * #renderablesById entries are removed so a stale hash can never skip a needed
   * update after the renderable was released back to the pool.
   */
  #contentHashById = new Map<string, number>();

  public constructor(
    name: string,
    private primitivePool: PrimitivePool,
    renderer: IRenderer,
    userData: EntityTopicUserData,
  ) {
    super(name, renderer, userData);
  }

  public override dispose(): void {
    this.children.length = 0;
    this.#deleteAllEntities();
  }

  public updateSettings(): void {
    // Updates each individual primitive renderable using the current topic settings
    for (const renderables of this.#renderablesById.values()) {
      for (const renderable of Object.values(renderables)) {
        renderable.updateSettings(this.userData.settings);
      }
    }
  }

  public setColorScheme(colorScheme: "dark" | "light"): void {
    for (const renderables of this.#renderablesById.values()) {
      for (const renderable of Object.values(renderables)) {
        renderable.setColorScheme(colorScheme);
      }
    }
  }

  public startFrame(currentTime: bigint, renderFrameId: string, fixedFrameId: string): void {
    this.visible = this.userData.settings.visible;
    if (!this.visible) {
      this.renderer.settings.errors.clearTopic(this.topic);
      return;
    }

    for (const renderables of this.#renderablesById.values()) {
      for (const renderable of Object.values(renderables)) {
        const entity = renderable.userData.entity;
        if (!entity) {
          continue;
        }

        // Check if this entity has expired
        const expiresAt = renderable.userData.expiresAt;
        if (expiresAt != undefined && currentTime > expiresAt) {
          this.#deleteEntity(entity.id);
          break;
        }

        const frameId = this.renderer.normalizeFrameId(entity.frame_id);
        const srcTime = entity.frame_locked ? currentTime : toNanoSec(entity.timestamp);
        const updated = updatePose(
          renderable,
          this.renderer.transformTree,
          renderFrameId,
          fixedFrameId,
          frameId,
          currentTime,
          srcTime,
        );
        renderable.visible = updated;
        const topic = this.userData.topic;
        if (!updated) {
          const message = missingTransformMessage(renderFrameId, fixedFrameId, frameId);
          this.renderer.settings.errors.addToTopic(topic, MISSING_TRANSFORM, message);
        } else {
          this.renderer.settings.errors.removeFromTopic(topic, MISSING_TRANSFORM);
        }
      }
    }
  }

  public addOrUpdateEntity(entity: SceneEntity, receiveTime: bigint): void {
    let renderables = this.#renderablesById.get(entity.id);
    if (!renderables) {
      renderables = {};
      this.#renderablesById.set(entity.id, renderables);
    }

    // Hash the normalized entity here rather than the raw message in
    // FoxgloveSceneEntities#handleSceneUpdate: the normalized graph is freshly
    // allocated per message (the player can never mutate it after delivery) and
    // it is exactly what the renderables consume. Walking numbers is cheap
    // compared to renderable.update(), which reserializes geometry and replaces
    // GPU buffers even when nothing changed.
    const contentHash = hashSceneEntityContent(entity);
    if (this.#contentHashById.get(entity.id) === contentHash) {
      this.#refreshEntityRenderables(renderables, entity, receiveTime);
      return;
    }

    for (const primitiveType of ALL_PRIMITIVE_TYPES) {
      const hasPrimitives = entity[PRIMITIVE_KEYS[primitiveType]].length > 0;
      let renderable = renderables[primitiveType];
      if (hasPrimitives) {
        if (!renderable) {
          renderable = this.primitivePool.acquire(primitiveType);
          renderable.name = `${entity.id}:${primitiveType} on ${this.topic}`;
          renderable.userData.entityId = `${entity.id}:${primitiveType}`;
          renderable.userData.settingsPath = this.userData.settingsPath;
          renderable.setColorScheme(this.renderer.colorScheme);
          // @ts-expect-error TS doesn't know that renderable matches primitiveType
          renderables[primitiveType] = renderable;
          this.add(renderable);
        }
        renderable.update(this.userData.topic, entity, this.userData.settings, receiveTime);
      } else if (renderable) {
        this.remove(renderable);
        delete renderables[primitiveType];
        this.primitivePool.release(primitiveType, renderable);
      }
    }
    this.#contentHashById.set(entity.id, contentHash);
  }

  /**
   * Skip-path bookkeeping for an unchanged entity. renderable.update() is the
   * expensive part (GPU buffer rebuilds), but it also stores per-message state
   * that must stay fresh: the expiry time (recomputed from the new receiveTime,
   * mirroring the update() implementations of all primitive renderables) and the
   * latest entity, which startFrame() reads for frame_id/timestamp pose lookup
   * and details() returns to the user.
   */
  #refreshEntityRenderables(
    renderables: EntityRenderables,
    entity: SceneEntity,
    receiveTime: bigint,
  ): void {
    const lifetimeNs = toNanoSec(entity.lifetime);
    const expiresAt = lifetimeNs === 0n ? undefined : receiveTime + lifetimeNs;
    for (const renderable of Object.values(renderables)) {
      renderable.userData.topic = this.userData.topic;
      renderable.userData.entity = entity;
      renderable.userData.settings = this.userData.settings;
      renderable.userData.receiveTime = receiveTime;
      renderable.userData.expiresAt = expiresAt;
    }
  }

  public deleteEntities(deletion: SceneEntityDeletion): void {
    switch (deletion.type) {
      case SceneEntityDeletionType.MATCHING_ID:
        this.#deleteEntity(deletion.id);
        break;
      case SceneEntityDeletionType.ALL:
        this.#deleteAllEntities();
        break;
      default:
        // Unknown action
        this.renderer.settings.errors.addToTopic(
          this.topic,
          INVALID_DELETION_TYPE,
          `Invalid deletion type ${deletion.type}`,
        );
    }
  }

  #removeRenderables(renderables: EntityRenderables): void {
    for (const [primitiveType, primitive] of Object.entries(renderables) as [
      PrimitiveType,
      EntityRenderables[PrimitiveType],
    ][]) {
      if (primitive) {
        this.remove(primitive);
        this.primitivePool.release(primitiveType, primitive);
      }
    }
  }

  #deleteEntity(id: string) {
    const renderables = this.#renderablesById.get(id);
    if (renderables) {
      this.#removeRenderables(renderables);
    }
    this.#renderablesById.delete(id);
    this.#contentHashById.delete(id);
  }

  #deleteAllEntities() {
    for (const renderables of this.#renderablesById.values()) {
      this.#removeRenderables(renderables);
    }
    this.#renderablesById.clear();
    this.#contentHashById.clear();
  }
}
