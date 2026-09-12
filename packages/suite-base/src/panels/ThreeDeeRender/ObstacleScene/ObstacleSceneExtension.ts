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
import { createGeometry, scaleGeometry, SCENE_DRAFT_ID } from "./geometry";
import { withObstaclePose } from "./motion";
import {
  isRecord,
  sceneNamespace,
  type SceneEnvelope,
  type SceneObstacle,
  type ScenePose,
  type SceneSelection,
  type Vec3,
} from "./types";
import type { AnyRendererSubscription, IRenderer } from "../IRenderer";
import { SceneExtension } from "../SceneExtension";
import { makePose } from "../transforms";
import { updatePose } from "../updatePose";

type SceneMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
type Drag = {
  selection: SceneSelection;
  obstacle: SceneObstacle;
  epoch: string;
  revision: number;
  changed: boolean;
};

function applyPose(object: THREE.Object3D, pose: ScenePose): void {
  object.position.fromArray(pose.position);
  object.quaternion.fromArray(pose.orientation);
  object.scale.set(1, 1, 1);
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
  #committing: { obstacleId: string } | undefined;
  #suppressClick = false;
  #lastState: { epoch: string; revision: number; poses: Map<string, ScenePose> } | undefined;
  #mode: "translate" | "rotate" | "scale" = "translate";
  #draftGroup: THREE.Group | undefined;

  public constructor(renderer: IRenderer) {
    super(ObstacleSceneExtension.extensionId, renderer);
    this.#canvas = renderer.gl.domElement;
    this.#frame.userData.pose = makePose();
    this.add(this.#frame);
    this.#controls = new TransformControls(renderer.cameraHandler.getActiveCamera(), this.#canvas);
    this.#controls.setSize(0.85);
    this.#controls.enabled = false;
    this.add(this.#controls);
    this.#controls.addEventListener("change", this.#controlsChanged);
    this.#controls.addEventListener("mouseDown", this.#beginDrag);
    this.#controls.addEventListener("objectChange", this.#previewChanged);
    this.#controls.addEventListener("mouseUp", this.#endDrag);
    this.#canvas.addEventListener("pointerdown", this.#capturePointerDown, true);
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

  #syncSession = (): void => {
    const state = this.session?.getSnapshot();
    const envelope = state?.envelope;
    if (!envelope) {
      this.cancelPreview();
      this.#committing = undefined;
      this.#clearGeometry();
      this.#accepted = undefined;
      return;
    }
    if (envelope.epoch !== this.#accepted?.epoch || envelope.revision !== this.#accepted.revision) {
      this.cancelPreview();
      this.#committing = undefined;
      this.#clearGeometry();
      this.renderer.addCoordinateFrame(envelope.document.frame);
      for (const obstacle of envelope.document.obstacles) {
        const group = new THREE.Group();
        group.name = obstacle.id;
        applyPose(group, obstacle.pose);
        for (const part of obstacle.parts) {
          const [r, g, b, opacity] = part.color;
          const material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r, g, b),
            opacity,
            transparent: opacity < 1,
            roughness: 0.8,
            side: THREE.DoubleSide,
          });
          const mesh = new THREE.Mesh(createGeometry(part.geometry), material);
          mesh.name = part.id;
          mesh.userData.obstacleId = obstacle.id;
          mesh.userData.partId = part.id;
          applyPose(mesh, part.pose);
          group.add(mesh);
          this.#meshes.push(mesh);
        }
        this.#groups.set(obstacle.id, group);
        this.#frame.add(group);
      }
    }
    this.#accepted = envelope;
    if (this.#drag && (this.session?.canEdit() !== true || !state.active)) {
      this.cancelPreview();
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
    this.#draftGroup.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.#draftGroup = undefined;
  }

  #syncPlacement(): void {
    this.#clearDraft();
    const state = this.session?.getSnapshot();
    const placement = state?.placement;
    if (
      !placement ||
      state?.active !== true ||
      state.live !== true ||
      state.authorized !== true ||
      state.envelope == undefined
    ) {
      return;
    }
    const group = new THREE.Group();
    group.name = SCENE_DRAFT_ID;
    applyPose(group, placement.pose);
    for (const part of placement.parts) {
      const [r, g, b] = part.color;
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(r, g, b),
        opacity: 0.45,
        transparent: true,
        roughness: 0.8,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(createGeometry(part.geometry), material);
      mesh.name = part.id;
      mesh.userData.obstacleId = SCENE_DRAFT_ID;
      mesh.userData.partId = part.id;
      mesh.userData.draft = true;
      applyPose(mesh, part.pose);
      group.add(mesh);
      this.#meshes.push(mesh);
    }
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
    const part = state?.envelope?.document.obstacles
      .find((o) => o.id === state.selection?.obstacleId)
      ?.parts.find((p) => p.id === state.selection?.partId);
    return part?.geometry.type === "box" || part?.geometry.type === "convex";
  }

  public setMode(mode: "translate" | "rotate" | "scale"): void {
    this.cancelPreview();
    this.#mode = mode === "scale" && !this.canScale() ? "translate" : mode;
    this.#controls.setMode(this.#mode);
    this.#controls.setSpace(this.#mode === "scale" ? "local" : "world");
    this.renderer.queueAnimationFrame();
  }

  public setLocalSpace({ local }: { local: boolean }): void {
    this.#controls.setSpace(this.#mode === "scale" || local ? "local" : "world");
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
    return selection.partId
      ? group?.children.find((child) => child.name === selection.partId)
      : group;
  }

  #attach(): void {
    const state = this.session?.getSnapshot();
    const selection = state?.selection;
    const target = this.#target(selection);
    this.#controls.enabled = state?.active === true && this.canTransform();
    if (this.#mode === "scale" && !this.canScale()) {
      this.setMode("translate");
    }
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
      mesh.material.emissive.setHex(selected ? 0x57431c : 0x000000);
    }
  }

  #capturePointerDown = (event: PointerEvent): void => {
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
      raycaster.intersectObject(gizmo.picker[this.#mode], true).some((hit) => hit.object.visible)
    ) {
      this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: false });
      // The preceding property edit may own keyboard focus; Escape must cancel this canvas drag.
      this.#canvas.focus({ preventScroll: true });
      // Suppress compatibility mouse events so picking and camera gestures cannot steal this drag.
      event.preventDefault();
      this.#suppressClick = true;
    }
  };

  #beginDrag = (): void => {
    const state = this.session?.getSnapshot();
    const envelope = state?.envelope;
    if (!envelope || !this.canTransform()) {
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
      };
    } else {
      const obstacle = envelope.document.obstacles.find((o) => o.id === state.selection?.obstacleId);
      if (!obstacle) {
        return;
      }
      this.#drag = {
        selection: state.selection,
        obstacle: _.cloneDeep(obstacle),
        epoch: envelope.epoch,
        revision: envelope.revision,
        changed: false,
      };
    }
    this.#suppressClick = true;
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: false });
  };

  #controlsChanged = (): void => {
    this.renderer.queueAnimationFrame();
  };

  #previewChanged = (): void => {
    if (this.#drag) {
      this.#drag.changed = true;
    }
    this.renderer.queueAnimationFrame();
  };

  #endDrag = (): void => {
    const drag = this.#drag;
    const target = this.#target(drag?.selection);
    this.#drag = undefined;
    this.renderer.cameraHandler.setInteractionEnabled?.({ enabled: true });
    if (!drag || !target || !drag.changed) {
      return;
    }
    const current = this.session?.getSnapshot().envelope;
    if (current?.epoch !== drag.epoch || current.revision !== drag.revision) {
      this.#restoreAccepted();
      this.session?.reportError(
        "The scene changed while dragging. Select the obstacle and try again.",
      );
      return;
    }
    try {
      let obstacle = drag.obstacle;
      const part = obstacle.parts.find((p) => p.id === drag.selection.partId);
      const pose: ScenePose = {
        position: target.position.toArray(),
        orientation: target.quaternion.clone().normalize().toArray() as ScenePose["orientation"],
      };
      if (drag.selection.obstacleId === SCENE_DRAFT_ID) {
        this.session?.setPlacement(withObstaclePose(obstacle, pose));
        return;
      }
      if (part) {
        part.pose = pose;
        part.geometry = scaleGeometry(part.geometry, target.scale.toArray());
      } else {
        obstacle = withObstaclePose(obstacle, pose);
      }
      const committing = { obstacleId: obstacle.id };
      this.#committing = committing;
      void this.session?.command({ operation: "update", obstacle }).finally(() => {
        if (this.#committing === committing) {
          this.#committing = undefined;
          this.#restoreAccepted();
        }
      });
    } catch (error) {
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
    for (const mesh of this.#meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
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
    this.#controls.dispose();
    this.#clearGeometry();
    this.#canvas.removeEventListener("pointerdown", this.#capturePointerDown, true);
    this.#canvas.removeEventListener("pointercancel", this.#cancelPointer);
    this.#canvas.removeEventListener("pointerup", this.#releasePointer, true);
    this.#canvas.removeEventListener("click", this.#pick, true);
    this.#canvas.removeEventListener("keydown", this.#keydown, true);
    super.dispose();
  }
}
