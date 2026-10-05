import type {
  NativeCloudPreparation,
  NativeCloudCommitUsage,
} from "../../../players/nativeCloudPreparation";
import {
  updateNormalizedPointCloudBuffers,
  validateNormalizedPointCloud,
  normalizePointCloud,
  normalizePointCloud2,
  getTimestamp,
  getFrameId,
  getStride,
  getPose,
  type PreparedPointCloud,
} from "./pointClouds/preparePointCloud";
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PointCloud } from "@foxglove/schemas";
import * as _ from "lodash-es";
import * as THREE from "three";

import { toNanoSec } from "@lichtblick/rostime";
import { SettingsTreeAction, MessageEvent } from "@lichtblick/suite";
import { DynamicBufferGeometry } from "@lichtblick/suite-base/panels/ThreeDeeRender/DynamicBufferGeometry";
import {
  createGeometry,
  createInstancePickingMaterial,
  createPickingMaterial,
  DEFAULT_POINT_SETTINGS,
  LayerSettingsPointExtension,
  pointSettingsNode,
  pointCloudMaterial,
  pointCloudColorEncoding,
  POINT_CLOUD_REQUIRED_FIELDS,
  RenderObjectHistory,
  PointsRenderable,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/pointExtensionUtils";
import type { RosObject, RosValue } from "@lichtblick/suite-base/players/types";

import {
  autoSelectColorSettings,
  colorHasTransparency,
  colorFieldComputedPrefix,
} from "./colorMode";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessageEvent, SceneExtension } from "../SceneExtension";
import { SettingsTreeEntry, SettingsTreeNodeWithActionHandler } from "../SettingsManager";
import { POINTCLOUD_DATATYPES as FOXGLOVE_POINTCLOUD_DATATYPES } from "../foxglove";
import { PointCloud2, POINTCLOUD_DATATYPES as ROS_POINTCLOUD_DATATYPES } from "../ros";
import { topicIsConvertibleToSchema } from "../topicIsConvertibleToSchema";
import { makePose } from "../transforms";
import { getReader, isSupportedField } from "./pointClouds/fieldReaders";

export type LayerSettingsPointClouds = LayerSettingsPointExtension & {
  stixelsEnabled: boolean;
  colorFieldComputed: "distance" | undefined;
};

const DEFAULT_SETTINGS = {
  ...DEFAULT_POINT_SETTINGS,
  stixelsEnabled: false,
  colorFieldComputed: undefined,
};

type PointCloudHistoryUserData = BaseUserData & {
  settings: LayerSettingsPointClouds;
  topic: string;
  latestPointCloud: PointCloud | PointCloud2;
  latestOriginalMessage: Record<string, RosValue> | undefined;
  material: THREE.PointsMaterial;
  pickingMaterial: THREE.ShaderMaterial;
  instancePickingMaterial: THREE.ShaderMaterial;
  stixelMaterial: THREE.LineBasicMaterial;
};

const ALL_POINTCLOUD_DATATYPES = new Set<string>([
  ...FOXGLOVE_POINTCLOUD_DATATYPES,
  ...ROS_POINTCLOUD_DATATYPES,
]);

const INVALID_POINTCLOUD = "INVALID_POINTCLOUD";

type PointCloudUserData = BaseUserData & {
  pointCloud: PointCloud | PointCloud2;
  originalMessage: Record<string, RosValue> | undefined;
};

class PointCloudRenderable extends PointsRenderable<PointCloudUserData> {
  public localSampleBounds: THREE.Sphere | undefined;
  public override details(): Record<string, RosValue> {
    return this.userData.originalMessage ?? {};
  }

  public override instanceDetails(instanceId: number): Record<string, RosValue> | undefined {
    const pointCloud = this.userData.pointCloud;
    const data = pointCloud.data;
    const stride = getStride(pointCloud);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const pointStep = getStride(pointCloud);
    const details: Record<string, RosValue> = {};

    for (const field of pointCloud.fields) {
      const pointOffset = instanceId * pointStep;
      const reader = getReader(field, stride);
      if (reader) {
        details[field.name] = reader(view, pointOffset);
      }
    }

    return details;
  }
}

export class PointCloudHistoryRenderable extends Renderable<PointCloudHistoryUserData> {
  public override pickable = false; // Picking happens on child renderables
  #pointsHistory: RenderObjectHistory<PointCloudRenderable>;
  #stixelsHistory: RenderObjectHistory<StixelsRenderable>;

  public constructor(topic: string, renderer: IRenderer, userData: PointCloudHistoryUserData) {
    super(topic, renderer, userData);

    const isDecay = userData.settings.decayTime > 0;
    const geometry = createGeometry(
      topic,
      isDecay ? THREE.StaticDrawUsage : THREE.DynamicDrawUsage,
    );

    const points = new PointCloudRenderable(
      topic,
      {
        receiveTime: -1n, // unused
        messageTime: -1n, // unused
        frameId: "", //unused
        pose: getPose(userData.latestPointCloud),
        settingsPath: [], //unused
        settings: { visible: true }, //unused
        topic,
        pointCloud: userData.latestPointCloud,
        originalMessage: userData.latestOriginalMessage,
      },
      geometry,
      userData.material,
      userData.pickingMaterial,
      userData.instancePickingMaterial,
    );
    this.#pointsHistory = new RenderObjectHistory({
      initial: {
        messageTime: userData.messageTime,
        receiveTime: userData.receiveTime,
        renderable: points,
      },
      parentRenderable: this,
      renderer,
    });
    this.add(points);

    const stixelGeometry = createStixelGeometry(
      topic,
      isDecay ? THREE.StaticDrawUsage : THREE.DynamicDrawUsage,
    );
    const stixels = new StixelsRenderable(
      topic,
      {
        receiveTime: -1n, // unused
        messageTime: -1n, // unused
        frameId: "", //unused
        pose: getPose(userData.latestPointCloud),
        settingsPath: [], //unused
        settings: { visible: true }, //unused
        topic,
      },
      stixelGeometry,
      userData.stixelMaterial,
    );
    this.#stixelsHistory = new RenderObjectHistory({
      initial: {
        messageTime: userData.messageTime,
        receiveTime: userData.receiveTime,
        renderable: stixels,
      },
      parentRenderable: this,
      renderer,
    });

    this.add(stixels);
  }

  public override dispose(): void {
    this.userData.latestOriginalMessage = undefined;
    this.userData.material.dispose();
    this.userData.pickingMaterial.dispose();
    this.userData.instancePickingMaterial.dispose();
    this.userData.stixelMaterial.dispose();
    this.#pointsHistory.dispose();
    this.#stixelsHistory.dispose();
    super.dispose();
  }

  public updateMaterialSettings(settings: LayerSettingsPointClouds): void {
    const prevSettings = this.userData.settings;
    this.userData.settings = settings;

    let material = this.userData.material;
    let stixelMaterial = this.userData.stixelMaterial;
    const needsRebuild =
      colorHasTransparency(settings) !== material.transparent ||
      pointCloudColorEncoding(settings) !== pointCloudColorEncoding(prevSettings) ||
      settings.pointShape !== prevSettings.pointShape ||
      settings.pointSizeMode !== prevSettings.pointSizeMode;

    const pointsHistory = this.#pointsHistory;
    const stixelsHistory = this.#stixelsHistory;
    if (needsRebuild) {
      material.dispose();
      material = pointCloudMaterial(settings);
      this.userData.material = material;
      pointsHistory.forEach((entry) => {
        entry.renderable.updateMaterial(material);
      });

      stixelMaterial.dispose();
      stixelMaterial = createStixelMaterial(settings);
      this.userData.stixelMaterial = stixelMaterial;
      stixelsHistory.forEach((entry) => {
        entry.renderable.updateMaterial(stixelMaterial);
      });
    } else {
      material.size = settings.pointSize;
    }
    this.userData.pickingMaterial.uniforms.pointSize!.value = Math.max(settings.pointSize, 8);
    this.userData.instancePickingMaterial.uniforms.pointSize!.value = Math.max(
      settings.pointSize,
      8,
    );
  }

  public updatePointCloud(
    this: PointCloudHistoryRenderable,
    pointCloud: PointCloud | PointCloud2,
    originalMessage: RosObject | undefined,
    settings: LayerSettingsPointClouds,
    receiveTime: bigint,
    prepared?: PreparedPointCloud,
  ): void {
    const messageTime = toNanoSec(getTimestamp(pointCloud));
    this.userData.receiveTime = receiveTime;
    this.userData.messageTime = messageTime;
    this.userData.frameId = this.renderer.normalizeFrameId(getFrameId(pointCloud));
    this.userData.latestPointCloud = pointCloud;
    this.userData.latestOriginalMessage = originalMessage;

    const prevIsDecay = this.userData.settings.decayTime > 0;
    this.updateMaterialSettings(settings);
    const pointsHistory = this.#pointsHistory,
      stixelsHistory = this.#stixelsHistory;
    if (settings.colorField === colorFieldComputedPrefix + "distance")
      settings.colorFieldComputed = "distance";
    if (!settings.stixelsEnabled) stixelsHistory.clearHistory();

    if (prepared == undefined) {
      try {
        validateNormalizedPointCloud(pointCloud, settings);
      } catch (error) {
        this.#invalidError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    const latestPointsEntry = pointsHistory.latest();
    latestPointsEntry.receiveTime = receiveTime;
    latestPointsEntry.messageTime = messageTime;
    latestPointsEntry.renderable.userData.pose = getPose(pointCloud);
    latestPointsEntry.renderable.userData.pointCloud = pointCloud;
    latestPointsEntry.renderable.userData.originalMessage = originalMessage;

    const pointCount = Math.trunc(pointCloud.data.length / getStride(pointCloud));
    const latestPoints = latestPointsEntry.renderable;
    let growOverlap = 0;
    if (prepared != undefined) {
      if (prepared.coordinatesPrepared)
        growOverlap += latestPoints.geometry.adopt(pointCount, {
          position: prepared.positions,
          color: prepared.colors,
        });
      else latestPoints.geometry.adoptColors(pointCount, prepared.colors);
    } else latestPoints.geometry.resize(pointCount);
    const positionAttribute = latestPoints.geometry.attributes.position!;
    const colorAttribute = latestPoints.geometry.attributes.color!;

    const latestStixelEntry = stixelsHistory.latest();

    const isDecay = settings.decayTime > 0;
    if (!isDecay && prevIsDecay !== isDecay) {
      latestPointsEntry.renderable.geometry.setUsage(THREE.DynamicDrawUsage);
      latestStixelEntry.renderable.geometry.setUsage(THREE.DynamicDrawUsage);
    }

    latestStixelEntry.receiveTime = receiveTime;
    latestStixelEntry.messageTime = messageTime;
    latestStixelEntry.renderable.userData.pose = latestPointsEntry.renderable.userData.pose;
    if (settings.stixelsEnabled) {
      if (prepared != undefined) {
        if (prepared.coordinatesPrepared)
          growOverlap += latestStixelEntry.renderable.geometry.adopt(pointCount * 2, {
            position: prepared.stixelPositions,
            color: prepared.stixelColors,
          });
        else
          latestStixelEntry.renderable.geometry.adoptColors(pointCount * 2, prepared.stixelColors);
      } else latestStixelEntry.renderable.geometry.resize(pointCount * 2);
    } else {
      latestStixelEntry.renderable.geometry.resize(0);
    }
    const stixelPositionAttribute = latestStixelEntry.renderable.geometry.attributes.position!;
    const stixelColorAttribute = latestStixelEntry.renderable.geometry.attributes.color!;
    if (prepared == undefined) {
      try {
        const result = updateNormalizedPointCloudBuffers(
          pointCloud,
          settings,
          positionAttribute,
          colorAttribute,
          stixelPositionAttribute,
          stixelColorAttribute,
        );
        this.#setSampleBounds(latestPoints, latestStixelEntry.renderable, result.bounds);
        for (const problem of result.problems)
          this.renderer.settings.errors.addToTopic(
            this.userData.topic,
            INVALID_POINTCLOUD,
            problem,
          );
        for (const geometry of [latestPoints.geometry, latestStixelEntry.renderable.geometry])
          for (const attribute of Object.values(geometry.attributes)) {
            attribute.updateRange.offset = 0;
            attribute.updateRange.count = geometry.drawRange.count * attribute.itemSize;
          }
      } catch (error) {
        this.#invalidError(error instanceof Error ? error.message : String(error));
      }
    } else {
      if (prepared.coordinatesPrepared)
        this.#setSampleBounds(latestPoints, latestStixelEntry.renderable, prepared.bounds);
      for (const problem of prepared.problems)
        this.renderer.settings.errors.addToTopic(this.userData.topic, INVALID_POINTCLOUD, problem);
    }
    this.#lastGrowOverlap = growOverlap;
  }

  #lastGrowOverlap = 0;
  #boundsSize = new THREE.Vector2();
  #boundsCenter = new THREE.Vector3();
  #setSampleBounds(
    entry: PointCloudRenderable,
    stixels: StixelsRenderable,
    bounds: PreparedPointCloud["bounds"],
  ): void {
    const sphere =
      bounds == undefined
        ? undefined
        : new THREE.Box3(
            new THREE.Vector3(...(bounds.min as [number, number, number])),
            new THREE.Vector3(...(bounds.max as [number, number, number])),
          ).getBoundingSphere(new THREE.Sphere());
    entry.localSampleBounds = sphere;
    stixels.localSampleBounds = sphere;
  }
  #refreshBounds(drawable: PointCloudRenderable | StixelsRenderable): void {
    const local = drawable.localSampleBounds;
    if (local == undefined) {
      drawable.setPointCloudFrustumCulling(false);
      return;
    }
    const camera = this.renderer.cameraHandler.getActiveCamera();
    camera.updateMatrixWorld();
    this.renderer.gl.getDrawingBufferSize(this.#boundsSize);
    drawable.updateWorldMatrix(true, false);
    const scale = drawable.matrixWorld.getMaxScaleOnAxis();
    this.#boundsCenter
      .copy(local.center)
      .applyMatrix4(drawable.matrixWorld)
      .applyMatrix4(camera.matrixWorldInverse);
    const radius = local.radius * scale;
    const depth = -this.#boundsCenter.z;
    const e = camera.projectionMatrix.elements;
    const perspective = camera instanceof THREE.PerspectiveCamera;
    const usable =
      Number.isFinite(depth) &&
      Number.isFinite(radius) &&
      scale > 0 &&
      this.#boundsSize.x > 0 &&
      this.#boundsSize.y > 0 &&
      Number.isFinite(e[0]) &&
      Number.isFinite(e[5]) &&
      e[0] !== 0 &&
      e[5] !== 0 &&
      depth - radius > camera.near &&
      Number.isFinite(this.userData.settings.pointSize);
    if (!usable) {
      drawable.setPointCloudFrustumCulling(false);
      return;
    }
    const distance = perspective ? depth + radius : 1;
    const metersPerPixel = Math.max(
      (2 * distance) / (this.#boundsSize.x * Math.abs(e[0]!)),
      (2 * distance) / (this.#boundsSize.y * Math.abs(e[5]!)),
    );
    const settings = this.userData.settings;
    // Picking has at least an 8px footprint. The same conservative sphere serves both passes.
    const pixelMargin =
      Math.max(settings.pointSizeMode === "world" ? 0 : settings.pointSize, 8) *
      0.5 *
      metersPerPixel;
    const worldMargin =
      settings.pointSizeMode === "world" ? settings.pointSize * 0.5 * Math.max(1, scale) : 0;
    const sphere = drawable.geometry.boundingSphere ?? new THREE.Sphere();
    sphere.copy(local);
    sphere.radius += (Math.SQRT2 * Math.max(pixelMargin, worldMargin)) / scale;
    drawable.geometry.boundingSphere = sphere;
    drawable.setPointCloudFrustumCulling(true);
  }

  public preparedUsage(): NativeCloudCommitUsage {
    const geometries = [
      this.#pointsHistory.latest().renderable.geometry,
      this.#stixelsHistory.latest().renderable.geometry,
    ];
    return {
      cpuArrays: [
        ...(ArrayBuffer.isView(this.userData.latestOriginalMessage?.data)
          ? [this.userData.latestOriginalMessage!.data as ArrayBufferView]
          : []),
        this.userData.latestPointCloud.data,
        ...geometries.flatMap((g) => Object.values(g.attributes).map((a) => a.array)),
      ],
      gpuCapacityBytes: geometries.reduce((sum, g) => sum + g.capacityBytes, 0),
      growOverlapBytes: this.#lastGrowOverlap,
    };
  }
  public get preparedCapacity(): number {
    return this.#pointsHistory.latest().renderable.geometry.itemCapacity;
  }
  public invalidPreparedCloud(message: string): void {
    this.#invalidError(message);
  }

  public startFrame(currentTime: bigint, renderFrameId: string, fixedFrameId: string): void {
    this.#pointsHistory.updateHistoryFromCurrentTime(currentTime);
    this.#pointsHistory.updatePoses(currentTime, renderFrameId, fixedFrameId);
    this.#pointsHistory.forEach((entry) => this.#refreshBounds(entry.renderable));
    if (this.userData.settings.stixelsEnabled) {
      this.#stixelsHistory.updateHistoryFromCurrentTime(currentTime);
      this.#stixelsHistory.updatePoses(currentTime, renderFrameId, fixedFrameId);
      this.#stixelsHistory.forEach((entry) => this.#refreshBounds(entry.renderable));
    }
  }

  public pushHistory(
    this: PointCloudHistoryRenderable,
    pointCloud: PointCloud | PointCloud2,
    originalMessage: RosObject | undefined,
    settings: LayerSettingsPointClouds,
    receiveTime: bigint,
  ): void {
    const messageTime = toNanoSec(getTimestamp(pointCloud));
    const pointsHistory = this.#pointsHistory;
    const stixelsHistory = this.#stixelsHistory;
    const material = this.userData.material;
    const stixelMaterial = this.userData.stixelMaterial;
    const topic = this.userData.topic;

    // Push a new (empty) entry to the history of points
    const geometry = createGeometry(topic, THREE.StaticDrawUsage);
    const points = new PointCloudRenderable(
      topic,
      {
        receiveTime: -1n, // unused
        messageTime: -1n, // unused
        frameId: "", //unused
        pose: getPose(pointCloud),
        settingsPath: [], //unused
        settings: { visible: true }, //unused
        topic,
        pointCloud,
        originalMessage,
      },
      geometry,
      material,
      this.userData.pickingMaterial,
      this.userData.instancePickingMaterial,
    );
    pointsHistory.addHistoryEntry({ receiveTime, messageTime, renderable: points });
    this.add(points);

    if (settings.stixelsEnabled) {
      const stixelGeometry = createStixelGeometry(topic, THREE.StaticDrawUsage);
      const stixels = new StixelsRenderable(
        topic,
        {
          receiveTime: -1n, // unused
          messageTime: -1n, // unused
          frameId: "", //unused
          pose: getPose(pointCloud),
          settingsPath: [], //unused
          settings: { visible: true }, //unused
          topic,
        },
        stixelGeometry,
        stixelMaterial,
      );
      stixelsHistory.addHistoryEntry({ receiveTime, messageTime, renderable: stixels });
      this.add(stixels);
    }
  }

  #invalidError(message: string): void {
    this.renderer.settings.errors.addToTopic(this.userData.topic, INVALID_POINTCLOUD, message);
    const lastEntry = this.#pointsHistory.latest();
    lastEntry.renderable.geometry.resize(0);
  }
}

export class PointClouds extends SceneExtension<PointCloudHistoryRenderable> {
  public static extensionId = "foxglove.PointClouds";
  #fieldsByTopic = new Map<string, string[]>();
  #preparedTopics = new Set<string>();
  #prepRevisionSequence = 0;
  #preparationByTopic = new Map<string, NativeCloudPreparation>();

  #nativePreparation = (topic: string): NativeCloudPreparation | undefined => {
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined),
    };
    if (settings.decayTime !== 0) return undefined;
    // Only actual CPU geometry/color inputs belong to this configuration domain.
    const preparationKey = (value: LayerSettingsPointClouds) =>
      JSON.stringify({
        stixelsEnabled: value.stixelsEnabled,
        colorMode: value.colorMode,
        colorField: value.colorField,
        colorFieldComputed: value.colorFieldComputed,
        flatColor: value.flatColor,
        gradient: value.gradient,
        colorMap: value.colorMap,
        explicitAlpha: value.explicitAlpha,
        minValue: value.minValue,
        maxValue: value.maxValue,
      });
    const inputKey = preparationKey(settings);
    const old = this.#preparationByTopic.get(topic);
    if (old != undefined && old.inputKey === inputKey) return old;
    const revision = String(++this.#prepRevisionSequence);
    const request: NativeCloudPreparation = {
      kind: "pointcloud",
      key: old?.key ?? {},
      revision,
      inputKey,
      settings,
      capacity: () => this.renderables.get(topic)?.preparedCapacity ?? 0,
      canReuseCoordinates: (event) => {
        const current = this.renderables.get(topic);
        return (
          current != undefined &&
          current.userData.latestOriginalMessage === event.message &&
          current.userData.settings.stixelsEnabled === settings.stixelsEnabled
        );
      },
      setEnabled: (enabled) => {
        if (enabled) this.#preparedTopics.add(topic);
        else this.#preparedTopics.delete(topic);
      },
      invalidCloud: (message) => {
        this.renderables.get(topic)?.invalidPreparedCloud(message);
        if (this.renderer.canvasVisibility() === "visible") this.renderer.queueAnimationFrame();
      },
      usage: () =>
        this.renderables.get(topic)?.preparedUsage() ?? {
          cpuArrays: [],
          gpuCapacityBytes: 0,
          growOverlapBytes: 0,
        },
      commit: (event, prepared) => {
        const cloud = prepared.pointCloud;
        this.#handlePointCloud(
          event.topic,
          event.schemaName,
          cloud,
          toNanoSec(event.receiveTime),
          toNanoSec(getTimestamp(cloud)),
          event.message as RosObject,
          getFrameId(cloud),
          prepared,
        );
        if (this.renderer.canvasVisibility() === "visible") this.renderer.queueAnimationFrame();
        return this.renderables.get(topic)!.preparedUsage();
      },
    };
    this.#preparationByTopic.set(topic, request);
    return request;
  };

  public constructor(renderer: IRenderer, name: string = PointClouds.extensionId) {
    super(name, renderer);
  }

  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    return [
      {
        type: "schema",
        schemaNames: ROS_POINTCLOUD_DATATYPES,
        subscription: {
          handler: this.#handleRosPointCloud,
          nativeCloudPreparation: this.#nativePreparation,
          filterQueue: this.#processMessageQueue.bind(this),
          supportsLatestPerRenderTick: (topic) =>
            (((this.renderer.config.topics[topic] ?? {}) as Partial<LayerSettingsPointClouds>)
              .decayTime ?? DEFAULT_SETTINGS.decayTime) === 0,
        },
      },
      {
        type: "schema",
        schemaNames: FOXGLOVE_POINTCLOUD_DATATYPES,
        subscription: {
          handler: this.#handleFoxglovePointCloud,
          nativeCloudPreparation: this.#nativePreparation,
          filterQueue: this.#processMessageQueue.bind(this),
          supportsLatestPerRenderTick: (topic) =>
            (((this.renderer.config.topics[topic] ?? {}) as Partial<LayerSettingsPointClouds>)
              .decayTime ?? DEFAULT_SETTINGS.decayTime) === 0,
        },
      },
    ];
  }

  #processMessageQueue<T>(msgs: MessageEvent<T>[]): MessageEvent<T>[] {
    if (msgs.length === 0) {
      return msgs;
    }
    const msgsByTopic = _.groupBy(msgs, (msg) => msg.topic);
    const finalQueue: MessageEvent<T>[] = [];
    for (const topic in msgsByTopic) {
      const topicMsgs = msgsByTopic[topic]!;
      const userSettings = (this.renderer.config.topics[topic] ??
        {}) as Partial<LayerSettingsPointClouds>;
      // if the topic has a decaytime add all messages to queue for topic
      if ((userSettings.decayTime ?? DEFAULT_SETTINGS.decayTime) > 0) {
        finalQueue.push(...topicMsgs);
        continue;
      }
      const latestMsg = topicMsgs[topicMsgs.length - 1];
      if (latestMsg) {
        finalQueue.push(latestMsg);
      }
    }

    return finalQueue;
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const configTopics = this.renderer.config.topics;
    const handler = this.handleSettingsAction;
    const entries: SettingsTreeEntry[] = [];
    for (const topic of this.renderer.topics ?? []) {
      const isPointCloud = topicIsConvertibleToSchema(topic, ALL_POINTCLOUD_DATATYPES);
      if (!isPointCloud) {
        continue;
      }
      const config = (configTopics[topic.name] ?? {}) as Partial<LayerSettingsPointClouds>;
      const messageFields = this.#fieldsByTopic.get(topic.name) ?? POINT_CLOUD_REQUIRED_FIELDS;
      const node: SettingsTreeNodeWithActionHandler = pointSettingsNode(
        topic,
        messageFields,
        config,
      );
      node.fields!.stixelsEnabled = {
        label: "Stixel view",
        input: "boolean",
        value: config.stixelsEnabled ?? DEFAULT_SETTINGS.stixelsEnabled,
      };
      node.handler = handler;
      node.icon = "Points";
      entries.push({ path: ["topics", topic.name], node });
    }
    return entries;
  }

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    // Do not call super.startFrame() since we handle updatePose() manually.
    // Instead of updating the pose for each Renderable in this.renderables, we
    // update the pose of each THREE.Points object in the pointsHistory of each
    // renderable

    for (const [topic, renderable] of this.renderables) {
      if (!renderable.userData.settings.visible) {
        renderable.removeFromParent();
        renderable.dispose();
        this.renderables.delete(topic);
        continue;
      }
      renderable.startFrame(currentTime, renderFrameId, fixedFrameId);
    }
  }

  public override handleSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;
    if (action.action !== "update" || path.length !== 3) {
      return;
    }

    this.saveSetting(path, action.payload.value);

    // Update the renderable
    const topicName = path[1]!;
    const renderable = this.renderables.get(topicName);
    if (renderable) {
      const prevSettings = this.renderer.config.topics[topicName];
      const settings = { ...DEFAULT_SETTINGS, ...prevSettings };
      if (this.#preparedTopics.has(topicName) && settings.decayTime === 0) {
        if (
          ["pointSize", "pointShape", "pointSizeMode", "frameLocked", "visible"].includes(path[2]!)
        ) {
          const current = renderable.userData.settings;
          renderable.updateMaterialSettings({
            ...current,
            pointSize: settings.pointSize,
            pointShape: settings.pointShape,
            pointSizeMode: settings.pointSizeMode,
            frameLocked: settings.frameLocked,
            visible: settings.visible,
          });
          if (this.renderer.canvasVisibility() === "visible") this.renderer.queueAnimationFrame();
        }
        // Color/topology stays with its committed geometry until this revision's worker result.
        return;
      }
      renderable.updatePointCloud(
        renderable.userData.latestPointCloud,
        renderable.userData.latestOriginalMessage,
        settings,
        renderable.userData.receiveTime,
      );
    }
  };

  #handleFoxglovePointCloud = (messageEvent: PartialMessageEvent<PointCloud>): void => {
    const { topic, schemaName } = messageEvent;
    if (this.#preparedTopics.has(topic)) return; // No parallel eligible main-thread CPU handler.
    const pointCloud = normalizePointCloud(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    const messageTime = toNanoSec(pointCloud.timestamp);
    const frameId = pointCloud.frame_id;

    this.#handlePointCloud(
      topic,
      schemaName,
      pointCloud,
      receiveTime,
      messageTime,
      messageEvent.message as RosObject,
      frameId,
    );
  };

  #handleRosPointCloud = (messageEvent: PartialMessageEvent<PointCloud2>): void => {
    const { topic, schemaName } = messageEvent;
    if (this.#preparedTopics.has(topic)) return; // No parallel eligible main-thread CPU handler.
    const pointCloud = normalizePointCloud2(messageEvent.message);
    const receiveTime = toNanoSec(messageEvent.receiveTime);
    const messageTime = toNanoSec(pointCloud.header.stamp);
    const frameId = pointCloud.header.frame_id;

    this.#handlePointCloud(
      topic,
      schemaName,
      pointCloud,
      receiveTime,
      messageTime,
      messageEvent.message as RosObject,
      frameId,
    );
  };

  #handlePointCloud(
    topic: string,
    schemaName: string,
    pointCloud: PointCloud | PointCloud2,
    receiveTime: bigint,
    messageTime: bigint,
    originalMessage: RosObject,
    frameId: string,
    prepared?: PreparedPointCloud,
  ): void {
    // Update the mapping of topic to point cloud field names if necessary
    let fields = this.#fieldsByTopic.get(topic);
    // filter count to compare only supported fields
    const numSupportedFields = pointCloud.fields.reduce((numSupported, field) => {
      return numSupported + (isSupportedField(field) ? 1 : 0);
    }, 0);
    let fieldsForTopicUpdated = false;
    if (fields?.length !== numSupportedFields) {
      // Omit fields with count != 1 (only applies to ros pointclouds)
      // can't use filterMap here because of incompatible types
      fields = pointCloud.fields.filter(isSupportedField).map((field) => field.name);
      this.#fieldsByTopic.set(topic, fields);
      fieldsForTopicUpdated = true;
      this.updateSettingsTree();
    }

    let renderable = this.renderables.get(topic);
    if (!renderable) {
      // Set the initial settings from default values merged with any user settings
      const userSettings = (this.renderer.config.topics[topic] ??
        {}) as Partial<LayerSettingsPointClouds>;
      const settings = { ...DEFAULT_SETTINGS, ...userSettings, ...prepared?.settings };

      // want to avoid setting this if fields didn't update
      if (userSettings.colorField == undefined && fieldsForTopicUpdated) {
        if (prepared == undefined)
          autoSelectColorSettings(settings, fields, {
            supportsPackedRgbModes: ROS_POINTCLOUD_DATATYPES.has(schemaName),
            supportsRgbaFieldsMode: FOXGLOVE_POINTCLOUD_DATATYPES.has(schemaName),
          });

        // Update user settings with the newly selected color field
        this.renderer.updateConfig((draft) => {
          const updatedUserSettings = { ...userSettings };
          updatedUserSettings.colorField = settings.colorField;
          updatedUserSettings.colorMode = settings.colorMode;
          updatedUserSettings.colorMap = settings.colorMap;
          draft.topics[topic] = updatedUserSettings;
        });
        this.updateSettingsTree();
      }

      const material = pointCloudMaterial(settings);
      const pickingMaterial = createPickingMaterial(settings);
      const instancePickingMaterial = createInstancePickingMaterial(settings);
      const stixelMaterial = createStixelMaterial(settings);

      renderable = new PointCloudHistoryRenderable(topic, this.renderer, {
        receiveTime,
        messageTime,
        frameId: this.renderer.normalizeFrameId(frameId),
        pose: makePose(),
        settingsPath: ["topics", topic],
        settings,
        topic,
        latestPointCloud: pointCloud,
        latestOriginalMessage: originalMessage,
        material,
        pickingMaterial,
        instancePickingMaterial,
        stixelMaterial,
      });

      this.add(renderable);
      this.renderables.set(topic, renderable);
    }

    const settings = {
      ...DEFAULT_SETTINGS,
      ...this.renderer.config.topics[topic],
      ...prepared?.settings,
      visible:
        (this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined)
          ?.visible ?? DEFAULT_SETTINGS.visible,
      frameLocked:
        (this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined)
          ?.frameLocked ?? DEFAULT_SETTINGS.frameLocked,
      pointSize:
        (this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined)
          ?.pointSize ?? DEFAULT_SETTINGS.pointSize,
      pointShape:
        (this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined)
          ?.pointShape ?? DEFAULT_SETTINGS.pointShape,
      pointSizeMode:
        (this.renderer.config.topics[topic] as Partial<LayerSettingsPointClouds> | undefined)
          ?.pointSizeMode ?? DEFAULT_SETTINGS.pointSizeMode,
    };

    if (settings.decayTime > 0) {
      renderable.pushHistory(pointCloud, originalMessage, settings, receiveTime);
    }

    renderable.updatePointCloud(pointCloud, originalMessage, settings, receiveTime, prepared);
  }
}

export function createStixelMaterial(settings: LayerSettingsPointClouds): THREE.LineBasicMaterial {
  const transparent = colorHasTransparency(settings);
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent,
    depthWrite: true,
  });
  return material;
}

function createStixelGeometry(topic: string, usage: THREE.Usage): DynamicBufferGeometry {
  const geometry = new DynamicBufferGeometry(usage);
  geometry.name = `${topic}:PointCloud:stixelGeometry`;
  geometry.createAttribute("position", Float32Array, 3);
  geometry.createAttribute("color", Uint8Array, 4, true);
  return geometry;
}

class StixelsRenderable extends Renderable<BaseUserData, /*TRenderer=*/ undefined> {
  public localSampleBounds: THREE.Sphere | undefined;
  #stixels: THREE.LineSegments<DynamicBufferGeometry, THREE.LineBasicMaterial>;
  public readonly geometry: DynamicBufferGeometry;

  public constructor(
    name: string,
    userData: BaseUserData,
    geometry: DynamicBufferGeometry,
    material: THREE.LineBasicMaterial,
  ) {
    super(name, undefined, userData);
    this.geometry = geometry;
    const stixels = new THREE.LineSegments<DynamicBufferGeometry, THREE.LineBasicMaterial>(
      geometry,
      material,
    );
    // We don't calculate the bounding sphere for points, so frustum culling is disabled
    stixels.frustumCulled = false;
    stixels.name = `${userData.topic}:PointCloud:stixels`;
    this.#stixels = stixels;
    this.add(stixels);
  }

  public override dispose(): void {
    this.#stixels.geometry.dispose();
  }

  public setPointCloudFrustumCulling(enabled: boolean): void {
    this.#stixels.frustumCulled = enabled;
  }

  public updateMaterial(material: THREE.LineBasicMaterial) {
    this.#stixels.material = material;
  }
}
