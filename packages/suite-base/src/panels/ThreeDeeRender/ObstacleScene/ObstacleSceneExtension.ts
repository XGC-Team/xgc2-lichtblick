// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";
import * as THREE from "three";
import {
  TransformControls,
  type TransformControlsGizmo,
} from "three/examples/jsm/controls/TransformControls.js";

import type { MessageEvent } from "@lichtblick/suite";

import { SceneEditorSession } from "./SceneEditorSession";
import {
  createGeometry,
  geometryScaleConstraint,
  scaleGeometry,
  scaleObstacleUniformly,
  SCENE_DRAFT_ID,
  type SceneScaleConstraint,
} from "./geometry";
import { withObstaclePose } from "./motion";
import {
  isRecord,
  sceneColorOverride,
  sceneNamespace,
  type SceneEnvelope,
  type SceneObstacle,
  type ScenePart,
  type ScenePose,
  type SceneSelection,
  type Vec3,
} from "./types";
import {
  convexFacePlanes,
  createObstacleEdges,
  createObstacleFill,
  createObstacleSolid,
  RENDER_ORDER_FILL,
  setObstacleVisualSelected,
  trimSharedFaces,
  type Rgb,
} from "./visuals";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { SceneExtension } from "../SceneExtension";
import { makePose } from "../transforms";
import { updatePose } from "../updatePose";

type SceneMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.MeshBasicMaterial | THREE.MeshLambertMaterial
>;
type Drag = {
  selection: SceneSelection;
  obstacle: SceneObstacle;
  epoch: string;
  revision: number;
  changed: boolean;
  target: THREE.Object3D;
  partId?: string;
  mode: TransformState["mode"];
  uniformPointerStart?: THREE.Vector2;
};

type TransformState = {
  mode: "translate" | "rotate" | "scale";
  local: boolean;
  dragging: boolean;
  /** Transient candidate only; the session remains the sole accepted document. */
  preview?: SceneObstacle;
  scaleFactor?: number;
};

function applyPose(object: THREE.Object3D, pose: ScenePose): void {
  object.position.fromArray(pose.position);
  object.quaternion.fromArray(pose.orientation);
  object.scale.set(1, 1, 1);
}

function disposeVisuals(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.LineSegments ||
      object instanceof THREE.LineLoop
    ) {
      object.geometry.dispose();
      const material = object.material as THREE.Material | THREE.Material[];
      for (const entry of Array.isArray(material) ? material : [material]) {
        entry.dispose();
      }
    }
  });
}

function poseMatrix(pose: ScenePose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.position),
    new THREE.Quaternion(...pose.orientation),
    new THREE.Vector3(1, 1, 1),
  );
}

/** Sibling face planes in this part's local frame, for decomposition seam suppression. */
function seamBlockers(
  parts: ScenePart[],
  planeSets: THREE.Plane[][],
  index: number,
): THREE.Plane[][] {
  if (parts.length < 2) {
    return [];
  }
  const inverse = poseMatrix(parts[index]!.pose).invert();
  return planeSets
    .filter((_planeSet, j) => j !== index)
    .map((set) => set.map((plane) => plane.clone().applyMatrix4(inverse)));
}

/** Typed scene projection and authoring controls. Ordinary markers are never editable entities. */
export class ObstacleSceneExtension extends SceneExtension {
  public static extensionId = "xgc2.ObstacleScene";
  public readonly session: SceneEditorSession | undefined;
  #frame = new THREE.Group();
  #groups = new Map<string, THREE.Group>();
  #meshes: SceneMesh[] = [];
  #controls: TransformControls;
  #canvas: HTMLCanvasElement;
  #unsubscribe: (() => void) | undefined;
  #accepted: SceneEnvelope | undefined;
  #drag: Drag | undefined;
  #pointer = new THREE.Vector2();
  #committing: { obstacleId: string } | undefined;
  #suppressClick = false;
  #lastState: { epoch: string; revision: number; poses: Map<string, ScenePose> } | undefined;
  #transform: TransformState = { mode: "translate", local: false, dragging: false };
  #transformListeners = new Set<() => void>();
  #scaleConstraint: SceneScaleConstraint = "xyz";
  #scaleHandles: { group: THREE.Object3D; children: THREE.Object3D[] }[];
  #draftGroup: THREE.Group | undefined;
  #colorOverride: [number, number, number, number] | undefined;
  /** Image panes render the glass overlay; every other pane renders the lit solid. */
  #imagePane: boolean;

  public constructor(renderer: IRenderer) {
    super(ObstacleSceneExtension.extensionId, renderer);
    this.#canvas = renderer.gl.domElement;
    this.#frame.userData.pose = makePose();
    this.#imagePane = renderer.interfaceMode === "image";
    this.#colorOverride = sceneColorOverride(renderer.config.scene.obstacleScene?.color);
    this.add(this.#frame);
    this.#controls = new TransformControls(renderer.cameraHandler.getActiveCamera(), this.#canvas);
    const gizmo = this.#controls.children.find(
      (child) => child.type === "TransformControlsGizmo",
    ) as TransformControlsGizmo;
    this.#scaleHandles = [gizmo.gizmo.scale, gizmo.picker.scale, gizmo.helper.scale].map(
      (group) => ({ group, children: [...group.children] }),
    );
    this.#controls.setSize(0.85);
    this.#controls.enabled = false;
    this.add(this.#controls);
    this.#controls.addEventListener("change", this.#controlsChanged);
    this.#controls.addEventListener("mouseDown", this.#beginDrag);
    this.#controls.addEventListener("objectChange", this.#previewChanged);
    this.#controls.addEventListener("mouseUp", this.#endDrag);
    this.#canvas.addEventListener("pointerdown", this.#capturePointerDown, true);
    this.#canvas.addEventListener("pointermove", this.#capturePointerMove, true);
    this.#canvas.addEventListener("pointercancel", this.#cancelPointer);
    this.#canvas.addEventListener("pointerup", this.#releasePointer, true);
    this.#canvas.addEventListener("click", this.#pick, true);
    this.#canvas.addEventListener("keydown", this.#keydown, true);
    const namespace = sceneNamespace(renderer.config.scene.obstacleScene?.namespace);
    if (namespace) {
      this.session = new SceneEditorSession(namespace);
      this.#unsubscribe = this.session.subscribe(this.#syncSession);
    }
  }

  public override getSubscriptions(): readonly AnyRendererSubscription[] {
    if (!this.session) {
      return [];
    }
    return [
      {
        type: "topic",
        topicName: `${this.session.namespace}/document`,
        subscription: { shouldSubscribe: () => true, handler: this.#document },
      },
      {
        type: "topic",
        topicName: `${this.session.namespace}/state`,
        subscription: { shouldSubscribe: () => true, handler: this.#state },
      },
    ];
  }

  #document = (event: MessageEvent): void => {
    try {
      if (!isRecord(event.message) || typeof event.message.data !== "string") {
        throw new Error("The scene document topic must contain JSON in std_msgs/String.");
      }
      this.session?.accept(JSON.parse(event.message.data));
    } catch (error) {
      this.session?.reportError(error);
    }
  };

  #state = (event: MessageEvent): void => {
    const value = event.message;
    const envelope = this.session?.getSnapshot().envelope;
    if (
      !envelope ||
      !isRecord(value) ||
      value.epoch !== envelope.epoch ||
      Number(value.revision) !== envelope.revision ||
      !Array.isArray(value.obstacles)
    ) {
      return;
    }
    const poses = new Map<string, ScenePose>();
    for (const obstacle of value.obstacles) {
      if (!isRecord(obstacle) || typeof obstacle.id !== "string" || !isRecord(obstacle.pose)) {
        return;
      }
      const { position: p, orientation: q } = obstacle.pose;
      if (!isRecord(p) || !isRecord(q)) {
        return;
      }
      const position = [p.x, p.y, p.z];
      const orientation = [q.x, q.y, q.z, q.w];
      if (
        ![...position, ...orientation].every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        return;
      }
      poses.set(obstacle.id, {
        position: position as Vec3,
        orientation: orientation as ScenePose["orientation"],
      });
    }
    this.#lastState = { epoch: envelope.epoch, revision: envelope.revision, poses };
    this.#applyRuntimePoses();
    this.renderer.queueAnimationFrame();
  };

  /**
   * One part mesh. The image pane gets the trimmed glass overlay with facet
   * edges; other panes get the lit solid, whose opaque depth already hides the
   * coincident interior faces of a convex decomposition.
   */
  #partMesh(
    parts: ScenePart[],
    planeSets: THREE.Plane[][],
    index: number,
    rgba: [...Rgb, number],
  ): SceneMesh {
    const part = parts[index]!;
    const blockers = this.#imagePane ? seamBlockers(parts, planeSets, index) : [];
    const mesh: SceneMesh = this.#imagePane
      ? new THREE.Mesh(
          trimSharedFaces(createGeometry(part.geometry), blockers),
          createObstacleFill(rgba),
        )
      : new THREE.Mesh(createGeometry(part.geometry), createObstacleSolid(rgba));
    mesh.name = part.id;
    if (this.#imagePane) {
      mesh.renderOrder = RENDER_ORDER_FILL;
      const edges = createObstacleEdges(mesh.geometry, rgba.slice(0, 3) as Rgb, blockers);
      if (edges) {
        edges.name = `${part.id}:edges`;
        mesh.add(edges);
        mesh.userData.edges = edges;
      }
    }
    applyPose(mesh, part.pose);
    return mesh;
  }

  /** Sibling face planes, only needed by the image-pane seam suppression. */
  #partPlaneSets(parts: ScenePart[]): THREE.Plane[][] {
    return this.#imagePane
      ? parts.map((part) => convexFacePlanes(createGeometry(part.geometry), part.pose))
      : [];
  }

  #syncSession = (): void => {
    const state = this.session?.getSnapshot();
    const envelope = state?.envelope;
    if (!envelope) {
      this.cancelPreview();
      this.#committing = undefined;
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      this.#clearGeometry();
      this.#accepted = undefined;
      return;
    }
    if (envelope.epoch !== this.#accepted?.epoch || envelope.revision !== this.#accepted.revision) {
      this.cancelPreview();
      this.#committing = undefined;
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      this.#clearGeometry();
      this.renderer.addCoordinateFrame(envelope.document.frame);
      for (const obstacle of envelope.document.obstacles) {
        const group = new THREE.Group();
        group.name = obstacle.id;
        applyPose(group, obstacle.pose);
        const planeSets = this.#partPlaneSets(obstacle.parts);
        obstacle.parts.forEach((part, index) => {
          const mesh = this.#partMesh(
            obstacle.parts,
            planeSets,
            index,
            this.#colorOverride ?? part.color,
          );
          mesh.userData.obstacleId = obstacle.id;
          mesh.userData.partId = part.id;
          group.add(mesh);
          this.#meshes.push(mesh);
        });
        this.#groups.set(obstacle.id, group);
        this.#frame.add(group);
      }
    }
    this.#accepted = envelope;
    if (
      this.#drag &&
      (this.session?.canEdit() !== true ||
        !state.active ||
        this.#drag.selection.obstacleId !== (state.selection?.obstacleId ?? SCENE_DRAFT_ID) ||
        this.#drag.selection.partId !== state.selection?.partId)
    ) {
      this.cancelPreview();
    }
    if (this.#committing && (!state.live || !state.authorized || state.needsRefresh)) {
      this.#committing = undefined;
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      this.#restoreAccepted();
    }
    this.#applyRuntimePoses();
    if (!this.#isDraftDrag()) {
      this.#syncPlacement();
    }
    this.#attach();
    this.renderer.queueAnimationFrame();
  };

  #applyRuntimePoses(): void {
    const envelope = this.session?.getSnapshot().envelope;
    if (!envelope) {
      return;
    }
    for (const obstacle of envelope.document.obstacles) {
      if (
        this.#drag?.selection.obstacleId === obstacle.id ||
        this.#committing?.obstacleId === obstacle.id
      ) {
        continue;
      }
      const group = this.#groups.get(obstacle.id);
      if (group) {
        const runtimePose =
          this.#lastState?.epoch === envelope.epoch &&
          this.#lastState.revision === envelope.revision
            ? this.#lastState.poses.get(obstacle.id)
            : undefined;
        applyPose(group, runtimePose ?? obstacle.pose);
      }
    }
  }

  #isDraftDrag(): boolean {
    return this.#drag?.selection.obstacleId === SCENE_DRAFT_ID;
  }

  #clearDraft(): void {
    if (!this.#draftGroup) {
      return;
    }
    if (this.#controls.object === this.#draftGroup) {
      this.#controls.detach();
    }
    this.#meshes = this.#meshes.filter((mesh) => mesh.userData.draft !== true);
    this.#frame.remove(this.#draftGroup);
    disposeVisuals(this.#draftGroup);
    this.#draftGroup = undefined;
  }

  #syncPlacement(): void {
    this.#clearDraft();
    const state = this.session?.getSnapshot();
    const placement = state?.placement;
    if (
      !placement ||
      !state.active ||
      !state.live ||
      !state.authorized ||
      state.envelope == undefined
    ) {
      return;
    }
    const group = new THREE.Group();
    group.name = SCENE_DRAFT_ID;
    applyPose(group, placement.pose);
    const planeSets = this.#partPlaneSets(placement.parts);
    placement.parts.forEach((part, index) => {
      const [r, g, b] = part.color;
      const mesh = this.#partMesh(placement.parts, planeSets, index, [r, g, b, 0.45]);
      mesh.userData.obstacleId = SCENE_DRAFT_ID;
      mesh.userData.partId = part.id;
      mesh.userData.draft = true;
      group.add(mesh);
      this.#meshes.push(mesh);
    });
    this.#draftGroup = group;
    this.#frame.add(group);
  }

  public canTransform(): boolean {
    const state = this.session?.getSnapshot();
    if (this.session?.canEdit() !== true || state == undefined) {
      return false;
    }
    if (!state.selection) {
      return state.placement != undefined;
    }
    const obstacle = state.envelope?.document.obstacles.find(
      (o) => o.id === state.selection?.obstacleId,
    );
    // Motion definitions are edited at their initial placement, never at an arbitrary moving frame.
    return (
      obstacle != undefined &&
      (obstacle.motion.type === "hold" ||
        (state.envelope?.playing === false && state.envelope.sceneTime === 0))
    );
  }

  public canScale(): boolean {
    const state = this.session?.getSnapshot();
    return (
      state?.envelope?.document.obstacles.some((o) => o.id === state.selection?.obstacleId) === true
    );
  }

  public getTransformSnapshot = (): TransformState => this.#transform;
  public subscribeTransform = (listener: () => void): (() => void) => {
    this.#transformListeners.add(listener);
    return () => this.#transformListeners.delete(listener);
  };

  #setTransform(patch: Partial<TransformState>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.#transform[key as keyof TransformState] === value,
      )
    ) {
      return;
    }
    this.#transform = { ...this.#transform, ...patch };
    this.#transformListeners.forEach((listener) => {
      listener();
    });
  }

  public setMode(mode: "translate" | "rotate" | "scale"): void {
    this.cancelPreview();
    this.#setTransform({ mode: mode === "scale" && !this.canScale() ? "translate" : mode });
    this.#attach();
    this.renderer.queueAnimationFrame();
  }

  public setLocalSpace({ local }: { local: boolean }): void {
    this.cancelPreview();
    this.#setTransform({ local });
    this.#controls.setSpace(this.#transform.mode === "scale" || local ? "local" : "world");
    this.renderer.queueAnimationFrame();
  }

  #target(selection: SceneSelection | undefined): THREE.Object3D | undefined {
    if (!selection) {
      return this.#draftGroup;
    }
    if (selection.obstacleId === SCENE_DRAFT_ID) {
      return this.#draftGroup;
    }
    const group = this.#groups.get(selection.obstacleId);
    const obstacle = this.session
      ?.getSnapshot()
      .envelope?.document.obstacles.find((o) => o.id === selection.obstacleId);
    const partId =
      selection.partId ??
      (this.#transform.mode === "scale" && obstacle?.parts.length === 1
        ? obstacle.parts[0]!.id
        : undefined);
    return partId ? group?.children.find((child) => child.name === partId) : group;
  }

  #syncScaleHandles(): void {
    const state = this.session?.getSnapshot();
    const obstacle = state?.envelope?.document.obstacles.find(
      (o) => o.id === state.selection?.obstacleId,
    );
    const part =
      obstacle?.parts.find((p) => p.id === state?.selection?.partId) ??
      (obstacle?.parts.length === 1 ? obstacle.parts[0] : undefined);
    const constraint = part ? geometryScaleConstraint(part.geometry) : "uniform";
    if (constraint === this.#scaleConstraint) {
      return;
    }
    this.#scaleConstraint = constraint;
    // Remove disallowed native handles from both drawing and picking. showX/Y/Z
    // would also hide the centre XYZ handle, which is the uniform scale control.
    for (const { group, children } of this.#scaleHandles) {
      group.clear();
      const allowed = children.filter(
        (child) =>
          constraint === "xyz" ||
          child.name === "XYZ" ||
          (constraint === "radial" && ["X", "Y", "Z"].includes(child.name)),
      );
      if (allowed.length > 0) {
        group.add(...allowed);
      }
    }
    this.#controls.axis = null;
  }

  #attach(): void {
    const state = this.session?.getSnapshot();
    const selection = state?.selection;
    this.#controls.enabled = state?.active === true && this.canTransform();
    if (this.#transform.mode === "scale" && !this.canScale()) {
      this.#setTransform({ mode: "translate" });
    }
    this.#controls.setMode(this.#transform.mode);
    this.#controls.setSpace(
      this.#transform.mode === "scale" || this.#transform.local ? "local" : "world",
    );
    this.#syncScaleHandles();
    const target = this.#target(selection);
    if (target && this.#controls.enabled) {
      if (this.#controls.object !== target) {
        this.#controls.attach(target);
      }
    } else {
      this.#controls.detach();
    }
    for (const mesh of this.#meshes) {
      const selected =
        state?.active === true &&
        (mesh.userData.draft === true
          ? !selection
          : mesh.userData.obstacleId === selection?.obstacleId &&
            (!selection?.partId || mesh.userData.partId === selection.partId));
      setObstacleVisualSelected(mesh, { selected });
    }
  }

  #capturePointerDown = (event: PointerEvent): void => {
    this.#pointer.set(event.clientX, event.clientY);
    this.#suppressClick = false;
    if (!this.#controls.enabled || event.button !== 0) {
      return;
    }
    const gizmo = this.#controls.children.find(
      (child) => child.type === "TransformControlsGizmo",
    ) as TransformControlsGizmo | undefined;
    const rect = this.#canvas.getBoundingClientRect();
    const raycaster = this.#controls.getRaycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.renderer.cameraHandler.getActiveCamera(),
    );
    this.#controls.updateMatrixWorld(true);
    if (
      gizmo &&
      raycaster
        .intersectObject(gizmo.picker[this.#transform.mode], true)
        .some((hit) => hit.object.visible)
    ) {
      this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: false });
      // The preceding property edit may own keyboard focus; Escape must cancel this canvas drag.
      this.#canvas.focus({ preventScroll: true });
      // Suppress compatibility mouse events so picking and camera gestures cannot steal this drag.
      event.preventDefault();
      this.#suppressClick = true;
    }
  };

  #capturePointerMove = (event: PointerEvent): void => {
    this.#pointer.set(event.clientX, event.clientY);
  };

  #beginDrag = (): void => {
    const state = this.session?.getSnapshot();
    const envelope = state?.envelope;
    const target = this.#target(state?.selection);
    if (!envelope || !target || !this.canTransform()) {
      return;
    }
    if (!state.selection) {
      const placement = state.placement;
      if (!placement) {
        return;
      }
      this.#drag = {
        selection: { obstacleId: SCENE_DRAFT_ID },
        obstacle: _.cloneDeep(placement),
        epoch: envelope.epoch,
        revision: envelope.revision,
        changed: false,
        target,
        mode: this.#transform.mode,
      };
    } else {
      const obstacle = envelope.document.obstacles.find(
        (o) => o.id === state.selection?.obstacleId,
      );
      if (!obstacle) {
        return;
      }
      this.#drag = {
        selection: state.selection,
        obstacle: _.cloneDeep(obstacle),
        epoch: envelope.epoch,
        revision: envelope.revision,
        changed: false,
        target,
        mode: this.#transform.mode,
        partId:
          state.selection.partId ??
          (this.#transform.mode === "scale" && obstacle.parts.length === 1
            ? obstacle.parts[0]!.id
            : undefined),
      };
    }
    this.#suppressClick = true;
    if (this.#drag.mode === "scale" && this.#controls.axis === "XYZ") {
      this.#drag.uniformPointerStart = this.#pointer.clone();
    }
    this.#setTransform({ dragging: true, preview: this.#drag.obstacle });
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: false });
  };

  #controlsChanged = (): void => {
    this.renderer.queueAnimationFrame();
  };

  #previewChanged = (): void => {
    if (this.#drag) {
      try {
        const { target, mode } = this.#drag;
        if (this.#drag.uniformPointerStart) {
          // Native XYZ scaling divides by the initial distance from the origin.
          // The centre handle can be grabbed at that origin, making tiny drags
          // explode to hundreds of times the size. Use a positive screen-space
          // ratio for that handle; axis/plane handles retain native geometry.
          const delta = this.#pointer.clone().sub(this.#drag.uniformPointerStart);
          const factor = Math.exp(THREE.MathUtils.clamp((delta.x - delta.y) / 160, -4.6, 4.6));
          target.scale.setScalar(factor);
        }
        if (mode === "scale" && this.#scaleConstraint === "radial") {
          if (this.#controls.axis === "X") {
            target.scale.y = target.scale.x;
          } else if (this.#controls.axis === "Y") {
            target.scale.x = target.scale.y;
          }
        }
        const preview = this.#dragCandidate(this.#drag);
        this.#drag.changed = true;
        this.#setTransform({ preview, scaleFactor: mode === "scale" ? target.scale.x : undefined });
      } catch (error) {
        this.cancelPreview();
        this.session?.reportError(error);
      }
    }
    this.renderer.queueAnimationFrame();
  };

  #dragCandidate(drag: Drag): SceneObstacle {
    const { obstacle, target, partId, mode } = drag;
    const pose: ScenePose = {
      position: target.position.toArray(),
      orientation: target.quaternion.clone().normalize().toArray() as ScenePose["orientation"],
    };
    if (partId) {
      return {
        ...obstacle,
        parts: obstacle.parts.map((part) =>
          part.id === partId
            ? {
                ...part,
                pose,
                geometry:
                  mode === "scale"
                    ? scaleGeometry(part.geometry, target.scale.toArray())
                    : part.geometry,
              }
            : part,
        ),
      };
    }
    if (mode === "scale") {
      if (
        Math.abs(target.scale.x - target.scale.y) > 1e-5 ||
        Math.abs(target.scale.x - target.scale.z) > 1e-5
      ) {
        throw new Error(
          "Scale the whole obstacle equally on every axis; edit individual parts for other dimensions.",
        );
      }
      return scaleObstacleUniformly(obstacle, target.scale.x);
    }
    return withObstaclePose(obstacle, pose);
  }

  #endDrag = (): void => {
    const drag = this.#drag;
    this.#drag = undefined;
    this.#setTransform({ dragging: false });
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: true });
    if (drag?.changed !== true) {
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      return;
    }
    const current = this.session?.getSnapshot().envelope;
    if (current?.epoch !== drag.epoch || current.revision !== drag.revision) {
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      this.#restoreAccepted();
      this.session?.reportError(
        "The scene changed while dragging. Select the obstacle and try again.",
      );
      return;
    }
    try {
      const obstacle = this.#dragCandidate(drag);
      if (drag.selection.obstacleId === SCENE_DRAFT_ID) {
        this.#setTransform({ preview: undefined, scaleFactor: undefined });
        this.session?.setPlacement(obstacle);
        return;
      }
      const committing = { obstacleId: obstacle.id };
      this.#committing = committing;
      void this.session?.command({ operation: "update", obstacle }).finally(() => {
        if (this.#committing === committing) {
          this.#committing = undefined;
          this.#setTransform({ preview: undefined, scaleFactor: undefined });
          this.#restoreAccepted();
        }
      });
    } catch (error) {
      this.#setTransform({ preview: undefined, scaleFactor: undefined });
      this.#restoreAccepted();
      this.session?.reportError(error);
    }
  };

  #restoreAccepted(): void {
    const envelope = this.session?.getSnapshot().envelope;
    for (const obstacle of envelope?.document.obstacles ?? []) {
      const group = this.#groups.get(obstacle.id);
      if (!group) {
        continue;
      }
      applyPose(group, obstacle.pose);
      for (const part of obstacle.parts) {
        const child = group.children.find((object) => object.name === part.id);
        if (child) {
          applyPose(child, part.pose);
        }
      }
    }
    const placement = this.session?.getSnapshot().placement;
    if (this.#draftGroup && placement) {
      applyPose(this.#draftGroup, placement.pose);
    }
    this.#applyRuntimePoses();
    this.renderer.queueAnimationFrame();
  }

  public cancelPreview(): void {
    if (!this.#drag) {
      return;
    }
    this.#drag = undefined;
    this.#setTransform({ dragging: false, preview: undefined, scaleFactor: undefined });
    this.#controls.reset();
    this.#controls.dragging = false;
    this.#restoreAccepted();
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: true });
  }

  #releasePointer = (): void => {
    if (!this.#drag) {
      this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: true });
    }
  };

  #cancelPointer = (): void => {
    this.cancelPreview();
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: true });
  };
  #keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.session?.getSnapshot().active === true) {
      this.cancelPreview();
      event.stopPropagation();
      event.preventDefault();
    }
  };
  #pick = (event: MouseEvent): void => {
    if (this.session?.getSnapshot().active !== true || !this.#frame.visible) {
      return;
    }
    if (this.#suppressClick) {
      event.stopImmediatePropagation();
      this.#suppressClick = false;
      return;
    }
    const rect = this.#canvas.getBoundingClientRect();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      this.renderer.cameraHandler.getActiveCamera(),
    );
    const mesh = raycaster.intersectObjects(this.#meshes, false)[0]?.object;
    if (mesh?.userData.draft === true) {
      this.session.select(undefined);
      event.stopImmediatePropagation();
      return;
    }
    if (mesh) {
      this.session.select({
        obstacleId: mesh.userData.obstacleId as string,
        ...(event.altKey ? { partId: mesh.userData.partId as string } : {}),
      });
      event.stopImmediatePropagation();
    } else {
      this.session.select(undefined);
    }
  };

  public override startFrame(
    currentTime: bigint,
    renderFrameId: string,
    fixedFrameId: string,
  ): void {
    const envelope = this.session?.getSnapshot().envelope;
    if (!envelope) {
      return;
    }
    const frame = this.renderer.normalizeFrameId(envelope.document.frame);
    const success = updatePose(
      this.#frame,
      this.renderer.transformTree,
      renderFrameId,
      fixedFrameId,
      frame,
      currentTime,
      currentTime,
    );
    this.#controls.camera = this.renderer.cameraHandler.getActiveCamera();
    this.#controls.visible = success && this.#controls.object != undefined;
  }

  #clearGeometry(): void {
    this.#controls.detach();
    this.#clearDraft();
    disposeVisuals(this.#frame);
    this.#meshes = [];
    this.#groups.clear();
    this.#frame.clear();
  }

  public override removeAllRenderables(): void {
    this.cancelPreview();
    this.#clearGeometry();
    this.#lastState = undefined;
    this.#accepted = undefined;
    this.session?.resetForSeek();
    super.removeAllRenderables();
  }

  public override dispose(): void {
    this.cancelPreview();
    this.#unsubscribe?.();
    this.session?.dispose();
    this.#transformListeners.clear();
    for (const { group, children } of this.#scaleHandles) {
      group.clear();
      group.add(...children);
    }
    this.#controls.dispose();
    this.#clearGeometry();
    this.#canvas.removeEventListener("pointerdown", this.#capturePointerDown, true);
    this.#canvas.removeEventListener("pointermove", this.#capturePointerMove, true);
    this.#canvas.removeEventListener("pointercancel", this.#cancelPointer);
    this.#canvas.removeEventListener("pointerup", this.#releasePointer, true);
    this.#canvas.removeEventListener("click", this.#pick, true);
    this.#canvas.removeEventListener("keydown", this.#keydown, true);
    super.dispose();
  }
}
