// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { geometryRegistry, type NamedGeometry } from "./geometryRegistry.generated";

export type Vec3 = [number, number, number];
export type ScenePose = {
  position: Vec3;
  orientation: [number, number, number, number];
};
export type SceneGeometry = NamedGeometry;
export type ScenePart = {
  id: string;
  pose: ScenePose;
  geometry: SceneGeometry;
  color: [number, number, number, number];
};
/** Product visual: opaque amber. Geometry stays authored; color is not per-scene. */
export const OBSTACLE_VISUAL_COLOR: [number, number, number, number] = [1, 0.5, 0.1, 1];
export type SceneMotion =
  | { type: "hold" }
  | { type: "constant_twist"; linear: Vec3; angular: Vec3 }
  | { type: "ping_pong"; point_a: Vec3; point_b: Vec3; speed: number }
  | {
      type: "circle";
      center: Vec3;
      radius: number;
      angular_speed: number;
      phase: number;
    };
export type SceneObstacle = {
  id: string;
  name: string;
  pose: ScenePose;
  parts: ScenePart[];
  motion: SceneMotion;
};
export type SceneDocument = {
  schema: "xgc2.scene.v1";
  id: string;
  frame: string;
  obstacles: SceneObstacle[];
};
export type SceneEnvelope = {
  epoch: string;
  revision: number;
  savedRevision: number;
  synchronized?: boolean;
  dirty: boolean;
  playing: boolean;
  sceneTime: number;
  document: SceneDocument;
  consumers: {
    consumer: string;
    epoch: string;
    revision: number;
    applied: boolean;
    operational: boolean;
    capability: "" | "ok" | "unsupported";
    generation?: number;
    message: string;
  }[];
  syncRetryable?: boolean;
};
export type SceneCommand = {
  requestId: string;
  expectedEpoch?: string;
  expectedRevision?: number;
} & (
  | {
      operation:
        | "get"
        | "undo"
        | "redo"
        | "play"
        | "pause"
        | "reset"
        | "clear"
        | "resync"
        | "reload";
    }
  | { operation: "save" }
  | { operation: "add" | "update"; obstacle: SceneObstacle }
  | { operation: "delete"; id: string }
  | { operation: "replace"; document: SceneDocument }
);
export type SceneCommandResult = Partial<SceneEnvelope> & {
  success: boolean;
  error?: string;
};
export type SceneSelection = { obstacleId: string; partId?: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function finiteTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((v) => Number.isFinite(v));
}

function poseValid(value: unknown): value is ScenePose {
  return (
    isRecord(value) &&
    finiteTuple(value.position, 3) &&
    finiteTuple(value.orientation, 4) &&
    Math.abs(Math.hypot(...value.orientation) - 1) < 1e-5
  );
}

function motionValid(value: unknown): value is SceneMotion {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case "hold":
      return true;
    case "constant_twist":
      return finiteTuple(value.linear, 3) && finiteTuple(value.angular, 3);
    case "ping_pong":
      return (
        finiteTuple(value.point_a, 3) &&
        finiteTuple(value.point_b, 3) &&
        typeof value.speed === "number" &&
        Number.isFinite(value.speed) &&
        value.speed > 0
      );
    case "circle":
      return (
        finiteTuple(value.center, 3) &&
        typeof value.radius === "number" &&
        Number.isFinite(value.radius) &&
        value.radius > 0 &&
        Number.isFinite(value.angular_speed) &&
        Number.isFinite(value.phase)
      );
    default:
      return false;
  }
}

export function geometryValid(value: unknown): value is SceneGeometry {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !Object.hasOwn(geometryRegistry, value.type)
  ) {
    return false;
  }
  const spec = geometryRegistry[value.type as keyof typeof geometryRegistry];
  const fields: readonly string[] = spec.fields;
  const allowed = ["type", ...fields.map((field) => field.split("[")[0]!)];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    return false;
  }
  if (fields.includes("vertices")) {
    const { vertices, triangles } = value;
    if (
      !Array.isArray(vertices) ||
      vertices.length < 4 ||
      !vertices.every((v) => finiteTuple(v, 3))
    ) {
      return false;
    }
    if (typeof triangles === "undefined") {
      return value.type === "convex";
    }
    if (
      !Array.isArray(triangles) ||
      triangles.length % 3 !== 0 ||
      (value.type === "mesh" && triangles.length === 0) ||
      !triangles.every(
        (v) => Number.isSafeInteger(v) && v >= 0 && v < vertices.length && v <= 0xffffffff,
      )
    ) {
      return false;
    }
    for (let i = 0; i < triangles.length; i += 3) {
      if (new Set(triangles.slice(i, i + 3)).size !== 3) {
        return false;
      }
    }
    return true;
  }
  if (fields.includes("halfspaces")) {
    return (
      Array.isArray(value.halfspaces) &&
      value.halfspaces.length > 0 &&
      value.halfspaces.every((row) => finiteTuple(row, 4) && Math.hypot(...row.slice(0, 3)) > 0)
    );
  }
  for (const field of fields) {
    const key = field.split("[")[0]!;
    const dimension = /\[(\d+)\]/.exec(field);
    const parameter = value[key];
    if (dimension && !finiteTuple(parameter, Number(dimension[1]))) {
      return false;
    }
    const scalars = dimension ? (parameter as number[]) : [parameter];
    if (
      scalars.some(
        (v) =>
          typeof v !== "number" ||
          !Number.isFinite(v) ||
          (value.type === "capsule" && key === "height" ? v < 0 : v <= 0),
      )
    ) {
      return false;
    }
  }
  if (value.type === "ring") {
    const radii = value.radii as [number, number];
    const tube = value.tubeRadius as number;
    return [...radii, tube].every((v) => v >= 1e-6 && v <= 1e4) && tube < Math.min(...radii);
  }
  return true;
}

/** Reject unknown/invalid geometry instead of silently drawing a substitute primitive. */
export function parseSceneEnvelope(value: unknown): SceneEnvelope {
  if (
    !isRecord(value) ||
    typeof value.epoch !== "string" ||
    value.epoch.length === 0 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Number.isSafeInteger(value.savedRevision) ||
    (value.synchronized != undefined && typeof value.synchronized !== "boolean") ||
    typeof value.dirty !== "boolean" ||
    typeof value.playing !== "boolean" ||
    (value.syncRetryable != undefined && typeof value.syncRetryable !== "boolean") ||
    !Number.isFinite(value.sceneTime) ||
    !isRecord(value.document) ||
    value.document.schema !== "xgc2.scene.v1" ||
    typeof value.document.id !== "string" ||
    typeof value.document.frame !== "string" ||
    value.document.frame.length === 0 ||
    !Array.isArray(value.document.obstacles) ||
    !Array.isArray(value.consumers)
  ) {
    throw new Error("Invalid scene document. Check the scene workflow and shared message version.");
  }
  const ids = new Set<string>();
  for (const obstacle of value.document.obstacles) {
    if (
      !isRecord(obstacle) ||
      typeof obstacle.id !== "string" ||
      obstacle.id.length === 0 ||
      ids.has(obstacle.id) ||
      typeof obstacle.name !== "string" ||
      !poseValid(obstacle.pose) ||
      !Array.isArray(obstacle.parts) ||
      obstacle.parts.length === 0 ||
      !motionValid(obstacle.motion)
    ) {
      throw new Error("Invalid obstacle identity, pose or motion in the scene document.");
    }
    ids.add(obstacle.id);
    const partIds = new Set<string>();
    for (const part of obstacle.parts) {
      if (
        !isRecord(part) ||
        typeof part.id !== "string" ||
        part.id.length === 0 ||
        partIds.has(part.id) ||
        !poseValid(part.pose) ||
        !geometryValid(part.geometry) ||
        !finiteTuple(part.color, 4) ||
        part.color.some((v) => v < 0 || v > 1)
      ) {
        throw new Error(
          `Unsupported or invalid geometry in ${obstacle.name}. Check its shape and dimensions.`,
        );
      }
      part.color = [...OBSTACLE_VISUAL_COLOR];
      partIds.add(part.id);
    }
  }
  for (const consumer of value.consumers) {
    if (
      !isRecord(consumer) ||
      typeof consumer.consumer !== "string" ||
      typeof consumer.epoch !== "string" ||
      !Number.isSafeInteger(consumer.revision) ||
      typeof consumer.applied !== "boolean" ||
      typeof consumer.operational !== "boolean" ||
      typeof consumer.capability !== "string" ||
      !["", "ok", "unsupported"].includes(consumer.capability) ||
      (consumer.generation != undefined &&
        (!Number.isSafeInteger(consumer.generation) || (consumer.generation as number) < 0)) ||
      typeof consumer.message !== "string"
    ) {
      throw new Error("Invalid scene synchronization status.");
    }
  }
  const envelope = value as SceneEnvelope;
  return {
    epoch: envelope.epoch,
    revision: envelope.revision,
    savedRevision: envelope.savedRevision,
    dirty: envelope.dirty,
    playing: envelope.playing,
    sceneTime: envelope.sceneTime,
    ...(envelope.synchronized != undefined ? { synchronized: envelope.synchronized } : {}),
    ...(envelope.syncRetryable != undefined ? { syncRetryable: envelope.syncRetryable } : {}),
    document: envelope.document,
    consumers: envelope.consumers.map((consumer) => ({
      consumer: consumer.consumer,
      epoch: consumer.epoch,
      revision: consumer.revision,
      applied: consumer.applied,
      operational: consumer.operational,
      capability: consumer.capability,
      message: consumer.message,
      ...(consumer.generation != undefined ? { generation: consumer.generation } : {}),
    })),
  };
}

export function sceneNamespace(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 160 &&
    /^\/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)
    ? value
    : undefined;
}

/**
 * Per-pane RGBA override for the projected obstacles (the image AR pane uses a
 * translucent variant). Invalid layout values fall back to the document color
 * so a malformed config can never hide the scene.
 */
export function sceneColorOverride(value: unknown): [number, number, number, number] | undefined {
  return finiteTuple(value, 4) && value.every((v) => v >= 0 && v <= 1)
    ? [value[0]!, value[1]!, value[2]!, value[3]!]
    : undefined;
}

export function initialPose(position: Vec3 = [0, 0, 0]): ScenePose {
  return { position, orientation: [0, 0, 0, 1] };
}
