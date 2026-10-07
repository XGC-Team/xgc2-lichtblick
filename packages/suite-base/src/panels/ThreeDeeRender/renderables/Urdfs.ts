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
import { parseXgc2LayoutScope } from "@lichtblick/suite-base/util/xgcManagedLayoutImport";

import {
  RobotInstancingState,
  StaticLinkState,
  StaticVisualState,
  UrdfInstancePool,
  UrdfPrimitiveKind,
  AcquireMeshResult,
} from "./UrdfInstancePool";
import { customUrdfLayerNeedsReload, urdfLayerDisplayScale } from "./customUrdfLayer";
import { missingTransformMessage, MISSING_TRANSFORM } from "./transforms";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import type { PickedRenderable } from "../Picker";
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
import { RootedPose, rootedIdentityPose, updatePose, updatePoseViaRoot } from "../updatePose";
import { RenderableCube } from "./markers/RenderableCube";
import { RenderableCylinder } from "./markers/RenderableCylinder";
import { MESH_FETCH_FAILED, RenderableMeshResource } from "./markers/RenderableMeshResource";
import { RenderableSphere } from "./markers/RenderableSphere";

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

const scaledChainVec = new THREE.Vector3();
const scaledChainQuat = new THREE.Quaternion();
const scaledChainQuat2 = new THREE.Quaternion();

// Composition scratches for pooled static-link instance matrices; startFrame
// is not reentrant, same as the temps above.
const tempInstanceMatrix = new THREE.Matrix4();
const tempLeafMatrix = new THREE.Matrix4();
const instancePosVec = new THREE.Vector3();
const instanceOffsetVec = new THREE.Vector3();
const instanceRootQuat = new THREE.Quaternion();
const instanceChainQuat = new THREE.Quaternion();
const instanceTempQuat = new THREE.Quaternion();
const instanceScaleVec = new THREE.Vector3();

export type UrdfUserData = BaseUserData & {
  settings: LayerSettingsUrdf | LayerSettingsCustomUrdf;
  fetching?: { url: string; control: AbortController };
  urdf: string | undefined;
  sourceType: LayerSettingsCustomUrdf["sourceType"] | undefined;
  parameter: string | undefined;
  renderables: Map<string, Renderable>;
  /** Pooled static-link subtree state; undefined when the robot has no static links. */
  instancing?: RobotInstancingState;
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

export class UrdfRenderable extends Renderable<UrdfUserData> {
  public loadGeneration = 0;

  /** Releases pooled static-link instances; invoked by removeChildren(). Set by Urdfs. */
  public releaseInstancing?: () => void;
  /**
   * Pick loops hide and restore renderables between frames, and pooled
   * instances are not children of this object — visibility transitions must
   * reach the pool even when no startFrame runs in between. Set by Urdfs.
   */
  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  public onVisibilityChange?: (visible: boolean) => void;

  public constructor(name: string, renderer: IRenderer, userData: UrdfUserData) {
    super(name, renderer, userData);
    // THREE.Object3D assigns `visible` as a plain instance property; replace it
    // with an accessor that reports transitions so pooled static-link instances
    // hide and restore in sync with this renderable.
    let backing = this.visible;
    Object.defineProperty(this, "visible", {
      enumerable: true,
      configurable: true,
      get: () => backing,
      // eslint-disable-next-line @lichtblick/no-boolean-parameters
      set: (value: boolean) => {
        if (value !== backing) {
          backing = value;
          this.onVisibilityChange?.(value);
        }
      },
    });
  }

  public override dispose(): void {
    ++this.loadGeneration;
    this.userData.fetching?.control.abort();
    this.removeChildren();
    this.userData.urdf = undefined;
    super.dispose();
  }

  public removeChildren(): void {
    this.releaseInstancing?.();
    for (const childRenderable of this.userData.renderables.values()) {
      childRenderable.dispose();
    }
    this.children.length = 0;
    this.userData.renderables.clear();
  }
}

export class Urdfs extends SceneExtension<UrdfRenderable> {
  public static extensionId = "foxglove.Urdfs";
  /** Shared InstancedMesh pools for static link subtrees of same-model robots. */
  public readonly instancePool: UrdfInstancePool;
  #framesByInstanceId = new Map<string, string[]>();
  #transformsByInstanceId = new Map<string, TransformData[]>();
  #rootFramesByInstanceId = new Map<string, string>();
  #jointStates = new Map<string, JointPosition>();
  #textDecoder = new TextDecoder();
  #urdfsByTopic = new Map<string, string>();
  #pendingLoads = new Set<Promise<void>>();
  /** The currently selected robot, if any; its static links render per-link. */
  #selectedUrdf: UrdfRenderable | undefined;

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
    this.instancePool = new UrdfInstancePool(renderer, this);

    renderer.on("parametersChange", this.#handleParametersChange);
    renderer.on("selectedRenderable", this.#handleSelectedRenderable);
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

  public override dispose(): void {
    this.instancePool.dispose();
    super.dispose();
  }

  #handleSelectedRenderable = (selection: PickedRenderable | undefined): void => {
    const picked = selection?.renderable;
    // Selection never flips layers on the shared instance batches (that would
    // highlight every robot). The next startFrame migrates the selected robot's
    // static links to the legacy per-link path, and migrates it back on
    // deselect.
    this.#selectedUrdf =
      picked instanceof UrdfRenderable && this.renderables.get(picked.name) === picked
        ? picked
        : undefined;
  };

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

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    this.#syncManagedUrdfLayers();
    for (const renderable of this.renderables.values()) {
      const path = renderable.userData.settingsPath;
      let missingFrameId: string | undefined;

      renderable.visible = renderable.userData.settings.visible;
      if (!renderable.visible) {
        this.renderer.settings.errors.clearPath(path);
        continue;
      }

      const scale = urdfLayerDisplayScale(
        renderable.userData.settings as Partial<LayerSettingsCustomUrdf>,
      );
      const rootFrameId = this.#rootFramesByInstanceId.get(renderable.userData.settings.instanceId);
      // The robot root pose is resolved at most once per robot per frame and
      // shared by every link. Both the root pose and the per-link root→link
      // transforms are memoized on frame versions, so an unchanged TF tree
      // performs no tree walks for links at all.
      let rootPose: RootedPose | undefined;

      // Static link subtrees draw from the shared instance pools. This also
      // migrates links between the pool and the legacy per-link path
      // (selection, or a link reparented outside the robot root).
      const instancing = renderable.userData.instancing;
      if (instancing && !instancing.released && rootFrameId != undefined) {
        rootPose ??= rootedIdentityPose(
          renderable,
          this.renderer.transformTree,
          renderFrameId,
          fixedFrameId,
          rootFrameId,
          currentTime,
        );
        missingFrameId ??= this.#updateStaticInstances(
          renderable,
          instancing,
          rootPose,
          rootFrameId,
          scale,
          currentTime,
        );
      }

      // UrdfRenderables always stay at the origin. Their children renderables
      // are individually updated since each child exists in a different frame
      for (const childRenderable of renderable.userData.renderables.values()) {
        const srcTime = currentTime;
        const frameId = childRenderable.userData.frameId;
        let updated: boolean;
        if (rootFrameId != undefined) {
          rootPose ??= rootedIdentityPose(
            renderable,
            this.renderer.transformTree,
            renderFrameId,
            fixedFrameId,
            rootFrameId,
            currentTime,
          );
          if (scale === 1) {
            updated = updatePoseViaRoot(
              childRenderable,
              this.renderer.transformTree,
              renderFrameId,
              fixedFrameId,
              rootFrameId,
              rootPose,
              frameId,
              srcTime,
            );
          } else {
            updated =
              rootPose.applied &&
              this.#applyScaledChildPose(
                childRenderable,
                rootPose,
                rootFrameId,
                frameId,
                scale,
                currentTime,
              );
          }
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
        if (!updated) {
          missingFrameId = frameId;
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
    }
    this.instancePool.flush();
  }

  /**
   * Per-frame pool update for one robot's static links. Reconciles each link
   * between the shared instance pools and the legacy per-link path, then
   * rewrites instance matrices whose inputs changed:
   *   instance = rootPose ⊕ (scale·rel.t, rel.q) ⊕ (scale·visual.t, visual.q),
   * with the geometry dimensions folded into the matrix scale — the exact
   * composition the legacy Object3D path produces, so scale never fragments
   * batch keys. The root pose is the one already hoisted for the per-link
   * path; the root→link transform reuses the same memoized rootedIdentityPose
   * query, so an unchanged TF tree costs a version scan per link and no
   * tree.apply calls.
   *
   * Returns the frame id to report when the robot's transform chain is
   * unresolved, or undefined when every pooled link resolved.
   */
  #updateStaticInstances(
    renderable: UrdfRenderable,
    state: RobotInstancingState,
    rootPose: RootedPose,
    rootFrameId: string,
    scale: number,
    currentTime: bigint,
  ): string | undefined {
    const selected = this.#selectedUrdf === renderable;
    let missingFrameId: string | undefined;
    for (const link of state.staticLinks) {
      const rel = rootedIdentityPose(
        link.memoKey,
        this.renderer.transformTree,
        rootFrameId,
        rootFrameId,
        link.frameId,
        currentTime,
      );
      // A link reparented outside the robot root cannot decompose onto the
      // hoisted root pose; it follows TF through the legacy per-link path.
      if (selected || !rel.rooted) {
        this.#ensureLegacyLink(renderable, state, link);
        continue;
      }
      this.#ensurePooledLink(renderable, state, link);
      if (!rootPose.applied || !rel.applied) {
        for (const visual of link.visuals) {
          this.instancePool.hideSlots(visual.slots);
        }
        link.lastRoot = undefined;
        link.lastRel = undefined;
        missingFrameId ??= link.frameId;
        continue;
      }
      if (
        !link.forceDirty &&
        poseValuesEqual(link.lastRoot, rootPose) &&
        poseValuesEqual(link.lastRel, rel)
      ) {
        continue;
      }
      link.lastRoot = capturePoseValues(rootPose);
      link.lastRel = capturePoseValues(rel);
      link.forceDirty = false;
      for (const visual of link.visuals) {
        if (visual.slots.length === 0) {
          continue;
        }
        composeStaticInstanceMatrix(tempInstanceMatrix, rootPose, rel, visual.pose, visual.dims, scale);
        for (const slot of visual.slots) {
          slot.batch.writeSlot(
            slot.index,
            slot.local
              ? tempLeafMatrix.multiplyMatrices(tempInstanceMatrix, slot.local)
              : tempInstanceMatrix,
          );
        }
      }
    }
    return missingFrameId;
  }

  /**
   * Move a static link to the legacy per-link path: release its pool slots and
   * create the same child renderables an articulated link has. The children
   * are posed by the regular per-link loop later in this startFrame.
   */
  #ensureLegacyLink(
    renderable: UrdfRenderable,
    state: RobotInstancingState,
    link: StaticLinkState,
  ): void {
    if (link.legacyChildren) {
      return;
    }
    link.legacyChildren = [];
    for (const visual of link.visuals) {
      visual.pooled = false;
      this.instancePool.releaseSlots(visual.slots);
      visual.slots = [];
      if (visual.legacyChild) {
        // Non-instancable model: the permanent legacy child already renders it.
        continue;
      }
      const child = this.#createUrdfChild(renderable, state, link.frameId, visual.visualIndex, visual.visual);
      // selectObject() flips layers on the subtree at selection time; children
      // created by a selection migration afterwards inherit the robot's
      // current mask so the highlight survives.
      const mask = renderable.layers.mask;
      child.traverse((object) => {
        object.layers.mask = mask;
      });
      link.legacyChildren.push(child);
    }
    link.lastRoot = undefined;
    link.lastRel = undefined;
  }

  /** Move a static link back into the shared instance pools. */
  #ensurePooledLink(
    renderable: UrdfRenderable,
    state: RobotInstancingState,
    link: StaticLinkState,
  ): void {
    if (!link.legacyChildren) {
      return;
    }
    for (const child of link.legacyChildren) {
      renderable.userData.renderables.delete(child.name);
      renderable.remove(child);
      child.dispose();
    }
    link.legacyChildren = undefined;
    for (const visual of link.visuals) {
      if (visual.legacyChild) {
        continue;
      }
      visual.pooled = true;
      if (visual.meshUrl != undefined) {
        // The flattened model is cached, so re-acquire resolves synchronously.
        this.#acquireMeshSlots(renderable, state, link, visual);
      } else {
        const kind = visual.visual.geometry.geometryType as UrdfPrimitiveKind;
        visual.slots = [
          this.instancePool.acquirePrimitiveSlot({
            kind,
            transparent: visual.color.a < 1,
            color: visual.color,
            owner: renderable,
          }),
        ];
      }
    }
    link.forceDirty = true;
  }

  /**
   * Viewer-only display scale: place the child as
   * `rootPose ⊕ (scale · rel.t, rel.q) ⊕ visualPose`, where rel is the live
   * root→link transform from the shared tree (memoized per link on frame
   * versions). Dynamic joint TF (spinning rotors, wheels) keeps its rotation
   * and only its translation rides the factor, so the whole robot grows
   * uniformly about its root while every other consumer of the tree keeps true
   * dimensions.
   */
  #applyScaledChildPose(
    childRenderable: Renderable,
    rootPose: RootedPose,
    rootFrameId: string,
    frameId: string,
    scale: number,
    time: bigint,
  ): boolean {
    const rel = rootedIdentityPose(
      childRenderable,
      this.renderer.transformTree,
      rootFrameId,
      rootFrameId,
      frameId,
      time,
    );
    if (!rel.applied) {
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
      let urdf = renderable?.userData.urdf;

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
          urdf = renderable?.userData.topic
            ? this.#urdfsByTopic.get(renderable.userData.topic)
            : undefined;
        } else if (sourceType === "param") {
          urdf = renderable?.userData.parameter
            ? (this.renderer.parameters?.get(renderable.userData.parameter) as string | undefined)
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
    const subscribedInstanceIds = filterMap(this.renderables, ([instanceId, renderable]) =>
      renderable.userData.sourceType === "topic" && renderable.userData.topic === topic
        ? instanceId
        : undefined,
    );
    for (const instanceId of subscribedInstanceIds) {
      this.#loadUrdf({ instanceId, urdf: robotDescription });
    }
  };

  #shouldSubscribe = (topic: string): boolean => {
    return Array.from(this.renderables.values()).some(
      (renderable) =>
        renderable.userData.sourceType === "topic" && renderable.userData.topic === topic,
    );
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
      const sourceType = (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
        .sourceType;
      const paramName = (renderable.userData.settings as Partial<LayerSettingsCustomUrdf>)
        .parameter;
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
          urdf: renderable.userData.urdf,
          forceReload: true,
        });
      }
    }
    for (const [instanceId, entry] of Object.entries(layers)) {
      if (entry?.layerId === LAYER_ID && !this.renderables.has(instanceId)) {
        this.#loadUrdf({ instanceId, urdf: undefined });
      }
    }
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

    // Clear any previous parsed data for this instanceId
    const transforms = this.#transformsByInstanceId.get(instanceId) ?? [];
    for (const transform of transforms) {
      this.renderer.removeTransform(transform.child, transform.parent, 0n);
    }
    this.#transformsByInstanceId.delete(instanceId);
    this.#framesByInstanceId.delete(instanceId);
    this.#rootFramesByInstanceId.delete(instanceId);
    this.updateSettingsTree();

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
      const created = new UrdfRenderable(instanceId, this.renderer, {
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
      created.releaseInstancing = () => {
        this.#releaseInstancing(created);
      };
      created.onVisibilityChange = (visible) => {
        this.#handleRobotVisibility(created, visible);
      };
      renderable = created;
      this.add(renderable);
      this.renderables.set(instanceId, renderable);
    }

    const loadGeneration = ++renderable.loadGeneration;
    renderable.userData.fetching?.control.abort();
    renderable.userData.urdf = urdf;
    renderable.userData.sourceType = sourceType;
    renderable.userData.topic = topic;
    renderable.userData.parameter = parameter;
    renderable.userData.settings = settings;
    renderable.userData.fetching = undefined;

    if (!urdf || forceReload) {
      renderable.removeChildren();
    }

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
      parseUrdf(urdf, async (uri) => await this.#getFileFetch(uri, baseUrl), framePrefix)
        .then((parsed) => {
          if (
            loadedRenderable.loadGeneration !== loadGeneration ||
            this.renderables.get(instanceId) !== loadedRenderable
          ) {
            return;
          }
          this.#loadRobot(loadedRenderable, parsed, baseUrl);
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

  #loadRobot(
    renderable: UrdfRenderable,
    { robot, frames, transforms }: ParsedUrdf,
    baseUrl: string | undefined,
  ): void {
    const renderer = this.renderer;
    const settings = renderable.userData.settings;
    const instanceId = settings.instanceId;
    const displayMode = settings.displayMode;
    const fallbackColor = settings.fallbackColor
      ? stringToRgba(makeRgba(), settings.fallbackColor)
      : undefined;

    this.#loadFrames(instanceId, frames);
    this.#loadTransforms(instanceId, transforms);
    // The display-scale composition grows every link about this root frame;
    // dynamic joint TF (rotors, wheels) is composed in startFrame, so scaling
    // must anchor on the frame nothing in the URDF parents.
    const childFrames = new Set(transforms.map((transform) => transform.child));
    const rootFrame = frames.find((frame) => !childFrames.has(frame));
    if (rootFrame) {
      this.#rootFramesByInstanceId.set(instanceId, rootFrame);
      const followTf = renderer.config.followTf;
      const framePrefix = (settings as Partial<LayerSettingsCustomUrdf>).framePrefix;
      // Validate only after the current model resolved its actual root. A pending parameter
      // or asset must not discard a restored Follow before the URDF has loaded.
      const hostUrl = new URL(window.location.href);
      if (
        hostUrl.searchParams.get("xgc2Embed") === "1" &&
        parseXgc2LayoutScope(hostUrl.searchParams.get("xgc2LayoutScope")) &&
        renderer.config.followMode === "follow-position" &&
        followTf != undefined &&
        typeof framePrefix === "string" &&
        framePrefix.length > 0 &&
        followTf.startsWith(framePrefix) &&
        followTf !== rootFrame
      ) {
        renderer.settings.handleAction({
          action: "update",
          payload: {
            input: "select",
            path: ["general", "followMode"],
            value: "follow-none",
          },
        });
        renderer.settings.handleAction({
          action: "update",
          payload: {
            input: "select",
            path: ["general", "followTf"],
            value: renderer.fixedFrameId,
          },
        });
      }
    } else {
      this.#rootFramesByInstanceId.delete(instanceId);
    }
    this.updateSettingsTree();

    // Dispose any existing renderables
    renderable.removeChildren();

    // Split static link subtrees from articulated ones. A link is static iff
    // every joint on the chain from the URDF root to it is fixed; static links
    // draw from the shared instance pools, articulated links keep per-link
    // renderables that follow joint TF.
    const staticLinkNames =
      rootFrame != undefined ? computeStaticLinkNames(transforms, rootFrame) : new Set<string>();
    const instancing: RobotInstancingState | undefined =
      staticLinkNames.size > 0
        ? { staticLinks: [], robot, baseUrl, fallbackColor, released: false }
        : undefined;
    renderable.userData.instancing = instancing;

    const legacyContext = { robot, baseUrl, fallbackColor };
    const createChild = (frameId: string, i: number, visual: UrdfVisual): void => {
      this.#createUrdfChild(renderable, legacyContext, frameId, i, visual);
    };

    // Create a renderable for each link
    for (const link of robot.links.values()) {
      const frameId = link.name;
      const renderVisual = displayMode !== "collision";
      const renderCollision =
        displayMode === "collision" || (displayMode === "auto" && link.visuals.length === 0);

      if (instancing && staticLinkNames.has(frameId)) {
        const linkState: StaticLinkState = {
          frameId,
          memoKey: new THREE.Object3D(),
          visuals: [],
          legacyChildren: undefined,
          lastRoot: undefined,
          lastRel: undefined,
          forceDirty: true,
        };
        instancing.staticLinks.push(linkState);
        if (renderVisual) {
          for (let i = 0; i < link.visuals.length; i++) {
            this.#registerStaticVisual(renderable, instancing, linkState, i, link.visuals[i]!);
          }
        }
        if (renderCollision) {
          for (let i = 0; i < link.colliders.length; i++) {
            this.#registerStaticVisual(renderable, instancing, linkState, i, link.colliders[i]!);
          }
        }
        continue;
      }

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
  }

  /**
   * Create one per-link child renderable, the path articulated links (and
   * static links migrated out of the pools) always take.
   */
  #createUrdfChild(
    renderable: UrdfRenderable,
    context: { robot: UrdfRobot; baseUrl: string | undefined; fallbackColor: ColorRGBA | undefined },
    frameId: string,
    i: number,
    visual: UrdfVisual,
  ): Renderable {
    const scale = urdfLayerDisplayScale(
      renderable.userData.settings as Partial<LayerSettingsCustomUrdf>,
    );
    const childRenderable = createRenderable({
      visual,
      robot: context.robot,
      id: i,
      frameId,
      renderer: this.renderer,
      baseUrl: context.baseUrl,
      fallbackColor: context.fallbackColor,
      scale,
    });
    // Set the childRenderable settingsPath so errors route to the correct place
    childRenderable.userData.settingsPath = renderable.userData.settingsPath;
    if (childRenderable instanceof RenderableMeshResource) {
      this.#trackLoad(childRenderable.settleLoading());
    }
    renderable.userData.renderables.set(childRenderable.name, childRenderable);
    renderable.add(childRenderable);
    return childRenderable;
  }

  /**
   * Register one visual of a static link into the shared instance pools.
   * Primitives acquire their slot immediately; mesh visuals acquire one slot
   * per model leaf once the shared ModelCache load resolves.
   */
  #registerStaticVisual(
    renderable: UrdfRenderable,
    state: RobotInstancingState,
    linkState: StaticLinkState,
    visualIndex: number,
    visual: UrdfVisual,
  ): void {
    const color = getColor(visual, state.robot) ?? state.fallbackColor ?? DEFAULT_COLOR;
    const visualState: StaticVisualState = {
      visual,
      visualIndex,
      pose: { position: visual.origin.xyz, orientation: eulerToQuaternion(visual.origin.rpy) },
      dims: VEC3_ONE,
      color,
      meshUrl: undefined,
      embedded: false,
      slots: [],
      legacyChild: undefined,
      pooled: true,
      loadId: 0,
    };
    linkState.visuals.push(visualState);
    const geometry = visual.geometry;
    const transparent = color.a < 1;
    switch (geometry.geometryType) {
      case "box":
        visualState.dims = geometry.size;
        visualState.slots = [
          this.instancePool.acquirePrimitiveSlot({ kind: "box", transparent, color, owner: renderable }),
        ];
        break;
      case "cylinder":
        visualState.dims = { x: geometry.radius * 2, y: geometry.radius * 2, z: geometry.length };
        visualState.slots = [
          this.instancePool.acquirePrimitiveSlot({
            kind: "cylinder",
            transparent,
            color,
            owner: renderable,
          }),
        ];
        break;
      case "sphere":
        visualState.dims = { x: geometry.radius * 2, y: geometry.radius * 2, z: geometry.radius * 2 };
        visualState.slots = [
          this.instancePool.acquirePrimitiveSlot({
            kind: "sphere",
            transparent,
            color,
            owner: renderable,
          }),
        ];
        break;
      case "mesh":
        visualState.embedded = geometry.filename.toLowerCase().endsWith(".dae");
        visualState.meshUrl = new URL(geometry.filename, state.baseUrl).toString();
        visualState.dims = geometry.scale ?? VEC3_ONE;
        this.#acquireMeshSlots(renderable, state, linkState, visualState);
        break;
    }
  }

  #acquireMeshSlots(
    renderable: UrdfRenderable,
    state: RobotInstancingState,
    linkState: StaticLinkState,
    visualState: StaticVisualState,
  ): void {
    const url = visualState.meshUrl!;
    const loadId = ++visualState.loadId;
    const settingsPath = renderable.userData.settingsPath;
    const outcome = this.instancePool.acquireMeshSlots({
      url,
      referenceUrl: state.baseUrl,
      embedded: visualState.embedded,
      transparent: visualState.color.a < 1,
      color: visualState.color,
      owner: renderable,
      reportError: (err) => {
        this.renderer.settings.errors.add(
          settingsPath,
          MESH_FETCH_FAILED,
          `Error loading mesh from "${url}": ${err.message}`,
        );
      },
    });
    const finish = (result: AcquireMeshResult): void => {
      if (
        visualState.loadId !== loadId ||
        state.released ||
        renderable.userData.instancing !== state ||
        !visualState.pooled
      ) {
        if (result.status === "ready") {
          this.instancePool.releaseSlots(result.slots);
        }
        return;
      }
      switch (result.status) {
        case "ready":
          visualState.slots = result.slots;
          linkState.forceDirty = true;
          this.renderer.queueAnimationFrame();
          break;
        case "failed":
          if (!this.renderer.settings.errors.hasError(settingsPath, MESH_FETCH_FAILED)) {
            this.renderer.settings.errors.add(
              settingsPath,
              MESH_FETCH_FAILED,
              `Failed to load mesh from "${url}"`,
            );
          }
          break;
        case "nonMesh":
          // Models with line/point renderables keep the legacy per-link path.
          visualState.legacyChild = this.#createUrdfChild(
            renderable,
            state,
            linkState.frameId,
            visualState.visualIndex,
            visualState.visual,
          );
          this.renderer.queueAnimationFrame();
          break;
      }
    };
    if (outcome.status === "pending") {
      this.#trackLoad(outcome.promise.then(finish));
    } else {
      finish(outcome);
    }
  }

  #releaseInstancing(renderable: UrdfRenderable): void {
    const state = renderable.userData.instancing;
    if (!state || state.released) {
      return;
    }
    state.released = true;
    renderable.userData.instancing = undefined;
    for (const link of state.staticLinks) {
      for (const visual of link.visuals) {
        this.instancePool.releaseSlots(visual.slots);
        visual.slots = [];
      }
    }
  }

  // eslint-disable-next-line @lichtblick/no-boolean-parameters
  #handleRobotVisibility(renderable: UrdfRenderable, visible: boolean): void {
    const state = renderable.userData.instancing;
    if (!state || state.released) {
      return;
    }
    if (visible) {
      // Rewritten by the next startFrame before anything renders.
      for (const link of state.staticLinks) {
        link.forceDirty = true;
      }
    } else {
      for (const link of state.staticLinks) {
        for (const visual of link.visuals) {
          this.instancePool.hideSlots(visual.slots);
        }
      }
    }
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

/**
 * Names of links whose whole chain from the URDF root consists of fixed
 * joints. The root itself is static; parentless links that are not the root
 * (orphans, cycles) keep the legacy per-link path.
 */
function computeStaticLinkNames(transforms: TransformData[], rootFrame: string): Set<string> {
  const jointByChild = new Map<string, UrdfJoint>();
  for (const transform of transforms) {
    jointByChild.set(transform.child, transform.joint);
  }
  const staticLinks = new Set<string>();
  const articulated = new Set<string>();
  const visiting = new Set<string>();
  const isStatic = (link: string): boolean => {
    if (staticLinks.has(link)) {
      return true;
    }
    if (articulated.has(link) || visiting.has(link)) {
      articulated.add(link);
      return false;
    }
    const joint = jointByChild.get(link);
    if (!joint) {
      const isRoot = link === rootFrame;
      (isRoot ? staticLinks : articulated).add(link);
      return isRoot;
    }
    if (joint.jointType !== "fixed") {
      articulated.add(link);
      return false;
    }
    visiting.add(link);
    const parentStatic = isStatic(joint.parent);
    visiting.delete(link);
    (parentStatic ? staticLinks : articulated).add(link);
    return parentStatic;
  };
  for (const child of jointByChild.keys()) {
    isStatic(child);
  }
  isStatic(rootFrame);
  return staticLinks;
}

function poseValuesEqual(values: readonly number[] | undefined, pose: RootedPose): boolean {
  if (values?.length !== 7) {
    return false;
  }
  const p = pose.position;
  const q = pose.orientation;
  return (
    values[0] === p.x &&
    values[1] === p.y &&
    values[2] === p.z &&
    values[3] === q.x &&
    values[4] === q.y &&
    values[5] === q.z &&
    values[6] === q.w
  );
}

function capturePoseValues(pose: RootedPose): number[] {
  const p = pose.position;
  const q = pose.orientation;
  return [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
}

/**
 * world = rootPose ⊕ (scale·rel.t, rel.q) ⊕ (scale·visual.t, visual.q), with
 * (scale·dims) as the matrix scale — the same T·R·S composition the legacy
 * per-link Object3D path produces (#applyScaledChildPose / updatePoseViaRoot
 * plus the renderable's scale), computed here for one pooled instance. The
 * caller multiplies the result by the model leaf's local matrix for meshes.
 */
function composeStaticInstanceMatrix(
  out: THREE.Matrix4,
  rootPose: RootedPose,
  rel: RootedPose,
  visualPose: Pose,
  dims: Vector3,
  scale: number,
): void {
  instanceRootQuat.set(
    rootPose.orientation.x,
    rootPose.orientation.y,
    rootPose.orientation.z,
    rootPose.orientation.w,
  );
  instanceChainQuat.copy(instanceRootQuat);
  instanceChainQuat.multiply(
    instanceTempQuat.set(rel.orientation.x, rel.orientation.y, rel.orientation.z, rel.orientation.w),
  );
  instancePosVec
    .set(rel.position.x * scale, rel.position.y * scale, rel.position.z * scale)
    .applyQuaternion(instanceRootQuat);
  instancePosVec.x += rootPose.position.x;
  instancePosVec.y += rootPose.position.y;
  instancePosVec.z += rootPose.position.z;
  instanceOffsetVec
    .set(
      visualPose.position.x * scale,
      visualPose.position.y * scale,
      visualPose.position.z * scale,
    )
    .applyQuaternion(instanceChainQuat);
  instancePosVec.add(instanceOffsetVec);
  instanceChainQuat.multiply(
    instanceTempQuat.set(
      visualPose.orientation.x,
      visualPose.orientation.y,
      visualPose.orientation.z,
      visualPose.orientation.w,
    ),
  );
  instanceScaleVec.set(dims.x * scale, dims.y * scale, dims.z * scale);
  out.compose(instancePosVec, instanceChainQuat, instanceScaleVec);
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
