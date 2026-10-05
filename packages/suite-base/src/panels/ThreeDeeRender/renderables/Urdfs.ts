import {
  UrdfVisualInstances,
  highestLogicalTarget,
  type UrdfInstancePart,
} from "./urdfVisualInstances";
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { vec3 } from "gl-matrix";
import i18next from "i18next";
import * as _ from "lodash-es";
import * as THREE from "three";
import { v4 as uuidv4 } from "uuid";

import { filterMap } from "@lichtblick/den/collection";
import {
  UrdfGeometryMesh,
  UrdfRobot,
  UrdfVisual,
  parseRobot,
  UrdfJoint,
} from "@lichtblick/den/urdf";
import Logger from "@lichtblick/log";
import { toNanoSec } from "@lichtblick/rostime";
import {
  SettingsTreeAction,
  SettingsTreeChildren,
  SettingsTreeField,
  SettingsTreeFields,
} from "@lichtblick/suite";
import { makeRgba, stringToRgba } from "@lichtblick/suite-base/panels/ThreeDeeRender/color";
import { eulerToQuaternion } from "@lichtblick/suite-base/util/geometry";
import isDesktopApp from "@lichtblick/suite-base/util/isDesktopApp";
import { isValidUrl } from "@lichtblick/suite-base/util/isValidURL";

import { RenderableCube } from "./markers/RenderableCube";
import { RenderableCylinder } from "./markers/RenderableCylinder";
import { RenderableMeshResource } from "./markers/RenderableMeshResource";
import { RenderableSphere } from "./markers/RenderableSphere";
import { missingTransformMessage, MISSING_TRANSFORM } from "./transforms";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { BaseUserData, Renderable } from "../Renderable";
import { PartialMessageEvent, SceneExtension, onlyLastByTopicMessage } from "../SceneExtension";
import { SettingsTreeEntry } from "../SettingsManager";
import {
  ColorRGBA,
  JointState,
  JOINTSTATE_DATATYPES,
  Marker,
  MarkerAction,
  MarkerType,
  Quaternion,
  Vector3,
} from "../ros";
import {
  BaseSettings,
  CustomLayerSettings,
  PRECISION_DEGREES,
  PRECISION_DISTANCE,
} from "../settings";
import { Pose, makePose, TransformTree } from "../transforms";
import { updatePose } from "../updatePose";
import { customUrdfLayerNeedsReload, urdfLayerDisplayScale } from "./customUrdfLayer";
import { URDF_COARSEN_ERROR_PIXELS } from "../lod";
import type { PickedRenderable } from "../Picker";
import {
  parseVisualManifest,
  projectedVisualError,
  selectVisualVariant,
  visualKinematicIdentity,
  visualManifestUri,
  visualVariantUri,
  type VisualVariantManifest,
} from "./urdfVisualLod";

const log = Logger.getLogger(__filename);

const LAYER_ID = "foxglove.Urdf";
const TOPIC_NAME = "/robot_description";

/** ID of fake "topic" used to represent the /robot_description parameter */
const PARAM_KEY = "param:/robot_description";
/** Standard parameter name used for URDF data in ROS */
const PARAM_NAME = "/robot_description";
const PARAM_DISPLAY_NAME = "/robot_description (parameter)";

const VALID_SRC_ERR = "ValidSrc";
const FETCH_URDF_ERR = "FetchUrdf";
const PARSE_URDF_ERR = "ParseUrdf";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const DEFAULT_COLOR_STR = "#ffffff";
const DEFAULT_COLOR = stringToRgba(makeRgba(), DEFAULT_COLOR_STR);
const VEC3_ONE = { x: 1, y: 1, z: 1 };
const XYZ_LABEL: [string, string, string] = ["X", "Y", "Z"];
const RPY_LABEL: [string, string, string] = ["R", "P", "Y"];

export type LayerSettingsUrdf = BaseSettings & {
  instanceId: string; // This will be set to the topic name
  displayMode: "auto" | "visual" | "collision";
  label: string;
  fallbackColor?: string;
};

export type LayerSettingsCustomUrdf = CustomLayerSettings & {
  layerId: "foxglove.Urdf";
  sourceType: "url" | "filePath" | "param" | "topic";
  url?: string;
  filePath?: string;
  parameter?: string;
  topic?: string;
  framePrefix: string;
  displayMode: "auto" | "visual" | "collision";
  fallbackColor?: string;
  /** Viewer-only uniform display factor; 1 keeps true dimensions. */
  scale?: number;
};

const DEFAULT_SETTINGS: LayerSettingsUrdf = {
  visible: false,
  frameLocked: true,
  instanceId: "invalid",
  displayMode: "auto",
  label: "URDF",
  fallbackColor: DEFAULT_COLOR_STR,
};

const DEFAULT_CUSTOM_SETTINGS: LayerSettingsCustomUrdf = {
  visible: true,
  frameLocked: true,
  label: "URDF",
  instanceId: "invalid",
  layerId: LAYER_ID,
  sourceType: "url",
  url: "",
  filePath: "",
  parameter: "",
  topic: "",
  framePrefix: "",
  displayMode: "auto",
  fallbackColor: DEFAULT_COLOR_STR,
  scale: 1,
};

const MANAGED_URDF_LAYER_PREFIX = "xgc2-urdf-";

const URDF_TOPIC_SCHEMAS = new Set<string>(["std_msgs/String", "std_msgs/msg/String"]);

const tempVec3a = new THREE.Vector3();
const tempVec3b = new THREE.Vector3();
const tempQuaternion1 = new THREE.Quaternion();
const tempQuaternion2 = new THREE.Quaternion();
const tempEuler = new THREE.Euler();

const IDENTITY_POSE: Pose = makePose();
const scaledChainRootPose: Pose = makePose();
const scaledChainRelPose: Pose = makePose();
const scaledChainVec = new THREE.Vector3();
const scaledChainQuat = new THREE.Quaternion();
const scaledChainQuat2 = new THREE.Quaternion();

export type UrdfUserData = BaseUserData & {
  settings: LayerSettingsUrdf | LayerSettingsCustomUrdf;
  fetching?: { url: string; control: AbortController };
  urdf: string | undefined;
  sourceType: LayerSettingsCustomUrdf["sourceType"] | undefined;
  parameter: string | undefined;
  renderables: Map<string, Renderable>;
};

enum EmbeddedMaterialUsage {
  Use,
  Ignore,
}

type TransformData = {
  parent: string;
  child: string;
  translation: Vector3;
  rotation: Quaternion;
  joint: UrdfJoint;
};

type ParsedUrdf = {
  robot: UrdfRobot;
  frames: string[];
  transforms: TransformData[];
};

type JointPosition = {
  timestamp: bigint;
  position: number;
};

type UrdfVisualLodState = {
  manifest: VisualVariantManifest;
  manifestUri: string;
  kinematicIdentity: string;
  current: string;
  requested?: string;
  failed?: string;
};

type UrdfVisualChild = Renderable & {
  /** Existing renderable map key stays stable across different visual geometry types. */
  visualRadius?: number;
  parkedMatrices?: { object: THREE.Object3D; local: boolean; world: boolean }[];
};

export class UrdfRenderable extends Renderable<UrdfUserData> {
  public loadGeneration = 0;
  public committedVisualGeneration = 0;
  public visualLod?: UrdfVisualLodState;
  /** Source/settings request is separate from the last complete drawable combination. */
  public requestedVisual?: UrdfUserData;
  public jointInspection = false;
  /** One detached in-progress model, owned/disposed by this same renderable. */
  public pendingVisual?: UrdfRenderable;

  public override dispose(): void {
    ++this.loadGeneration;
    this.pendingVisual?.dispose();
    this.pendingVisual = undefined;
    this.userData.fetching?.control.abort();
    this.removeChildren();
    this.userData.urdf = undefined;
    super.dispose();
  }

  public removeChildren(): void {
    ++this.committedVisualGeneration;
    setVisualWork(this, "visible");
    for (const childRenderable of this.userData.renderables.values()) {
      setVisualWork(childRenderable, "visible");
      childRenderable.dispose();
    }
    this.children.length = 0;
    this.userData.renderables.clear();
  }
}

export class Urdfs extends SceneExtension<UrdfRenderable> {
  public static extensionId = "foxglove.Urdfs";
  #framesByInstanceId = new Map<string, string[]>();
  #transformsByInstanceId = new Map<string, TransformData[]>();
  #rootFramesByInstanceId = new Map<string, string>();
  #jointStates = new Map<string, JointPosition>();
  #textDecoder = new TextDecoder();
  #urdfsByTopic = new Map<string, string>();
  #pendingLoads = new Set<Promise<void>>();
  #managedLayersIdentity: IRenderer["config"]["layers"] | undefined;
  #managedMembershipDirty = true;
  #selection: PickedRenderable | undefined;
  #visualInstances = new UrdfVisualInstances();
  #visualMembershipDirty = true;
  readonly #viewProjection = new THREE.Matrix4();
  readonly #frustum = new THREE.Frustum();
  readonly #modelSphere = new THREE.Sphere();
  readonly #visualBounds = new THREE.Box3();
  readonly #boundsMin = new THREE.Vector3();
  readonly #boundsMax = new THREE.Vector3();
  readonly #drawingSize = new THREE.Vector2();
  readonly #modelCenter = new THREE.Vector3();

  #handleSelection = (selection: PickedRenderable | undefined): void => {
    this.#selection = selection;
  };

  public override dispose(): void {
    this.#visualInstances.dispose();
    this.renderer.off("selectedRenderable", this.#handleSelection);
    super.dispose();
  }

  #trackLoad(promise: Promise<void>): void {
    this.#pendingLoads.add(promise);
    void promise.finally(() => this.#pendingLoads.delete(promise));
  }

  public override async settleVideoDecodes(): Promise<void> {
    // Fetch can enqueue parsing; drain the actual promises, never a timer.
    while (this.#pendingLoads.size > 0) {
      await Promise.all(this.#pendingLoads);
    }
  }

  /** Read the existing parsed robot roots on UI input; no TF-to-React forwarding. */
  public robotFollowFrames(): { label: string; value: string }[] {
    return Array.from(this.#rootFramesByInstanceId, ([instanceId, frameId]) => ({
      label:
        (
          this.renderables.get(instanceId)?.userData.settings as
            | Partial<LayerSettingsCustomUrdf>
            | undefined
        )?.label ?? instanceId,
      value: frameId,
    }));
  }

  public constructor(renderer: IRenderer, name: string = Urdfs.extensionId) {
    super(name, renderer);
    this.add(this.#visualInstances);

    renderer.on("parametersChange", this.#handleParametersChange);
    renderer.on("selectedRenderable", this.#handleSelection);
    renderer.addCustomLayerAction({
      layerId: LAYER_ID,
      label: i18next.t("threeDee:addURDF"),
      icon: "PrecisionManufacturing",
      handler: this.#handleAddUrdf,
    });

    // Load existing URDF layers from the config
    for (const [instanceId, entry] of Object.entries(renderer.config.layers)) {
      if (entry?.layerId === LAYER_ID) {
        this.#loadUrdf({ instanceId, urdf: undefined });
      }
    }
  }

  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    return [
      {
        type: "topic",
        topicName: TOPIC_NAME,
        subscription: {
          handler: this.#handleRobotDescription,
          filterQueue: onlyLastByTopicMessage,
        },
      },

      // Note that this subscription will never happen because it does not appear as a topic in the
      // topic list that can have its visibility toggled on. The ThreeDeeRender subscription logic
      // needs to become more flexible to make this possible
      {
        type: "schema",
        schemaNames: JOINTSTATE_DATATYPES,
        subscription: {
          handler: this.#handleJointState,
          filterQueue: onlyLastByTopicMessage,
        },
      },

      {
        type: "schema",
        schemaNames: URDF_TOPIC_SCHEMAS,
        subscription: {
          shouldSubscribe: this.#shouldSubscribe,
          handler: this.#handleRobotDescription,
          filterQueue: onlyLastByTopicMessage,
        },
      },
    ];
  }

  public override settingsNodes(): SettingsTreeEntry[] {
    const entries: SettingsTreeEntry[] = [];
    const baseDisplayModeField: SettingsTreeField = {
      label: "Display mode",
      input: "select",
      options: [
        {
          label: "Auto",
          value: "auto",
        },
        {
          label: "Visual",
          value: "visual",
        },
        {
          label: "Collision",
          value: "collision",
        },
      ],
    };
    const baseFallbackColorField: SettingsTreeField = {
      label: "Color",
      help: "Fallback color used in case a link does not specify any color itself",
      input: "rgb",
    };

    // /robot_description topic entry
    const topic = this.renderer.topicsByName?.get(TOPIC_NAME);
    if (topic != undefined) {
      const config = (this.renderer.config.topics[TOPIC_NAME] ?? {}) as Partial<LayerSettingsUrdf>;
      const fields: SettingsTreeFields = {
        displayMode: {
          ...baseDisplayModeField,
          value: config.displayMode ?? DEFAULT_SETTINGS.displayMode,
        },
        fallbackColor: {
          ...baseFallbackColorField,
          value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
        },
      };
      entries.push({
        path: ["topics", TOPIC_NAME],
        node: {
          label: TOPIC_NAME,
          icon: "PrecisionManufacturing",
          fields,
          visible: config.visible ?? DEFAULT_SETTINGS.visible,
          handler: this.#handleTopicSettingsAction,
          children: urdfChildren(
            this.#transformsByInstanceId.get(TOPIC_NAME),
            this.renderer.transformTree,
            this.#jointStates,
          ),
        },
      });
    }

    // /robot_description parameter entry
    const parameter = this.renderer.parameters?.get(PARAM_NAME);
    if (parameter != undefined) {
      const config = (this.renderer.config.topics[PARAM_KEY] ?? {}) as Partial<LayerSettingsUrdf>;

      const fields: SettingsTreeFields = {
        displayMode: {
          ...baseDisplayModeField,
          value: config.displayMode ?? DEFAULT_SETTINGS.displayMode,
        },
        fallbackColor: {
          ...baseFallbackColorField,
          value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
        },
      };

      entries.push({
        path: ["topics", PARAM_KEY],
        node: {
          label: PARAM_DISPLAY_NAME,
          icon: "PrecisionManufacturing",
          fields,
          visible: config.visible ?? DEFAULT_SETTINGS.visible,
          handler: this.#handleTopicSettingsAction,
          children: urdfChildren(
            this.#transformsByInstanceId.get(PARAM_KEY),
            this.renderer.transformTree,
            this.#jointStates,
          ),
        },
      });
    }

    // Custom layer entries
    for (const [instanceId, layerConfig] of Object.entries(this.renderer.config.layers)) {
      if (layerConfig?.layerId === LAYER_ID) {
        const config = layerConfig as Partial<LayerSettingsCustomUrdf>;

        const fields: SettingsTreeFields = {
          sourceType: {
            label: "Source",
            input: "select",
            value: config.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType,
            options: [
              {
                label: "URL",
                value: "url",
              },
              {
                label: "File path (Desktop only)",
                value: "filePath",
                disabled: !isDesktopApp(),
              },
              {
                label: "Parameter",
                value: "param",
              },
              {
                label: "Topic",
                value: "topic",
              },
            ],
          },
          url:
            (config.sourceType ?? DEFAULT_CUSTOM_SETTINGS.sourceType) === "url"
              ? {
                  label: "URL",
                  input: "string",
                  placeholder: "package://",
                  help: "package:// URL or http(s) URL pointing to a Unified Robot Description Format (URDF) XML file",
                  value: config.url ?? DEFAULT_CUSTOM_SETTINGS.url,
                }
              : undefined,
          filePath:
            config.sourceType === "filePath"
              ? {
                  label: "File path",
                  input: "string",
                  help: "Absolute file path (desktop app only)",
                  value: config.filePath ?? DEFAULT_CUSTOM_SETTINGS.filePath,
                  disabled: !isDesktopApp(),
                }
              : undefined,
          topic:
            config.sourceType === "topic"
              ? {
                  label: "Topic",
                  input: "autocomplete",
                  value: config.topic ?? DEFAULT_CUSTOM_SETTINGS.topic,
                  items: filterMap(this.renderer.topics ?? [], (_topic) =>
                    URDF_TOPIC_SCHEMAS.has(_topic.schemaName) ? _topic.name : undefined,
                  ),
                }
              : undefined,
          parameter:
            config.sourceType === "param"
              ? {
                  label: "Parameter",
                  input: "autocomplete",
                  value: config.parameter ?? DEFAULT_CUSTOM_SETTINGS.parameter,
                  items: filterMap(this.renderer.parameters ?? [], ([paramName, value]) =>
                    typeof value === "string" ? paramName : undefined,
                  ),
                }
              : undefined,
          label: {
            label: "Label",
            input: "string",
            value: config.label ?? DEFAULT_CUSTOM_SETTINGS.label,
          },
          framePrefix: {
            label: "Frame prefix",
            input: "string",
            help: "Prefix to apply to all frame names (also often called tfPrefix)",
            placeholder: "Frame prefix",
            value: config.framePrefix ?? "",
          },
          displayMode: {
            ...baseDisplayModeField,
            value: config.displayMode ?? DEFAULT_CUSTOM_SETTINGS.displayMode,
          },
          fallbackColor: {
            ...baseFallbackColorField,
            value: config.fallbackColor ?? DEFAULT_SETTINGS.fallbackColor,
          },
          scale: {
            label: "Scale",
            input: "number",
            help: "Display-only uniform scale for this robot model. Transforms, camera projection, and the simulator keep true dimensions.",
            min: 0.1,
            max: 20,
            step: 0.1,
            precision: 2,
            value: config.scale ?? DEFAULT_CUSTOM_SETTINGS.scale,
          },
        };

        entries.push({
          path: ["layers", instanceId],
          node: {
            label: config.label ?? "Grid",
            icon: "PrecisionManufacturing",
            fields,
            visible: config.visible ?? DEFAULT_CUSTOM_SETTINGS.visible,
            actions: [
              { type: "action", id: "duplicate", label: "Duplicate" },
              { type: "action", id: "delete", label: "Delete" },
            ],
            order: layerConfig.order,
            handler: this.#handleLayerSettingsAction,
            children: urdfChildren(
              this.#transformsByInstanceId.get(instanceId),
              this.renderer.transformTree,
              this.#jointStates,
            ),
          },
        });
      }
    }

    return entries;
  }

  public override removeAllRenderables(): void {
    this.#visualMembershipDirty = true;
    this.#managedMembershipDirty = true;
    // Re-add coordinate frames and transforms since the scene has been cleared
    this.#refreshTransforms();
  }

  /**
   * Re-add coordinate frames and transforms corresponding to existing custom URDFs
   */
  #refreshTransforms() {
    for (const [instanceId, frames] of this.#framesByInstanceId) {
      this.#loadFrames(instanceId, frames);
    }
    for (const [instanceId, transforms] of this.#transformsByInstanceId) {
      this.#loadTransforms(instanceId, transforms);
    }
  }

  public override prepareVisualDraw(): boolean {
    if (this.#visualMembershipDirty) {
      const parts: UrdfInstancePart[] = [];
      for (const [instanceId, owner] of this.renderables) {
        const generation = owner.committedVisualGeneration;
        for (const [key, child] of owner.userData.renderables) {
          if (!(child instanceof RenderableMeshResource)) continue;
          const assetParts = child.getVisualInstanceParts();
          for (const source of assetParts)
            parts.push({
              ...source,
              source: child,
              logicalTarget: highestLogicalTarget(child),
              sourceGeneration: generation,
              isCurrent: () =>
                this.renderables.get(instanceId) === owner &&
                owner.committedVisualGeneration === generation &&
                owner.userData.renderables.get(key) === child &&
                child.parent === owner &&
                child.getVisualInstanceParts() === assetParts,
            });
        }
      }
      this.#visualInstances.replaceParts(parts);
      this.#visualMembershipDirty = false;
    }
    return this.#visualInstances.prepareDraw();
  }

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    this.#syncManagedUrdfLayers();
    for (const renderable of this.renderables.values()) {
      const path = renderable.userData.settingsPath;
      let missingFrameId: string | undefined;

      renderable.visible =
        renderable.requestedVisual?.settings.visible ?? renderable.userData.settings.visible;
      if (!renderable.visible) {
        setVisualWork(renderable, "parked");
        this.renderer.settings.errors.clearPath(path);
        continue;
      }

      const scale =
        this.renderer.interfaceMode === "image"
          ? 1
          : urdfLayerDisplayScale(renderable.userData.settings as Partial<LayerSettingsCustomUrdf>);
      const rootFrameId =
        scale === 1
          ? undefined
          : this.#rootFramesByInstanceId.get(renderable.userData.settings.instanceId);
      let scaledRootPose: Pose | undefined;
      let scaledRootResolved = false;

      setVisualWork(renderable, "visible");
      this.#visualBounds.makeEmpty();
      let reliableBounds = true;
      // UrdfRenderables always stay at the origin. Their children renderables
      // are individually updated since each child exists in a different frame
      for (const childRenderable of renderable.userData.renderables.values()) {
        const srcTime = currentTime;
        const frameId = childRenderable.userData.frameId;
        let updated: boolean;
        if (rootFrameId != undefined) {
          if (!scaledRootResolved) {
            scaledRootPose = this.#poseInRenderFrame(
              rootFrameId,
              renderFrameId,
              fixedFrameId,
              currentTime,
            );
            scaledRootResolved = true;
          }
          updated =
            scaledRootPose != undefined &&
            this.#applyScaledChildPose(
              childRenderable,
              scaledRootPose,
              rootFrameId,
              frameId,
              scale,
              currentTime,
            );
        } else {
          updated = updatePose(
            childRenderable,
            this.renderer.transformTree,
            renderFrameId,
            fixedFrameId,
            frameId,
            currentTime,
            srcTime,
          );
        }
        if (!updated) missingFrameId = frameId;
        const radius = (childRenderable as UrdfVisualChild).visualRadius;
        if (!updated || radius == undefined || !Number.isFinite(radius)) reliableBounds = false;
        else {
          // Live absolute TF and generic frame offsets are legal even beyond XML joint origins.
          this.#boundsMin.copy(childRenderable.position).addScalar(-radius);
          this.#boundsMax.copy(childRenderable.position).addScalar(radius);
          this.#visualBounds.expandByPoint(this.#boundsMin);
          this.#visualBounds.expandByPoint(this.#boundsMax);
        }
      }

      // The layer has one transform error slot. Publish its final value once,
      // instead of replacing it for every missing link in the same frame.
      if (missingFrameId != undefined) {
        this.renderer.settings.errors.add(
          path,
          MISSING_TRANSFORM,
          missingTransformMessage(renderFrameId, fixedFrameId, missingFrameId),
        );
      } else {
        this.renderer.settings.errors.remove(path, MISSING_TRANSFORM);
      }

      const camera = this.renderer.cameraHandler?.getActiveCamera();
      const precise =
        this.renderer.debugPicking ||
        renderable.jointInspection ||
        this.#selectionBelongsTo(renderable) ||
        missingFrameId != undefined;
      let estimate: (assetMetres: number) => number | undefined = () => undefined;
      let projectionReady = false;
      if (camera != undefined && reliableBounds && !this.#visualBounds.isEmpty()) {
        camera.updateMatrixWorld();
        this.renderer.gl.getDrawingBufferSize(this.#drawingSize);
        projectionReady = true;
        this.#visualBounds.getBoundingSphere(this.#modelSphere);
        this.#modelCenter.copy(this.#modelSphere.center);
        this.#viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.#frustum.setFromProjectionMatrix(this.#viewProjection);
        if (!precise && !this.#frustum.intersectsSphere(this.#modelSphere)) {
          renderable.visible = false;
          setVisualWork(renderable, "parked");
          continue;
        }
        const radius = this.#modelSphere.radius;
        estimate = (metres) =>
          projectedVisualError(
            camera,
            this.#drawingSize,
            this.#modelCenter,
            radius,
            metres * scale,
          );
      }
      const state = renderable.visualLod;
      if (
        state != undefined &&
        renderable.requestedVisual == undefined &&
        renderable.userData.settings.displayMode !== "collision"
      ) {
        const next = selectVisualVariant(state.manifest, state.current, estimate, precise);
        if (next === state.current && state.requested != undefined) {
          ++renderable.loadGeneration;
          renderable.pendingVisual?.dispose();
          renderable.pendingVisual = undefined;
          state.requested = undefined;
        } else if (next !== state.current && next !== state.requested && next !== state.failed) {
          this.#loadVisualVariant(renderable, next);
        }
      }
      const roles = state?.manifest.viewer_lod?.link_roles;
      const prefix =
        (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).framePrefix ?? "";
      for (const child of renderable.userData.renderables.values()) {
        const frame = child.userData.frameId;
        const local = frame.startsWith(prefix) ? frame.slice(prefix.length) : frame;
        const radius = (child as UrdfVisualChild).visualRadius;
        const pixels =
          !projectionReady || camera == undefined || radius == undefined
            ? undefined
            : projectedVisualError(camera, this.#drawingSize, child.position, radius, 2 * radius);
        if (
          !precise &&
          child.visible &&
          roles?.[local] === "decorative_rotation" &&
          pixels != undefined &&
          pixels <= URDF_COARSEN_ERROR_PIXELS
        ) {
          child.visible = false;
          setVisualWork(child, "parked");
        } else setVisualWork(child, "visible");
      }
    }
  }

  /** Pose of `frameId` in the render frame, or undefined when the chain is incomplete. */
  #poseInRenderFrame(
    frameId: string,
    renderFrameId: string,
    fixedFrameId: string,
    time: bigint,
  ): Pose | undefined {
    return this.renderer.transformTree.apply(
      scaledChainRootPose,
      IDENTITY_POSE,
      renderFrameId,
      fixedFrameId,
      frameId,
      time,
      time,
    );
  }

  /**
   * Viewer-only display scale: place the child as
   * `rootPose ⊕ (scale · rel.t, rel.q) ⊕ visualPose`, where rel is the live
   * root→link transform from the shared tree. Dynamic joint TF (spinning
   * rotors, wheels) keeps its rotation and only its translation rides the
   * factor, so the whole robot grows uniformly about its root while every
   * other consumer of the tree keeps true dimensions.
   */
  #applyScaledChildPose(
    childRenderable: Renderable,
    rootPose: Readonly<Pose>,
    rootFrameId: string,
    frameId: string,
    scale: number,
    time: bigint,
  ): boolean {
    const rel = this.renderer.transformTree.apply(
      scaledChainRelPose,
      IDENTITY_POSE,
      rootFrameId,
      rootFrameId,
      frameId,
      time,
      time,
    );
    if (!rel) {
      childRenderable.visible = false;
      return false;
    }
    const pose = childRenderable.userData.pose as Readonly<Pose>;
    scaledChainQuat.set(
      rootPose.orientation.x,
      rootPose.orientation.y,
      rootPose.orientation.z,
      rootPose.orientation.w,
    );
    scaledChainVec
      .set(rel.position.x * scale, rel.position.y * scale, rel.position.z * scale)
      .applyQuaternion(scaledChainQuat);
    const baseX = rootPose.position.x + scaledChainVec.x;
    const baseY = rootPose.position.y + scaledChainVec.y;
    const baseZ = rootPose.position.z + scaledChainVec.z;
    scaledChainQuat.multiply(
      scaledChainQuat2.set(
        rel.orientation.x,
        rel.orientation.y,
        rel.orientation.z,
        rel.orientation.w,
      ),
    );
    scaledChainVec
      .set(pose.position.x, pose.position.y, pose.position.z)
      .applyQuaternion(scaledChainQuat);
    childRenderable.position.set(
      baseX + scaledChainVec.x,
      baseY + scaledChainVec.y,
      baseZ + scaledChainVec.z,
    );
    childRenderable.quaternion.copy(
      scaledChainQuat.multiply(
        scaledChainQuat2.set(
          pose.orientation.x,
          pose.orientation.y,
          pose.orientation.z,
          pose.orientation.w,
        ),
      ),
    );
    childRenderable.visible = true;
    return true;
  }

  #handleTopicSettingsAction = (action: SettingsTreeAction): void => {
    if (action.action === "update") {
      this.#handleSettingsUpdate(action);
      return;
    }
  };

  #handleLayerSettingsAction = (action: SettingsTreeAction): void => {
    const path = action.payload.path;

    // Handle menu actions (duplicate / delete)
    if (action.action === "perform-node-action" && path.length === 2) {
      const instanceId = path[1]!;
      if (action.payload.id === "delete") {
        this.#removeCustomUrdf(instanceId, { updateConfig: true });
      } else if (action.payload.id === "duplicate") {
        const newInstanceId = uuidv4();
        const config = {
          ...this.renderer.config.layers[instanceId],
          instanceId: newInstanceId,
        };

        // Add the new instance to the config
        this.renderer.updateConfig((draft) => {
          draft.layers[newInstanceId] = config;
        });

        // Add the URDF renderable
        const renderable = this.renderables.get(instanceId);
        this.#loadUrdf({
          instanceId: newInstanceId,
          urdf: renderable?.userData.urdf,
        });

        // Update the settings tree
        this.updateSettingsTree();
        this.renderer.updateCustomLayersCount();
      }
    } else if (action.action === "update") {
      this.#handleSettingsUpdate(action);
    }
  };

  #handleSettingsUpdate = (action: { action: "update" } & SettingsTreeAction): void => {
    const path = action.payload.path;

    if (path.length === 5 && path[2] === "joints") {
      // ["layers", instanceId, "joints", jointName, "manual"]
      const instanceId = path[1]!;
      const jointName = path[3]!;
      const transforms = this.#transformsByInstanceId.get(instanceId);
      if (!transforms) {
        return;
      }

      const transformData = transforms.find((t) => t.joint.name === jointName);
      if (!transformData) {
        return;
      }

      const inspected = this.renderables.get(instanceId);
      if (inspected != undefined) inspected.jointInspection = true;
      const joint = transformData.joint;
      const frame = this.renderer.transformTree.getOrCreateFrame(transformData.child);
      const frameKey = `frame:${frame.id}`;
      const isAngular = joint.jointType === "revolute" || joint.jointType === "continuous";
      const axis = tempVec3a.set(joint.axis.x, joint.axis.y, joint.axis.z);

      if (isAngular) {
        const degrees = action.payload.value as number;
        const quaternion = tempQuaternion1.setFromAxisAngle(axis, degrees * DEG2RAD);
        const euler = tempEuler.setFromQuaternion(quaternion);
        frame.offsetEulerDegrees = [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG];
        this.saveSetting(["transforms", frameKey, "rpyCoefficient"], frame.offsetEulerDegrees);
      } else {
        const scale = action.payload.value as number;
        axis.multiplyScalar(scale);
        frame.offsetPosition = [axis.x, axis.y, axis.z];
        this.saveSetting(["transforms", frameKey, "xyzOffset"], frame.offsetPosition);
      }
    } else if (path.length === 3) {
      // ["layers", instanceId, field]
      this.saveSetting(path, action.payload.value);
      const [_layers, instanceId, field] = path as [string, string, string];
      const renderable = this.renderables.get(instanceId);
      const sourceData = renderable?.requestedVisual ?? renderable?.userData;
      let urdf = sourceData?.urdf;

      if (field === "url" || field === "filePath") {
        this.#debouncedLoadUrdf({ instanceId, urdf: undefined });
      } else if (field === "parameter") {
        urdf = this.renderer.parameters?.get(action.payload.value as string) as string | undefined;
        this.#debouncedLoadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "framePrefix") {
        this.#debouncedLoadUrdf({ instanceId, urdf, forceReload: true });
      } else if (
        field === "displayMode" ||
        field === "visible" ||
        field === "fallbackColor" ||
        field === "scale"
      ) {
        this.#loadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "sourceType") {
        const sourceType = action.payload.value as LayerSettingsCustomUrdf["sourceType"];
        if (sourceType === "topic") {
          urdf = sourceData?.topic ? this.#urdfsByTopic.get(sourceData.topic) : undefined;
        } else if (sourceType === "param") {
          urdf = sourceData?.parameter
            ? (this.renderer.parameters?.get(sourceData.parameter) as string | undefined)
            : undefined;
        } else {
          urdf = undefined;
        }
        this.#loadUrdf({ instanceId, urdf, forceReload: true });
      } else if (field === "topic") {
        urdf = this.#urdfsByTopic.get(action.payload.value as string);
        this.#loadUrdf({ instanceId, urdf });
      } else {
        this.#loadUrdf({ instanceId, urdf });
      }
    }
  };

  #handleRobotDescription = (messageEvent: PartialMessageEvent<{ data: string }>): void => {
    const topic = messageEvent.topic;
    const robotDescription = messageEvent.message.data;
    if (typeof robotDescription !== "string") {
      return;
    }
    this.#urdfsByTopic.set(topic, robotDescription);

    if (topic === TOPIC_NAME) {
      this.#loadUrdf({ instanceId: TOPIC_NAME, urdf: robotDescription });
    }

    // Update custom layer URDFs that subscribe to this topic.
    const subscribedInstanceIds = filterMap(this.renderables, ([instanceId, renderable]) => {
      const source = renderable.requestedVisual ?? renderable.userData;
      return source.sourceType === "topic" && source.topic === topic ? instanceId : undefined;
    });
    for (const instanceId of subscribedInstanceIds) {
      this.#loadUrdf({ instanceId, urdf: robotDescription });
    }
  };

  #shouldSubscribe = (topic: string): boolean => {
    return Array.from(this.renderables.values()).some((renderable) => {
      const source = renderable.requestedVisual ?? renderable.userData;
      return source.sourceType === "topic" && source.topic === topic;
    });
  };

  #handleJointState = (messageEvent: PartialMessageEvent<JointState>): void => {
    const msg = messageEvent.message;
    const names = msg.name ?? [];
    const positions = msg.position ?? [];
    const timestamp = toNanoSec(messageEvent.receiveTime);

    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const position = positions[i] ?? 0;

      const prevTimestamp = this.#jointStates.get(name)?.timestamp;
      if (prevTimestamp == undefined || timestamp >= prevTimestamp) {
        this.#jointStates.set(name, { timestamp, position });
      }
    }
  };

  #handleParametersChange = (parameters: ReadonlyMap<string, unknown> | undefined): void => {
    const robotDescription = parameters?.get(PARAM_NAME);
    if (typeof robotDescription === "string") {
      this.#loadUrdf({ instanceId: PARAM_KEY, urdf: robotDescription });
    }

    // Update custom layer URDFs that use parameters.
    for (const [instanceId, renderable] of this.renderables.entries()) {
      const sourceSettings = (renderable.requestedVisual ?? renderable.userData)
        .settings as Partial<LayerSettingsCustomUrdf>;
      const sourceType = sourceSettings.sourceType;
      const paramName = sourceSettings.parameter;
      if (sourceType === "param" && paramName != undefined) {
        const urdf = parameters?.get(paramName);
        if (typeof urdf === "string") {
          this.#loadUrdf({ instanceId, urdf });
        }
      }
    }
  };

  #handleAddUrdf = (instanceId: string): void => {
    log.info(`Creating ${LAYER_ID} layer ${instanceId}`);

    const config: LayerSettingsCustomUrdf = {
      ...DEFAULT_CUSTOM_SETTINGS,
      instanceId,
    };

    // Add this instance to the config
    this.renderer.updateConfig((draft) => {
      const maxOrderLayer = _.maxBy(Object.values(draft.layers), (layer) => layer?.order);
      const order = 1 + (maxOrderLayer?.order ?? 0);
      draft.layers[instanceId] = { ...config, order };
    });

    // Add the URDF renderable
    this.#loadUrdf({ instanceId, urdf: undefined });

    // Update the settings tree
    this.updateSettingsTree();
  };

  #fetchUrdf(instanceId: string, url: string): void {
    const renderable = this.renderables.get(instanceId);
    if (!renderable) {
      throw new Error(`_fetchUrdf() should only be called for existing renderables`);
    }

    // Check if a valid URL was provided
    if (!isValidUrl(url)) {
      const path = renderable.userData.settingsPath;
      this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid URDF URL: "${url}"`);
      return;
    }
    this.renderer.settings.errors.remove(renderable.userData.settingsPath, VALID_SRC_ERR);

    if (renderable.userData.fetching) {
      // Check if this fetch is already in progress
      if (renderable.userData.fetching.url === url) {
        return;
      }

      // Cancel the previous fetch
      renderable.userData.fetching.control.abort();
    }

    log.debug(`Fetching URDF from ${url}`);
    const control = new AbortController();
    renderable.userData.fetching = { url, control };
    this.#trackLoad(
      this.renderer
        .fetchAsset(url, { signal: control.signal })
        .then((urdf) => {
          if (control.signal.aborted || this.renderables.get(instanceId) !== renderable) {
            return;
          }
          log.debug(`Fetched ${urdf.data.length} byte URDF from ${url}`);
          this.renderer.settings.errors.remove(["layers", instanceId], FETCH_URDF_ERR);
          this.#loadUrdf({
            instanceId,
            urdf: this.#textDecoder.decode(urdf.data),
          });
        })
        .catch((e: unknown) => {
          if (control.signal.aborted || this.renderables.get(instanceId) !== renderable) {
            return;
          }
          const err = e as Error;
          const hasError = !err.message.startsWith("Failed to fetch");
          const errMessage = `Failed to load URDF from "${url}"${hasError ? `: ${err.message}` : ""}`;
          this.renderer.settings.errors.add(["layers", instanceId], FETCH_URDF_ERR, errMessage);
        }),
    );
  }

  #getCurrentSettings(instanceId: string) {
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const baseSettings = isTopicOrParam ? DEFAULT_SETTINGS : DEFAULT_CUSTOM_SETTINGS;
    const userSettings = isTopicOrParam
      ? this.renderer.config.topics[instanceId]
      : this.renderer.config.layers[instanceId];
    const settings = { ...baseSettings, ...userSettings, instanceId };
    return settings;
  }

  #removeCustomUrdf(instanceId: string, { updateConfig }: { updateConfig: boolean }): void {
    if (updateConfig) {
      this.renderer.updateConfig((draft) => {
        delete draft.layers[instanceId];
      });
    }

    const renderable = this.renderables.get(instanceId);
    if (renderable) {
      renderable.dispose();
      this.remove(renderable);
      this.renderables.delete(instanceId);
      this.#visualMembershipDirty = true;
      this.#managedMembershipDirty = true;
    }

    const transforms = this.#transformsByInstanceId.get(instanceId);
    if (transforms) {
      for (const { parent, child } of transforms) {
        this.renderer.removeTransform(child, parent, 0n);
      }
    }
    this.#framesByInstanceId.delete(instanceId);
    this.#transformsByInstanceId.delete(instanceId);
    this.#rootFramesByInstanceId.delete(instanceId);
    this.#refreshTransforms();
    this.updateSettingsTree();
    if (updateConfig) {
      this.renderer.updateCustomLayersCount();
    }
  }

  #syncManagedUrdfLayers(): void {
    const layers = this.renderer.config.layers;
    if (layers === this.#managedLayersIdentity && !this.#managedMembershipDirty) return;
    for (const instanceId of [...this.renderables.keys()]) {
      if (!instanceId.startsWith(MANAGED_URDF_LAYER_PREFIX)) {
        continue;
      }
      const entry = layers[instanceId];
      if (entry?.layerId !== LAYER_ID) {
        this.#removeCustomUrdf(instanceId, { updateConfig: false });
        continue;
      }
      const renderable = this.renderables.get(instanceId);
      const settings = this.#getCurrentSettings(instanceId);
      if (
        renderable &&
        customUrdfLayerNeedsReload(
          {
            urdf: renderable.userData.urdf,
            framePrefix: (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
              .framePrefix,
            parameter: renderable.userData.parameter,
            scale: (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).scale,
          },
          {
            urdf: renderable.userData.urdf,
            framePrefix: (settings as Partial<LayerSettingsCustomUrdf>).framePrefix,
            parameter: (settings as Partial<LayerSettingsCustomUrdf>).parameter,
            scale: (settings as Partial<LayerSettingsCustomUrdf>).scale,
          },
        )
      ) {
        this.#loadUrdf({
          instanceId,
          urdf:
            renderable.requestedVisual != undefined
              ? renderable.requestedVisual.urdf
              : renderable.userData.urdf,
          forceReload: true,
        });
      }
    }
    for (const [instanceId, entry] of Object.entries(layers)) {
      if (entry?.layerId === LAYER_ID && !this.renderables.has(instanceId)) {
        this.#loadUrdf({ instanceId, urdf: undefined });
      }
    }
    // The synchronous reconcile owns its own add/delete mutations. Accepted async loads can
    // dirty membership later, but this completed pass must not dirty itself on every frame.
    this.#managedLayersIdentity = layers;
    this.#managedMembershipDirty = false;
  }

  #loadUrdf(args: { instanceId: string; urdf?: string; forceReload?: boolean }): void {
    const { instanceId, urdf } = args;
    const forceReload = args.forceReload ?? false;
    let renderable = this.renderables.get(instanceId);
    const settings = this.#getCurrentSettings(instanceId);
    const sourceType = (settings as Partial<LayerSettingsCustomUrdf>).sourceType;
    const url = (settings as Partial<LayerSettingsCustomUrdf>).url;
    const filePath = (settings as Partial<LayerSettingsCustomUrdf>).filePath;
    const parameter = (settings as Partial<LayerSettingsCustomUrdf>).parameter;
    const topic = (settings as Partial<LayerSettingsCustomUrdf>).topic;
    const framePrefix = (settings as Partial<LayerSettingsCustomUrdf>).framePrefix;
    if (
      renderable &&
      urdf &&
      renderable.userData.sourceType === sourceType &&
      renderable.userData.topic === topic &&
      (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).url === url &&
      (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).filePath === filePath &&
      renderable.userData.settings.displayMode === settings.displayMode &&
      renderable.userData.settings.fallbackColor === settings.fallbackColor &&
      !customUrdfLayerNeedsReload(
        {
          urdf: renderable.userData.urdf,
          framePrefix: (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
            .framePrefix,
          parameter: renderable.userData.parameter,
          scale: (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).scale,
        },
        {
          urdf,
          framePrefix,
          parameter,
          scale: (settings as Partial<LayerSettingsCustomUrdf>).scale,
        },
        { forceReload },
      )
    ) {
      renderable.userData.settings = settings;
      return;
    }

    // Keep the previous complete drawable and its frames until a replacement commits.
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const frameId = this.renderer.fixedFrameId ?? ""; // Unused
    const settingsPath = isTopicOrParam ? ["topics", instanceId] : ["layers", instanceId];
    const label =
      (settings as Partial<LayerSettingsCustomUrdf>).label ?? DEFAULT_CUSTOM_SETTINGS.label;

    if (label !== renderable?.userData.settings.label) {
      // Label has changed, update the config
      this.renderer.updateConfig((draft) => {
        const config = draft.layers[instanceId];
        if (config) {
          config.label = label;
        }
      });
    }

    // Create a UrdfRenderable if it does not already exist
    if (!renderable) {
      renderable = new UrdfRenderable(instanceId, this.renderer, {
        urdf,
        fetching: undefined,
        renderables: new Map(),
        receiveTime: 0n,
        messageTime: 0n,
        frameId,
        pose: makePose(),
        settingsPath,
        settings,
        sourceType,
        topic,
        parameter,
      });
      this.add(renderable);
      this.renderables.set(instanceId, renderable);
      this.#visualMembershipDirty = true;
      this.#managedMembershipDirty = true;
    }

    const loadGeneration = ++renderable.loadGeneration;
    renderable.pendingVisual?.dispose();
    renderable.pendingVisual = undefined;
    renderable.userData.fetching?.control.abort();
    const requested: UrdfUserData = {
      ...renderable.userData,
      urdf,
      sourceType,
      topic,
      parameter,
      settings,
      fetching: undefined,
    };
    renderable.requestedVisual = requested;
    renderable.userData.fetching = undefined;

    if (!urdf) {
      const path = renderable.userData.settingsPath;
      this.renderer.settings.errors.remove(path, PARSE_URDF_ERR);
      this.renderer.settings.errors.remove(path, MISSING_TRANSFORM);
      if (sourceType === "url") {
        if (url != undefined) {
          this.#fetchUrdf(instanceId, url);
        } else {
          this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid URDF URL: "${url}"`);
        }
      } else if (sourceType === "filePath") {
        if (filePath != undefined) {
          this.#fetchUrdf(instanceId, `file://${filePath}`);
        } else {
          const errMsg = `Invalid File Path: "${filePath}"`;
          this.renderer.settings.errors.add(path, VALID_SRC_ERR, errMsg);
        }
      } else if (sourceType === "param") {
        const parameters = this.renderer.parameters;
        if (parameters == undefined) {
          return;
        }
        const value = parameter != undefined ? parameters.get(parameter) : undefined;
        if (typeof value !== "string" || value.length === 0) {
          this.renderer.settings.errors.add(
            path,
            VALID_SRC_ERR,
            `Invalid Parameter: "${parameter}"`,
          );
        }
      } else if (sourceType === "topic") {
        this.renderer.settings.errors.add(path, VALID_SRC_ERR, `Invalid Topic: "${topic}"`);
      }
      return;
    } else {
      this.renderer.settings.errors.remove(renderable.userData.settingsPath, VALID_SRC_ERR);
    }

    let baseUrl: string | undefined;
    if (sourceType === "url") {
      baseUrl = url;
    } else if (sourceType === "filePath") {
      baseUrl = `file://${filePath}`;
    }

    // Parse the URDF
    const loadedRenderable = renderable;
    this.#trackLoad(
      this.#parseVisualSource(urdf, baseUrl, framePrefix)
        .then(async ({ parsed, lod, visualBaseUrl }) => {
          if (
            loadedRenderable.loadGeneration !== loadGeneration ||
            this.renderables.get(instanceId) !== loadedRenderable
          ) {
            return;
          }
          if (
            !(await this.#loadRobot(loadedRenderable, parsed, visualBaseUrl, loadGeneration, {
              userData: requested,
              visualLod: lod,
            }))
          )
            return;
          if (
            loadedRenderable.loadGeneration !== loadGeneration ||
            this.renderables.get(instanceId) !== loadedRenderable
          )
            return;
          this.#managedMembershipDirty = true;
          this.renderer.settings.errors.remove(
            loadedRenderable.userData.settingsPath,
            PARSE_URDF_ERR,
          );
          // the frame from the settings update is called before the robot is loaded
          // need to queue another animation frame after robot has been loaded
          this.renderer.queueAnimationFrame();
        })
        .catch((e: unknown) => {
          if (
            loadedRenderable.loadGeneration !== loadGeneration ||
            this.renderables.get(instanceId) !== loadedRenderable
          ) {
            return;
          }
          loadedRenderable.pendingVisual?.dispose();
          loadedRenderable.pendingVisual = undefined;
          const err = e as Error;
          log.error(`Failed to parse URDF: ${err.message}`);
          this.renderer.settings.errors.add(
            settingsPath,
            PARSE_URDF_ERR,
            `Failed to parse URDF: ${err.message}`,
          );
        }),
    );
  }

  #debouncedLoadUrdf = _.debounce(this.#loadUrdf.bind(this), 500);

  async #loadRobot(
    renderable: UrdfRenderable,
    parsed: ParsedUrdf,
    baseUrl: string | undefined,
    generation: number,
    request: { userData: UrdfUserData; visualLod?: UrdfVisualLodState; visualOnly?: true },
  ): Promise<boolean> {
    const { robot, frames, transforms } = parsed;
    const renderer = this.renderer;
    const settings = request.userData.settings;
    const instanceId = settings.instanceId;
    const displayMode = settings.displayMode;
    const scale =
      renderer.interfaceMode === "image"
        ? 1
        : urdfLayerDisplayScale(settings as Partial<LayerSettingsCustomUrdf>);
    const fallbackColor = settings.fallbackColor
      ? stringToRgba(makeRgba(), settings.fallbackColor)
      : undefined;

    const staged = new UrdfRenderable(instanceId, renderer, {
      ...request.userData,
      fetching: undefined,
      renderables: new Map(),
    });
    renderable.pendingVisual = staged;
    const meshes: RenderableMeshResource[] = [];
    const createChild = (frameId: string, i: number, visual: UrdfVisual): void => {
      const childRenderable = createRenderable({
        visual,
        robot,
        id: i,
        frameId,
        renderer,
        baseUrl,
        fallbackColor,
        scale,
        visualInstancesChanged: (source) => {
          if (renderable.userData.renderables.get(`${frameId}/${i}`) === source)
            this.#visualMembershipDirty = true;
        },
      });
      // Set the childRenderable settingsPath so errors route to the correct place
      childRenderable.userData.settingsPath = renderable.userData.settingsPath;
      if (childRenderable instanceof RenderableMeshResource) meshes.push(childRenderable);
      staged.userData.renderables.set(`${frameId}/${i}`, childRenderable);
      staged.add(childRenderable);
    };

    // Create a renderable for each link
    for (const link of robot.links.values()) {
      const frameId = link.name;
      const renderVisual = displayMode !== "collision";
      const renderCollision =
        displayMode === "collision" || (displayMode === "auto" && link.visuals.length === 0);

      if (renderVisual) {
        for (let i = 0; i < link.visuals.length; i++) {
          createChild(frameId, i, link.visuals[i]!);
        }
      }

      if (renderCollision) {
        for (let i = 0; i < link.colliders.length; i++) {
          createChild(frameId, i, link.colliders[i]!);
        }
      }
    }
    await Promise.all(meshes.map(async (mesh) => await mesh.settleLoading()));
    if (
      renderable.loadGeneration !== generation ||
      this.renderables.get(instanceId) !== renderable
    ) {
      staged.dispose();
      return false;
    }
    if (meshes.some((mesh) => !mesh.hasLoadedModel())) {
      staged.dispose();
      renderable.pendingVisual = undefined;
      // Child asset errors share this layer path; a successful sibling may clear a mesh error.
      renderer.settings.errors.add(
        renderable.userData.settingsPath,
        PARSE_URDF_ERR,
        "Visual URDF did not finish loading; previous complete model retained",
      );
      return false;
    }
    storeVisualRadii(staged);
    const selectedKey = [...renderable.userData.renderables].find(
      ([, child]) => child === this.#selection?.renderable,
    )?.[0];
    const previousTransforms = this.#transformsByInstanceId.get(instanceId);
    const sameFrames =
      request.visualOnly === true ||
      (previousTransforms != undefined &&
        JSON.stringify(previousTransforms) === JSON.stringify(transforms));
    if (!sameFrames) {
      for (const transform of previousTransforms ?? [])
        renderer.removeTransform(transform.child, transform.parent, 0n);
    }
    renderable.removeChildren();
    const ownedChildren = renderable.userData.renderables;
    renderable.userData = { ...staged.userData, renderables: ownedChildren, fetching: undefined };
    renderable.visualLod = request.visualLod;
    this.#visualMembershipDirty = true;
    renderable.requestedVisual = undefined;
    for (const [key, child] of staged.userData.renderables) {
      renderable.userData.renderables.set(key, child);
      renderable.add(child);
    }
    staged.userData.renderables.clear();
    staged.dispose();
    renderable.pendingVisual = undefined;
    this.#loadFrames(instanceId, frames);
    if (!sameFrames) this.#loadTransforms(instanceId, transforms);
    const children = new Set(transforms.map((transform) => transform.child));
    const rootFrame = frames.find((frame) => !children.has(frame));
    if (rootFrame != undefined) this.#rootFramesByInstanceId.set(instanceId, rootFrame);
    else this.#rootFramesByInstanceId.delete(instanceId);
    if (selectedKey != undefined) {
      const replacement = renderable.userData.renderables.get(selectedKey);
      renderer.setSelectedRenderable(
        replacement == undefined ? undefined : { renderable: replacement },
      );
    }
    this.updateSettingsTree();
    return true;
  }

  #selectionBelongsTo(renderable: UrdfRenderable): boolean {
    if (this.#selection == undefined) return false;
    const path = this.#selection.renderable.userData.settingsPath;
    return (
      path[0] === renderable.userData.settingsPath[0] &&
      path[1] === renderable.userData.settings.instanceId
    );
  }

  async #parseVisualSource(
    text: string,
    baseUrl: string | undefined,
    prefix?: string,
  ): Promise<{
    parsed: ParsedUrdf;
    lod?: UrdfVisualLodState;
    visualBaseUrl?: string;
  }> {
    const source = await parseUrdf(
      text,
      async (uri) => await this.#getFileFetch(uri, baseUrl),
      prefix,
    );
    const manifestUri = visualManifestUri(text);
    if (manifestUri == undefined) return { parsed: source, visualBaseUrl: baseUrl };
    const manifest = parseVisualManifest(await this.#getFileFetch(manifestUri, baseUrl));
    const identity = visualKinematicIdentity(source.robot);
    for (const link of Object.keys(manifest.viewer_lod?.link_roles ?? {})) {
      if (!source.robot.links.has(`${prefix ?? ""}${link}`))
        throw new Error(`Unknown visual link ${link}`);
    }
    const current = manifest.release_visual;
    const uri = visualVariantUri(manifestUri, manifest, current);
    const release =
      uri === baseUrl
        ? source
        : await parseUrdf(
            await this.#getFileFetch(uri, manifestUri),
            async (asset) => await this.#getFileFetch(asset, uri),
            prefix,
          );
    if (visualKinematicIdentity(release.robot) !== identity)
      throw new Error("Visual variant changed kinematics/origins");
    return {
      parsed: release,
      visualBaseUrl: uri,
      lod: { manifest, manifestUri, current, kinematicIdentity: identity },
    };
  }

  #loadVisualVariant(renderable: UrdfRenderable, variant: string): void {
    const state = renderable.visualLod;
    if (state == undefined) return;
    const uri = visualVariantUri(state.manifestUri, state.manifest, variant);
    const generation = ++renderable.loadGeneration;
    renderable.pendingVisual?.dispose();
    renderable.pendingVisual = undefined;
    state.requested = variant;
    const prefix = (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>).framePrefix;
    const committedState = { ...state, current: variant, requested: undefined };
    this.#trackLoad(
      this.#getFileFetch(uri, state.manifestUri)
        .then(async (text) => {
          if (renderable.loadGeneration !== generation || renderable.visualLod !== state) return;
          const parsed = await parseUrdf(
            text,
            async (asset) => await this.#getFileFetch(asset, uri),
            prefix,
          );
          if (renderable.loadGeneration !== generation || renderable.visualLod !== state) return;
          if (visualKinematicIdentity(parsed.robot) !== state.kinematicIdentity) {
            throw new Error("Visual variant changed kinematics/origins");
          }
          if (
            !(await this.#loadRobot(renderable, parsed, uri, generation, {
              userData: renderable.userData,
              visualLod: committedState,
              visualOnly: true,
            }))
          ) {
            if (renderable.loadGeneration === generation && renderable.visualLod === state) {
              state.failed = variant;
              state.requested = undefined;
            }
            return;
          }
          if (
            renderable.loadGeneration !== generation ||
            this.renderables.get(renderable.userData.settings.instanceId) !== renderable ||
            renderable.visualLod !== committedState
          )
            return;
          this.renderer.settings.errors.remove(renderable.userData.settingsPath, PARSE_URDF_ERR);
          this.renderer.queueAnimationFrame();
        })
        .catch((error: unknown) => {
          if (renderable.loadGeneration !== generation || renderable.visualLod !== state) return;
          renderable.pendingVisual?.dispose();
          renderable.pendingVisual = undefined;
          state.failed = variant;
          state.requested = undefined;
          this.renderer.settings.errors.add(
            renderable.userData.settingsPath,
            PARSE_URDF_ERR,
            String(error),
          );
        }),
    );
  }

  #loadFrames(instanceId: string, frames: string[]): void {
    this.#framesByInstanceId.set(instanceId, frames);

    // Import all coordinate frames from the URDF into the scene
    for (const frameId of frames) {
      this.renderer.addCoordinateFrame(frameId);
    }
  }

  #loadTransforms(instanceId: string, transforms: TransformData[]): void {
    this.#transformsByInstanceId.set(instanceId, transforms);

    // Import all transforms from the URDF into the scene
    const isTopicOrParam = instanceId === TOPIC_NAME || instanceId === PARAM_KEY;
    const settingsPath = isTopicOrParam ? ["topics", instanceId] : ["layers", instanceId];
    for (const { parent, child, translation, rotation } of transforms) {
      this.renderer.addTransform(parent, child, 0n, translation, rotation, settingsPath);
    }
  }

  async #getFileFetch(url: string, referenceUrl?: string): Promise<string> {
    try {
      log.debug(`fetch(${url}) requested`);
      const asset = await this.renderer.fetchAsset(url, { referenceUrl });
      return this.#textDecoder.decode(asset.data);
    } catch (err: unknown) {
      throw new Error(`Failed to fetch "${url}": ${err}`);
    }
  }
}

/** Pause only this drawable hierarchy; the shared TF/joint state and producer are untouched. */
function setVisualWork(renderable: UrdfVisualChild, work: "parked" | "visible"): void {
  if (work === "parked") {
    if (renderable.parkedMatrices != undefined) return;
    const modes: NonNullable<UrdfVisualChild["parkedMatrices"]> = [];
    renderable.traverse((object) => {
      modes.push({ object, local: object.matrixAutoUpdate, world: object.matrixWorldAutoUpdate });
      object.matrixAutoUpdate = false;
      object.matrixWorldAutoUpdate = false;
    });
    renderable.parkedMatrices = modes;
  } else if (renderable.parkedMatrices != undefined) {
    for (const mode of renderable.parkedMatrices) {
      mode.object.matrixAutoUpdate = mode.local;
      mode.object.matrixWorldAutoUpdate = mode.world;
      mode.object.matrixWorldNeedsUpdate = true;
    }
    renderable.parkedMatrices = undefined;
  }
}

/** Cache only the loaded drawable's local extent; live transforms form the view envelope. */
function storeVisualRadii(visual: UrdfRenderable): void {
  for (const child of visual.userData.renderables.values()) {
    const box = new THREE.Box3().setFromObject(child);
    if (child instanceof RenderableMeshResource) child.extendVisualBounds(box);
    (child as UrdfVisualChild).visualRadius = box.isEmpty()
      ? 0
      : Math.hypot(
          Math.max(Math.abs(box.min.x), Math.abs(box.max.x)),
          Math.max(Math.abs(box.min.y), Math.abs(box.max.y)),
          Math.max(Math.abs(box.min.z), Math.abs(box.max.z)),
        );
  }
}

async function parseUrdf(
  text: string,
  getFileContents: (url: string) => Promise<string>,
  framePrefix?: string,
): Promise<ParsedUrdf> {
  const applyFramePrefix = (name: string) => `${framePrefix}${name}`;
  try {
    log.debug(`Parsing ${text.length} byte URDF`);
    const robot = await parseRobot(text, getFileContents);

    if (framePrefix) {
      robot.links = new Map(
        [...robot.links].map(([name, link]) => [
          applyFramePrefix(name),
          { ...link, name: applyFramePrefix(link.name) },
        ]),
      );
      robot.joints = new Map(
        [...robot.joints].map(([name, joint]) => [
          name,
          {
            ...joint,
            parent: applyFramePrefix(joint.parent),
            child: applyFramePrefix(joint.child),
          },
        ]),
      );
    }

    const frames = Array.from(robot.links.values(), (link) => link.name);
    const transforms = Array.from(robot.joints.values(), (joint) => {
      const translation = joint.origin.xyz;
      const rotation = eulerToQuaternion(joint.origin.rpy);
      const transform: TransformData = {
        parent: joint.parent,
        child: joint.child,
        translation,
        rotation,
        joint,
      };
      return transform;
    });

    return { robot, frames, transforms };
  } catch (err: unknown) {
    throw new Error(`Failed to parse ${text.length} byte URDF: ${err}`);
  }
}

function scaledXyz(xyz: Vector3, scale: number): Vector3 {
  return scale === 1 ? xyz : { x: xyz.x * scale, y: xyz.y * scale, z: xyz.z * scale };
}

function createRenderable(args: {
  visual: UrdfVisual;
  robot: UrdfRobot;
  id: number;
  frameId: string;
  renderer: IRenderer;
  baseUrl?: string;
  fallbackColor?: ColorRGBA;
  scale: number;
  visualInstancesChanged?: (source: RenderableMeshResource) => void;
}): Renderable {
  const { visual, robot, id, frameId, renderer, baseUrl, fallbackColor, scale } = args;
  const name = `${frameId}-${id}-${visual.geometry.geometryType}`;
  const orientation = eulerToQuaternion(visual.origin.rpy);
  const pose = { position: scaledXyz(visual.origin.xyz, scale), orientation };
  const color = getColor(visual, robot) ?? fallbackColor ?? DEFAULT_COLOR;
  const type = visual.geometry.geometryType;
  switch (type) {
    case "box": {
      const marker = createMarker(
        frameId,
        MarkerType.CUBE,
        pose,
        scaledXyz(visual.geometry.size, scale),
        color,
      );
      return new RenderableCube(name, marker, undefined, renderer);
    }
    case "cylinder": {
      const cylinder = visual.geometry;
      const cylinderScale = scaledXyz(
        {
          x: cylinder.radius * 2,
          y: cylinder.radius * 2,
          z: cylinder.length,
        },
        scale,
      );
      const marker = createMarker(frameId, MarkerType.CUBE, pose, cylinderScale, color);
      return new RenderableCylinder(name, marker, undefined, renderer);
    }
    case "sphere": {
      const sphere = visual.geometry;
      const sphereScale = scaledXyz(
        {
          x: sphere.radius * 2,
          y: sphere.radius * 2,
          z: sphere.radius * 2,
        },
        scale,
      );
      const marker = createMarker(frameId, MarkerType.CUBE, pose, sphereScale, color);
      return new RenderableSphere(name, marker, undefined, renderer);
    }
    case "mesh": {
      const isCollada = visual.geometry.filename.toLowerCase().endsWith(".dae");
      // Use embedded materials if the mesh is a Collada file
      const embedded = isCollada ? EmbeddedMaterialUsage.Use : EmbeddedMaterialUsage.Ignore;
      const marker = createMeshMarker(
        frameId,
        pose,
        embedded,
        visual.geometry,
        baseUrl,
        color,
        scale,
      );
      return new RenderableMeshResource(name, marker, undefined, renderer, {
        referenceUrl: baseUrl,
        visualInstancesChanged: args.visualInstancesChanged,
      });
    }
    default:
      throw new Error(`Unrecognized visual geometryType: ${type}`);
  }
}

function getColor(visual: UrdfVisual, robot: UrdfRobot): ColorRGBA | undefined {
  if (!visual.material) {
    return undefined;
  }
  if (visual.material.color) {
    return visual.material.color;
  }
  if (visual.material.name) {
    return robot.materials.get(visual.material.name)?.color;
  }
  return undefined;
}

function createMarker(
  frameId: string,
  type: MarkerType,
  pose: Pose,
  scale: Vector3,
  color: ColorRGBA,
): Marker {
  return {
    header: { frame_id: frameId, stamp: { sec: 0, nsec: 0 } },
    ns: "",
    id: 0,
    type,
    action: MarkerAction.ADD,
    pose,
    scale,
    color,
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: "",
    mesh_use_embedded_materials: false,
  };
}

function createMeshMarker(
  frameId: string,
  pose: Pose,
  embeddedMaterialUsage: EmbeddedMaterialUsage,
  mesh: UrdfGeometryMesh,
  baseUrl: string | undefined,
  color: ColorRGBA,
  scale: number,
): Marker {
  const meshScale = scaledXyz(mesh.scale ?? VEC3_ONE, scale);
  return {
    header: { frame_id: frameId, stamp: { sec: 0, nsec: 0 } },
    ns: "",
    id: 0,
    type: MarkerType.MESH_RESOURCE,
    action: MarkerAction.ADD,
    pose,
    scale: meshScale,
    color,
    lifetime: { sec: 0, nsec: 0 },
    frame_locked: true,
    points: [],
    colors: [],
    text: "",
    mesh_resource: new URL(mesh.filename, baseUrl).toString(),
    mesh_use_embedded_materials: embeddedMaterialUsage === EmbeddedMaterialUsage.Use,
  };
}

function urdfChildren(
  transforms: TransformData[] | undefined,
  transformTree: TransformTree,
  jointStates: Map<string, JointPosition>,
): SettingsTreeChildren {
  if (!transforms) {
    return {};
  }

  const jointChildren: SettingsTreeChildren = {};
  for (const { joint } of transforms) {
    const frameId = joint.child;
    const frame = transformTree.getOrCreateFrame(frameId);

    const { x, y, z } = joint.origin.xyz;
    const { x: roll, y: pitch, z: yaw } = joint.origin.rpy;
    const { x: aX, y: aY, z: aZ } = joint.axis;
    const fields: SettingsTreeFields = {};
    fields.jointType = {
      label: "Type",
      input: "string",
      readonly: true,
      value: joint.jointType,
    };

    switch (joint.jointType) {
      case "fixed":
        break;
      case "continuous":
      case "revolute": {
        const min = joint.limit ? joint.limit.lower * RAD2DEG : -180;
        const max = joint.limit ? joint.limit.upper * RAD2DEG : 180;
        let manualDegrees: number | undefined;
        const jointStateRadians = jointStates.get(joint.name)?.position;

        if (frame.offsetEulerDegrees) {
          // Convert the Euler degrees to a quaternion
          const quaternion = eulerDegreesToQuaternion(frame.offsetEulerDegrees);
          const radians = signedAngleAroundAxis(quaternion, joint.axis);
          manualDegrees = radians * RAD2DEG;
        }

        fields.manual = {
          label: "Manual angle",
          input: "number",
          precision: PRECISION_DEGREES,
          step: 1,
          min,
          max,
          value: manualDegrees,
        };

        if (jointStateRadians != undefined) {
          fields.jointState = {
            label: "JointState angle",
            input: "number",
            precision: PRECISION_DEGREES,
            min,
            max,
            readonly: true,
            value: jointStateRadians * RAD2DEG,
          };
        }
        break;
      }
      case "prismatic": {
        const min = joint.limit?.lower;
        const max = joint.limit?.upper;
        const manualPosition = frame.offsetPosition
          ? signedDistanceAlongAxis(frame.offsetPosition, joint.axis)
          : undefined;
        const jointStatePosition = jointStates.get(joint.name)?.position;

        fields.manual = {
          label: "Manual position",
          input: "number",
          precision: PRECISION_DISTANCE,
          step: 0.01,
          min,
          max,
          value: manualPosition,
        };
        if (jointStatePosition != undefined) {
          fields.jointState = {
            label: "JointState position",
            input: "number",
            precision: PRECISION_DISTANCE,
            min,
            max,
            readonly: true,
            value: jointStatePosition,
          };
        }
        break;
      }
      case "floating":
      case "planar":
        // Motion could be supported for these types in the future
        break;
    }

    fields.position = {
      label: "Position",
      input: "vec3",
      labels: XYZ_LABEL,
      precision: PRECISION_DISTANCE,
      readonly: true,
      value: [x, y, z],
    };
    fields.rotation = {
      label: "Rotation",
      input: "vec3",
      labels: RPY_LABEL,
      precision: PRECISION_DEGREES,
      readonly: true,
      value: [roll * RAD2DEG, pitch * RAD2DEG, yaw * RAD2DEG],
    };
    fields.parent = {
      label: "Parent",
      input: "string",
      readonly: true,
      value: joint.parent,
    };
    fields.child = {
      label: "Child",
      input: "string",
      readonly: true,
      value: joint.child,
    };
    if (joint.jointType !== "fixed") {
      fields.axis = {
        label: "Axis",
        input: "vec3",
        labels: XYZ_LABEL,
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: [aX, aY, aZ],
      };
    }
    if (joint.calibration) {
      const { rising, falling } = joint.calibration;
      fields.calibration = {
        label: "Calibration",
        input: "vec2",
        labels: ["↑", "↓"],
        readonly: true,
        value: [rising, falling],
      };
    }
    if (joint.dynamics) {
      const { damping, friction } = joint.dynamics;
      fields.damping = {
        label: "Damping",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: damping,
      };
      fields.friction = {
        label: "Friction",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: friction,
      };
    }
    if (joint.limit) {
      const { effort, velocity } = joint.limit;
      if (joint.jointType !== "continuous" && joint.jointType !== "fixed") {
        const { upper, lower } = joint.limit;
        const isAngular = joint.jointType === "revolute";
        const upperValue = isAngular ? upper * RAD2DEG : upper;
        const lowerValue = isAngular ? lower * RAD2DEG : lower;
        fields.limit = {
          label: "Limit",
          input: "vec2",
          labels: ["↑", "↓"],
          readonly: true,
          precision: isAngular ? PRECISION_DEGREES : PRECISION_DISTANCE,
          value: [upperValue, lowerValue],
        };
      }
      fields.effort = {
        label: "Limit effort",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: effort,
      };
      fields.velocity = {
        label: "Limit velocity",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: velocity,
      };
    }
    if (joint.mimic) {
      const { joint: mimicJoint, multiplier, offset } = joint.mimic;
      fields.mimicJoint = {
        label: "Mimic joint",
        input: "string",
        readonly: true,
        value: mimicJoint,
      };
      fields.mimicMultiplier = {
        label: "Mimic multiplier",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: multiplier,
      };
      fields.mimicOffset = {
        label: "Mimic offset",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: offset,
      };
    }
    if (joint.safetyController) {
      const { softUpperLimit, softLowerLimit, kPosition, kVelocity } = joint.safetyController;
      fields.softLimit = {
        label: "Soft limit",
        input: "vec2",
        labels: ["↑", "↓"],
        readonly: true,
        value: [softUpperLimit, softLowerLimit],
      };
      fields.kPosition = {
        label: "k_position",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: kPosition,
      };
      fields.kVelocity = {
        label: "k_velocity",
        input: "number",
        precision: PRECISION_DISTANCE,
        readonly: true,
        value: kVelocity,
      };
    }
    jointChildren[joint.name] = {
      label: joint.name,
      fields,
      defaultExpansionState: "collapsed",
    };
  }

  const children: SettingsTreeChildren = {
    joints: {
      label: "Joints",
      defaultExpansionState: "collapsed",
      children: jointChildren,
    },
  };
  return children;
}

function eulerDegreesToQuaternion(eulerDegrees: vec3): THREE.Quaternion {
  tempEuler.set(eulerDegrees[0] * DEG2RAD, eulerDegrees[1] * DEG2RAD, eulerDegrees[2] * DEG2RAD);
  return tempQuaternion1.setFromEuler(tempEuler);
}

function signedDistanceAlongAxis(position: Readonly<vec3>, axis: Readonly<Vector3>): number {
  const p = tempVec3a.set(position[0], position[1], position[2]);
  const targetAxis = tempVec3b.set(axis.x, axis.y, axis.z);

  // Project the position on to axis
  p.projectOnVector(targetAxis);
  const distance = p.length();

  // Calculate the sign
  const dotProduct = p.dot(targetAxis);
  const sign = dotProduct < 0 ? -1 : 1;

  return sign * distance;
}

// Find the signed angle of a rotation around a given axis
function signedAngleAroundAxis(rotation: Readonly<Quaternion>, axis: Readonly<Vector3>): number {
  const rotationAxis = tempVec3a.set(rotation.x, rotation.y, rotation.z);
  const targetAxis = tempVec3b.set(axis.x, axis.y, axis.z);

  // Project the rotation axis onto the given axis
  const p = rotationAxis.projectOnVector(targetAxis);

  // Create a twist quaternion from the projected axis and original rotation angle
  const twist = tempQuaternion2.set(p.x, p.y, p.z, rotation.w);
  twist.normalize();

  // Calculate the twist angle ([0, PI])
  const angle = 2 * Math.acos(twist.w);

  // Calculate the sign of the twist angle
  const dotProduct = tempVec3a.set(twist.x, twist.y, twist.z).dot(targetAxis);
  const sign = dotProduct < 0 ? -1 : 1;

  return sign * angle;
}
