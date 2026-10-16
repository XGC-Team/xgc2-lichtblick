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
    }
  | {
      type: "waypoints";
      waypoints: Vec3[];
      velocity: number;
      orientation: boolean;
      angular_velocity: number;
      loop: boolean;
      sin: boolean;
    };
export const SCENE_MODEL_FORMATS = ["sdformat-model", "gltf", "mesh"] as const;
export type SceneModelFormat = (typeof SCENE_MODEL_FORMATS)[number];
/** Author resource pointer. The editor shows the model name, never this file. */
export type SceneModelResource = {
  format: SceneModelFormat;
  file: string;
};
export type SceneModel = {
  name?: string;
  parts?: ScenePart[];
  resource?: SceneModelResource;
};
export type SceneGround =
  | { mode: "default_plane"; z: number }
  | { mode: "none" }
  | { mode: "model"; model: string; pose: ScenePose };
type SceneObstacleBase = {
  id: string;
  name: string;
  pose: ScenePose;
  motion: SceneMotion;
};
/** Inline author parts. This arm has no model id. */
export type SceneInlineObstacle = SceneObstacleBase & {
  parts: ScenePart[];
  model?: never;
};
/** Model reference. Serialized with no parts property at all. */
export type SceneModelObstacle = SceneObstacleBase & {
  model: string;
  parts?: never;
};
export type SceneObstacle = SceneInlineObstacle | SceneModelObstacle;
export type CompiledPart = {
  id: string;
  pose: ScenePose;
  geometryIndex: number;
  color: [number, number, number, number];
};
export type CompiledModel = {
  parts: CompiledPart[];
  resource?: SceneModelResource;
  /** Read-only labels from bakeResource. The viewer does not execute them. */
  unparsed?: readonly string[];
};
export type CompiledObstacle = {
  id: string;
  name: string;
  model: string;
  pose: ScenePose;
  motion: SceneMotion;
};
export type CompiledScene = {
  schema: "xgc2.scene.compiled.v1";
  id: string;
  frame: string;
  ground: SceneGround;
  geometries: SceneGeometry[];
  models: Record<string, CompiledModel>;
  obstacles: CompiledObstacle[];
};
export type SceneDocument = {
  schema: "xgc2.scene.v1";
  id: string;
  frame: string;
  obstacles: SceneObstacle[];
  /** Omitted ground keeps the current default-plane meaning. */
  ground?: SceneGround;
  models?: Record<string, SceneModel>;
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
  /** Read-only compiled.v1 from the same epoch and revision. Absent on older envelopes. */
  compiled?: CompiledScene;
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

/** Source metadata only. Matches document.py; it does not sample a trajectory. */
function waypointMotion(value: Record<string, unknown>): boolean {
  const allowed = [
    "type",
    "waypoints",
    "velocity",
    "orientation",
    "angular_velocity",
    "loop",
    "sin",
  ];
  const waypoints = value.waypoints;
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !Array.isArray(waypoints) ||
    waypoints.length < 2 ||
    waypoints.length > 4096 ||
    !waypoints.every((point) => finiteTuple(point, 3))
  ) {
    return false;
  }
  const velocity = Object.hasOwn(value, "velocity") ? value.velocity : 1;
  const orientation = Object.hasOwn(value, "orientation") ? value.orientation : true;
  const angularVelocity = Object.hasOwn(value, "angular_velocity") ? value.angular_velocity : 0.8;
  const loop = Object.hasOwn(value, "loop") ? value.loop : false;
  const sin = Object.hasOwn(value, "sin") ? value.sin : false;
  if (
    typeof velocity !== "number" ||
    !Number.isFinite(velocity) ||
    velocity < 1e-6 ||
    velocity > 1000 ||
    typeof orientation !== "boolean" ||
    typeof angularVelocity !== "number" ||
    !Number.isFinite(angularVelocity) ||
    angularVelocity < 1e-6 ||
    angularVelocity > 1000 ||
    typeof loop !== "boolean" ||
    typeof sin !== "boolean"
  ) {
    return false;
  }
  value.waypoints = waypoints;
  value.velocity = velocity;
  value.orientation = orientation;
  value.angular_velocity = angularVelocity;
  value.loop = loop;
  value.sin = sin;
  return true;
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
    case "waypoints":
      return waypointMotion(value);
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
      vertices.length < (value.type === "mesh" ? 3 : 4) ||
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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function modelIdValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/\s/.test(value);
}

function colorValid(value: unknown): value is [number, number, number, number] {
  return finiteTuple(value, 4) && value.every((channel) => channel >= 0 && channel <= 1);
}

function resourceValid(value: unknown): value is SceneModelResource {
  return (
    isRecord(value) &&
    exactKeys(value, ["format", "file"]) &&
    (SCENE_MODEL_FORMATS as readonly string[]).includes(String(value.format)) &&
    typeof value.file === "string" &&
    value.file.length > 0
  );
}

/** Human label for a source model. Never the resource file, hash, or schema. */
export function sceneModelLabel(id: string, model: SceneModel | undefined): string {
  const name = model?.name?.trim();
  return name != undefined && name.length > 0 ? name : id;
}

export function isInlineObstacle(obstacle: SceneObstacle): obstacle is SceneInlineObstacle {
  return obstacle.model == undefined;
}

export function inlineObstacle(obstacle: SceneObstacle | undefined): SceneInlineObstacle {
  if (obstacle == undefined || !isInlineObstacle(obstacle)) {
    throw new Error("Expected an inline obstacle.");
  }
  return obstacle;
}

/** One author arm only. A model reference is serialized without a parts property. */
export function authoredObstacle(obstacle: SceneObstacle): SceneObstacle {
  if (isInlineObstacle(obstacle)) {
    return {
      id: obstacle.id,
      name: obstacle.name,
      pose: obstacle.pose,
      motion: obstacle.motion,
      parts: obstacle.parts,
    };
  }
  return {
    id: obstacle.id,
    name: obstacle.name,
    pose: obstacle.pose,
    motion: obstacle.motion,
    model: obstacle.model,
  };
}

function paintPart(part: Record<string, unknown>, label: string, partIds: Set<string>): void {
  if (
    typeof part.id !== "string" ||
    part.id.length === 0 ||
    partIds.has(part.id) ||
    !poseValid(part.pose) ||
    !geometryValid(part.geometry) ||
    !colorValid(part.color)
  ) {
    throw new Error(`Unsupported or invalid geometry in ${label}. Check its shape and dimensions.`);
  }
  part.color = [...OBSTACLE_VISUAL_COLOR];
  partIds.add(part.id);
}

function parseModels(value: unknown): Record<string, SceneModel> | undefined {
  if (value == undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error("Scene models must be a map of analytic parts or one resource.");
  }
  const models: Record<string, SceneModel> = {};
  for (const [id, model] of Object.entries(value)) {
    if (!modelIdValid(id) || !isRecord(model)) {
      throw new Error("Scene models must be a map of analytic parts or one resource.");
    }
    const name = model.name;
    if (name != undefined && (typeof name !== "string" || name.trim().length === 0)) {
      throw new Error(`Model ${id} needs a human name.`);
    }
    const parts = Object.hasOwn(model, "parts");
    const resource = Object.hasOwn(model, "resource");
    if (parts === resource) {
      throw new Error(`Model ${id} is either analytic parts or one resource.`);
    }
    const allowed = ["name", parts ? "parts" : "resource"].filter((key) =>
      Object.hasOwn(model, key),
    );
    if (!exactKeys(model, allowed)) {
      throw new Error(`Model ${id} is either analytic parts or one resource.`);
    }
    if (resource) {
      if (!resourceValid(model.resource)) {
        throw new Error(`Model ${id} resource must be sdformat-model, gltf, or mesh.`);
      }
    } else if (!Array.isArray(model.parts) || model.parts.length === 0) {
      throw new Error(`Model ${id} needs at least one analytic part.`);
    } else {
      const partIds = new Set<string>();
      for (const part of model.parts) {
        if (!isRecord(part)) {
          throw new Error(
            `Unsupported or invalid geometry in ${id}. Check its shape and dimensions.`,
          );
        }
        paintPart(part, id, partIds);
      }
    }
    models[id] = model;
  }
  return models;
}

function parseGround(value: unknown, modelIds: ReadonlySet<string>): SceneGround | undefined {
  if (value == undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("Scene ground must be a default plane, a model, or none.");
  }
  if (
    value.mode === "default_plane" &&
    exactKeys(value, ["mode", "z"]) &&
    typeof value.z === "number" &&
    Number.isFinite(value.z)
  ) {
    return { mode: "default_plane", z: value.z };
  }
  if (value.mode === "none" && exactKeys(value, ["mode"])) {
    return { mode: "none" };
  }
  if (
    value.mode === "model" &&
    exactKeys(value, ["mode", "model", "pose"]) &&
    modelIdValid(value.model) &&
    modelIds.has(value.model) &&
    poseValid(value.pose)
  ) {
    return { mode: "model", model: value.model, pose: value.pose };
  }
  throw new Error("Scene ground must be a default plane, a model, or none.");
}

function parseCompiled(value: unknown, document: SceneDocument): CompiledScene | undefined {
  if (value == undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schema", "id", "frame", "ground", "geometries", "models", "obstacles"]) ||
    value.schema !== "xgc2.scene.compiled.v1" ||
    value.id !== document.id ||
    value.frame !== document.frame ||
    !Array.isArray(value.geometries) ||
    !value.geometries.every((geometry) => geometryValid(geometry)) ||
    !isRecord(value.models) ||
    !Array.isArray(value.obstacles)
  ) {
    throw new Error("Invalid compiled scene. It must be read-only compiled.v1 for this document.");
  }
  const models: Record<string, CompiledModel> = {};
  for (const [id, model] of Object.entries(value.models)) {
    if (!modelIdValid(id) || !isRecord(model) || !Array.isArray(model.parts)) {
      throw new Error("Invalid compiled model.");
    }
    const keys = Object.keys(model);
    if (keys.some((key) => key !== "parts" && key !== "resource" && key !== "unparsed")) {
      throw new Error("Invalid compiled model.");
    }
    if (Object.hasOwn(model, "resource") && !resourceValid(model.resource)) {
      throw new Error("Invalid compiled model resource.");
    }
    if (Object.hasOwn(model, "unparsed")) {
      if (!Array.isArray(model.unparsed)) {
        throw new Error("Invalid compiled model.");
      }
      const notes = model.unparsed.filter((note): note is string => typeof note === "string");
      if (notes.length !== model.unparsed.length) {
        throw new Error("Invalid compiled model.");
      }
      model.unparsed = notes;
    }
    const partIds = new Set<string>();
    for (const part of model.parts) {
      if (
        !isRecord(part) ||
        !exactKeys(part, ["id", "pose", "geometryIndex", "color"]) ||
        typeof part.id !== "string" ||
        part.id.length === 0 ||
        partIds.has(part.id) ||
        !poseValid(part.pose) ||
        !Number.isSafeInteger(part.geometryIndex) ||
        (part.geometryIndex as number) < 0 ||
        (part.geometryIndex as number) >= value.geometries.length ||
        !colorValid(part.color)
      ) {
        throw new Error(`Invalid compiled part in model ${id}.`);
      }
      partIds.add(part.id);
    }
    models[id] = model as CompiledModel;
  }
  const ground = parseGround(value.ground, new Set(Object.keys(models)));
  if (!ground) {
    throw new Error("Compiled scene ground must be explicit.");
  }
  const ids = new Set<string>();
  for (const obstacle of value.obstacles) {
    if (
      !isRecord(obstacle) ||
      !exactKeys(obstacle, ["id", "name", "model", "pose", "motion"]) ||
      typeof obstacle.id !== "string" ||
      obstacle.id.length === 0 ||
      ids.has(obstacle.id) ||
      typeof obstacle.name !== "string" ||
      !modelIdValid(obstacle.model) ||
      models[obstacle.model] == undefined ||
      !poseValid(obstacle.pose) ||
      !motionValid(obstacle.motion)
    ) {
      throw new Error("Compiled obstacles are model references with a rigid pose.");
    }
    ids.add(obstacle.id);
  }
  for (const obstacle of document.obstacles) {
    if (obstacle.model != undefined && models[obstacle.model] == undefined) {
      throw new Error(`Compiled scene is missing model ${obstacle.model}.`);
    }
  }
  return {
    schema: "xgc2.scene.compiled.v1",
    id: document.id,
    frame: document.frame,
    ground,
    geometries: value.geometries,
    models,
    obstacles: value.obstacles as CompiledObstacle[],
  };
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
    !Array.isArray(value.consumers) ||
    Object.hasOwn(value.document, "terrain")
  ) {
    throw new Error("Invalid scene document. Check the scene workflow and shared message version.");
  }
  const models = parseModels(value.document.models);
  if (models) {
    value.document.models = models;
  }
  const ground = parseGround(value.document.ground, new Set(Object.keys(models ?? {})));
  if (ground) {
    value.document.ground = ground;
  } else {
    delete value.document.ground;
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
      !motionValid(obstacle.motion)
    ) {
      throw new Error("Invalid obstacle identity, pose or motion in the scene document.");
    }
    const hasParts = Object.hasOwn(obstacle, "parts");
    const hasModel = Object.hasOwn(obstacle, "model");
    if (hasParts && hasModel) {
      throw new Error("An obstacle uses inline parts or a model reference, not both.");
    }
    ids.add(obstacle.id);
    if (hasModel) {
      if (!modelIdValid(obstacle.model) || models?.[obstacle.model] == undefined) {
        throw new Error(`Obstacle ${obstacle.name} references an unknown model.`);
      }
      delete obstacle.parts;
      continue;
    }
    const inlineParts = obstacle.parts;
    if (!Array.isArray(inlineParts) || inlineParts.length === 0) {
      throw new Error("Invalid obstacle identity, pose or motion in the scene document.");
    }
    const partIds = new Set<string>();
    for (const part of inlineParts) {
      if (!isRecord(part)) {
        throw new Error(
          `Unsupported or invalid geometry in ${obstacle.name}. Check its shape and dimensions.`,
        );
      }
      paintPart(part, String(obstacle.name), partIds);
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
  const compiled = parseCompiled(value.compiled, envelope.document);
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
    ...(compiled ? { compiled } : {}),
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
