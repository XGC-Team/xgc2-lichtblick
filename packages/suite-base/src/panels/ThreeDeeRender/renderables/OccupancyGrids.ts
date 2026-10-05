// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { t } from "i18next";
import * as THREE from "three";

import { toNanoSec } from "@lichtblick/rostime";
import { SettingsTreeAction, SettingsTreeFields, type MessageEvent } from "@lichtblick/suite";
import type { RosValue } from "@lichtblick/suite-base/players/types";

import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessageEvent, SceneExtension, onlyLastByTopicMessage } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import { rgbaToCssString } from "../color";
import { OccupancyGrid, OCCUPANCY_GRID_DATATYPES } from "../ros";
import type {
  NativeCloudPreparation,
  NativeCloudCommitUsage,
} from "../../../players/nativeCloudPreparation";
import {
  createOccupancyGridPalette,
  prepareOccupancyGrid,
  occupancyGridColorKey,
  occupancyGridHasTransparency,
  type PreparedOccupancyGrid,
  type NormalizedOccupancyGrid,
} from "./occupancyGrids/prepareOccupancyGrid";
import { BaseSettings } from "../settings";
import { topicIsConvertibleToSchema } from "../topicIsConvertibleToSchema";

type ColorModes = "custom" | "costmap" | "map" | "raw";

export type LayerSettingsOccupancyGrid = BaseSettings & {
  frameLocked: boolean;
  minColor: string;
  maxColor: string;
  unknownColor: string;
  invalidColor: string;
  colorMode: ColorModes;
  alpha: number;
};

const INVALID_OCCUPANCY_GRID = "INVALID_OCCUPANCY_GRID";

const DEFAULT_MIN_COLOR = { r: 1, g: 1, b: 1, a: 1 }; // white
const DEFAULT_MAX_COLOR = { r: 0, g: 0, b: 0, a: 1 }; // black
const DEFAULT_UNKNOWN_COLOR = { r: 0.5, g: 0.5, b: 0.5, a: 1 }; // gray
const DEFAULT_INVALID_COLOR = { r: 1, g: 0, b: 1, a: 1 }; // magenta
const DEFAULT_ALPHA = 1.0;

const DEFAULT_MIN_COLOR_STR = rgbaToCssString(DEFAULT_MIN_COLOR);
const DEFAULT_MAX_COLOR_STR = rgbaToCssString(DEFAULT_MAX_COLOR);
const DEFAULT_UNKNOWN_COLOR_STR = rgbaToCssString(DEFAULT_UNKNOWN_COLOR);
const DEFAULT_INVALID_COLOR_STR = rgbaToCssString(DEFAULT_INVALID_COLOR);

const DEFAULT_SETTINGS: LayerSettingsOccupancyGrid = {
  visible: false,
  frameLocked: false,
  colorMode: "custom",
  minColor: DEFAULT_MIN_COLOR_STR,
  maxColor: DEFAULT_MAX_COLOR_STR,
  unknownColor: DEFAULT_UNKNOWN_COLOR_STR,
  invalidColor: DEFAULT_INVALID_COLOR_STR,
  alpha: DEFAULT_ALPHA,
};

export type OccupancyGridUserData = BaseUserData & {
  settings: LayerSettingsOccupancyGrid;
  topic: string;
  occupancyGrid: NormalizedOccupancyGrid;
  mesh: THREE.Mesh;
  texture: THREE.DataTexture;
  material: THREE.MeshBasicMaterial;
  pickingMaterial: THREE.ShaderMaterial;
  originalEvent?: MessageEvent;
  growOverlapBytes: number;
};

export class OccupancyGridRenderable extends Renderable<OccupancyGridUserData> {
  public override dispose(): void {
    this.userData.texture.dispose();
    this.userData.material.dispose();
    this.userData.pickingMaterial.dispose();
  }

  public override details(): Record<string, RosValue> {
    return this.userData.occupancyGrid;
  }
}

export class OccupancyGrids extends SceneExtension<OccupancyGridRenderable> {
  public static extensionId = "foxglove.OccupancyGrids";
  public constructor(renderer: IRenderer, name: string = OccupancyGrids.extensionId) {
    super(name, renderer);
  }

  #preparedTopics = new Set<string>();
  #preparationByTopic = new Map<string, NativeCloudPreparation>();
  #prepRevision = 0;

  #usage(topic: string): NativeCloudCommitUsage {
    const current = this.renderables.get(topic)?.userData;
    if (current == undefined) return { cpuArrays: [], gpuCapacityBytes: 0, growOverlapBytes: 0 };
    const originalData = (current.originalEvent?.message as { data?: unknown } | undefined)?.data;
    return {
      cpuArrays: [
        current.occupancyGrid.data,
        current.texture.image.data,
        ...(ArrayBuffer.isView(originalData) ? [originalData] : []),
      ],
      gpuCapacityBytes: current.texture.image.data.byteLength,
      growOverlapBytes: current.growOverlapBytes,
    };
  }

  #nativePreparation = (topic: string): NativeCloudPreparation => {
    const settings = { ...DEFAULT_SETTINGS, ...this.renderer.config.topics[topic] };
    const inputKey = occupancyGridColorKey(settings);
    const old = this.#preparationByTopic.get(topic);
    if (old != undefined && old.inputKey === inputKey) return old;
    const request: NativeCloudPreparation = {
      kind: "occupancy-grid",
      key: old?.key ?? {},
      revision: String(++this.#prepRevision),
      inputKey,
      settings: { palette: createOccupancyGridPalette(settings) },
      setEnabled: (enabled) => {
        if (enabled) this.#preparedTopics.add(topic);
        else this.#preparedTopics.delete(topic);
      },
      invalidCloud: (message) => {
        this.renderer.settings.errors.addToTopic(topic, INVALID_OCCUPANCY_GRID, message);
      },
      usage: () => this.#usage(topic),
      commit: (event, prepared) => {
        if (prepared.kind !== "occupancy-grid")
          throw new Error("Mismatched OccupancyGrid preparation result");
        // Config changes are synchronous; React's next subscription effect may still carry the
        // old descriptor. Do not pair old RGBA with new settings/material in that interval.
        const actual = { ...DEFAULT_SETTINGS, ...this.renderer.config.topics[topic] };
        if (inputKey !== occupancyGridColorKey(actual)) return undefined;
        this.#commit(event, prepared);
        if (this.renderer.canvasVisibility() === "visible") this.renderer.queueAnimationFrame();
        return this.#usage(topic);
      },
    };
    this.#preparationByTopic.set(topic, request);
    return request;
  };

  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    return [
      {
        type: "schema",
        schemaNames: OCCUPANCY_GRID_DATATYPES,
        subscription: {
          handler: this.#handleOccupancyGrid,
          filterQueue: onlyLastByTopicMessage,
          supportsLatestPerRenderTick: () => true,
          nativeCloudPreparation: this.#nativePreparation,
        },
      },
    ];
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      if (!topicIsConvertibleToSchema(topic, OCCUPANCY_GRID_DATATYPES)) {
        continue;
      }

      const configWithDefaults = { ...DEFAULT_SETTINGS, ...configTopics[topic.name] };

      let fields: SettingsTreeFields = {
        colorMode: {
          label: t("threeDee:colorMode"),
          input: "select",
          value: configWithDefaults.colorMode,
          options: [
            { label: t("threeDee:colorModeCustom"), value: "custom" },
            { label: t("threeDee:colorModeRvizMap"), value: "map" },
            { label: t("threeDee:colorModeRvizCostmap"), value: "costmap" },
            { label: t("threeDee:colorModeRaw"), value: "raw" },
          ],
        },
      };

      if (configWithDefaults.colorMode === "custom") {
        const customFields: SettingsTreeFields = {
          minColor: {
            label: t("threeDee:minColor"),
            input: "rgba",
            value: configWithDefaults.minColor,
          },
          maxColor: {
            label: t("threeDee:maxColor"),
            input: "rgba",
            value: configWithDefaults.maxColor,
          },
          unknownColor: {
            label: t("threeDee:unknownColor"),
            input: "rgba",
            value: configWithDefaults.unknownColor,
          },
          invalidColor: {
            label: t("threeDee:invalidColor"),
            input: "rgba",
            value: configWithDefaults.invalidColor,
          },
        };
        fields = {
          ...fields,
          ...customFields,
        };
      } else {
        const paletteFields: SettingsTreeFields = {
          alpha: {
            label: "Alpha",
            input: "number",
            value: configWithDefaults.alpha,
            min: 0.0,
            max: 1.0,
            step: 0.1,
            placeholder: "auto",
          },
        };
        fields = {
          ...fields,
          ...paletteFields,
        };
      }

      fields.frameLocked = {
        label: t("threeDee:frameLock"),
        input: "boolean",
        value: configWithDefaults.frameLocked,
      };

      entries.push({
        path: ["topics", topic.name],
        node: {
          label: topic.name,
          icon: "Cells",
          fields,
          visible: configWithDefaults.visible,
          order: topic.name.toLocaleLowerCase(),
          handler,
        },
      });
    }
    return entries;
  }

  public override handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }

    this.saveSetting(path, action.payload.value);

    const topic = path[1]!;
    const renderable = this.renderables.get(topic);
    if (renderable == undefined) return;
    const current = renderable.userData;
    const previousKey = occupancyGridColorKey(current.settings);
    const settings = { ...DEFAULT_SETTINGS, ...this.renderer.config.topics[topic] };
    const colorsChanged = previousKey !== occupancyGridColorKey(settings);
    if (colorsChanged && this.#preparedTopics.has(topic)) {
      // Preserve the committed texture/color-material combination until this color revision
      // returns. Visibility/frame locking remain current UI intent, not preparation inputs.
      current.settings = {
        ...current.settings,
        visible: settings.visible,
        frameLocked: settings.frameLocked,
      };
      return;
    }
    if (colorsChanged) {
      const event = current.originalEvent ?? {
        topic,
        schemaName: "nav_msgs/OccupancyGrid",
        receiveTime: { sec: 0, nsec: 0 },
        message: current.occupancyGrid,
        sizeInBytes: current.occupancyGrid.data.byteLength,
      };
      this.#commit(
        event,
        prepareOccupancyGrid(current.occupancyGrid, createOccupancyGridPalette(settings)),
        current.receiveTime,
      );
    } else {
      current.settings = settings;
      updateMaterial(current.material, settings);
    }
  };

  #handleOccupancyGrid = (messageEvent: PartialMessageEvent<OccupancyGrid>): void => {
    if (this.#preparedTopics.has(messageEvent.topic)) return;
    const settings = { ...DEFAULT_SETTINGS, ...this.renderer.config.topics[messageEvent.topic] };
    try {
      this.#commit(
        messageEvent as MessageEvent,
        prepareOccupancyGrid(messageEvent.message, createOccupancyGridPalette(settings)),
      );
    } catch (error) {
      this.renderer.settings.errors.addToTopic(
        messageEvent.topic,
        INVALID_OCCUPANCY_GRID,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  #commit(
    event: MessageEvent,
    prepared: PreparedOccupancyGrid,
    receiveTime = toNanoSec(event.receiveTime),
  ): void {
    const { occupancyGrid, rgba } = prepared;
    const { width, height, resolution } = occupancyGrid.info;
    // Preflight both the complete sample and its texture before touching last-valid metadata.
    if (
      !(occupancyGrid.data instanceof Int8Array) ||
      !(rgba instanceof Uint8ClampedArray) ||
      occupancyGrid.data.length !== width * height ||
      rgba.length !== width * height * 4
    ) {
      throw new Error("Invalid prepared OccupancyGrid texture dimensions or dtype");
    }
    const topic = event.topic;
    const settings = { ...DEFAULT_SETTINGS, ...this.renderer.config.topics[topic] };
    const messageTime = toNanoSec(occupancyGrid.header.stamp);
    const frameId = this.renderer.normalizeFrameId(occupancyGrid.header.frame_id);
    const transparent = occupancyGridHasTransparency(settings);
    let renderable = this.renderables.get(topic);
    const oldTexture = renderable?.userData.texture;
    const resized =
      oldTexture == undefined ||
      oldTexture.image.width !== width ||
      oldTexture.image.height !== height;
    const texture = resized ? createTexture(occupancyGrid, rgba) : oldTexture!;
    // For same dimensions this read-only derived array is directly adopted, never copied or
    // modified in place. Every consumer keeps its own DataTexture/GPU context binding.
    if (renderable == undefined) {
      const geometry = this.renderer.sharedGeometry.getGeometry(
        this.constructor.name,
        createGeometry,
      );
      const mesh = createMesh(topic, geometry, texture, settings);
      renderable = new OccupancyGridRenderable(topic, this.renderer, {
        receiveTime,
        messageTime,
        frameId,
        pose: occupancyGrid.info.origin,
        settingsPath: ["topics", topic],
        settings,
        topic,
        occupancyGrid,
        mesh,
        texture,
        material: mesh.material as THREE.MeshBasicMaterial,
        pickingMaterial: mesh.userData.pickingMaterial as THREE.ShaderMaterial,
        originalEvent: event,
        growOverlapBytes: 0,
      });
      renderable.add(mesh);
      this.add(renderable);
      this.renderables.set(topic, renderable);
    }
    const current = renderable.userData;
    texture.image = { data: rgba, width, height };
    texture.needsUpdate = true;
    current.occupancyGrid = occupancyGrid;
    current.originalEvent = event;
    current.pose = occupancyGrid.info.origin;
    current.receiveTime = receiveTime;
    current.messageTime = messageTime;
    current.frameId = frameId;
    current.settings = settings;
    current.texture = texture;
    current.material.map = texture;
    current.pickingMaterial.uniforms.map!.value = texture;
    updateMaterial(current.material, settings, transparent);
    current.growOverlapBytes =
      resized && oldTexture != undefined ? oldTexture.image.data.byteLength + rgba.byteLength : 0;
    renderable.scale.set(resolution * width, resolution * height, 1);
    this.renderer.settings.errors.removeFromTopic(topic, INVALID_OCCUPANCY_GRID);
    // Discard the old texture only after both draw and picking refer to the complete new sample.
    if (resized && oldTexture != undefined) oldTexture.dispose();
  }
}
function createGeometry(): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  geometry.translate(0.5, 0.5, 0);
  geometry.computeBoundingSphere();
  return geometry;
}
function createTexture(occupancyGrid: OccupancyGrid, rgba: Uint8ClampedArray): THREE.DataTexture {
  const width = occupancyGrid.info.width;
  const height = occupancyGrid.info.height;
  const texture = new THREE.DataTexture(
    rgba,
    width,
    height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
    THREE.UVMapping,
    THREE.ClampToEdgeWrapping,
    THREE.ClampToEdgeWrapping,
    THREE.NearestFilter,
    THREE.LinearFilter,
    1,
    THREE.LinearSRGBColorSpace, // OccupancyGrid carries linear-sRGB grayscale values, not sRGB
  );
  texture.generateMipmaps = false;
  return texture;
}

function createMesh(
  topic: string,
  geometry: THREE.PlaneGeometry,
  texture: THREE.DataTexture,
  settings: LayerSettingsOccupancyGrid,
): THREE.Mesh {
  // Create the texture, material, and mesh
  const pickingMaterial = createPickingMaterial(texture);
  const material = createMaterial(texture, topic, settings);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // This overrides the picking material used for `mesh`. See Picker.ts
  mesh.userData.pickingMaterial = pickingMaterial;
  return mesh;
}

function createMaterial(
  texture: THREE.DataTexture,
  topic: string,
  settings: LayerSettingsOccupancyGrid,
): THREE.MeshBasicMaterial {
  const transparent = occupancyGridHasTransparency(settings);
  return new THREE.MeshBasicMaterial({
    name: `${topic}:Material`,
    // Enable alpha clipping. Fully transparent (alpha=0) pixels are skipped
    // even when transparency is disabled
    alphaTest: 1e-4,
    depthWrite: !transparent,
    map: texture,
    side: THREE.DoubleSide,
    transparent,
  });
}

function createPickingMaterial(texture: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec4 objectId;
      varying vec2 vUv;
      void main() {
        vec4 color = texture2D(map, vUv);
        if (color.a == 0.0) {
          discard;
        }
        gl_FragColor = objectId;
      }
    `,
    side: THREE.DoubleSide,
    uniforms: { map: { value: texture }, objectId: { value: [NaN, NaN, NaN, NaN] } },
  });
}

function updateMaterial(
  material: THREE.MeshBasicMaterial,
  settings: LayerSettingsOccupancyGrid,
  transparent = occupancyGridHasTransparency(settings),
): void {
  if (material.transparent !== transparent) {
    material.transparent = transparent;
    material.depthWrite = !transparent;
    material.needsUpdate = true;
  }
}
