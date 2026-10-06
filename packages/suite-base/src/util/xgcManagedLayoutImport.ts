// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutData } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { PanelConfig, SavedProps } from "@lichtblick/suite-base/types/panels";
import { getPanelTypeFromId } from "@lichtblick/suite-base/util/layout";

const URDF_LAYER_PREFIX = "xgc2-urdf-";

export type Xgc2LayoutScope = readonly [experimentId: string, panelId: string];

export function parseXgc2LayoutScope(raw: string | null): Xgc2LayoutScope | undefined {
  if (raw == undefined) {
    return undefined;
  }
  try {
    const scope: unknown = JSON.parse(raw);
    return Array.isArray(scope) &&
      scope.length === 2 &&
      scope.every((id) => typeof id === "string" && id.trim().length > 0)
      ? [scope[0] as string, scope[1] as string]
      : undefined;
  } catch {
    return undefined;
  }
}

export function layoutHasXgc2Scope(data: LayoutData | undefined, scope: Xgc2LayoutScope): boolean {
  const saved: unknown = data?.metadata?.xgc2LayoutScope;
  return (
    Array.isArray(saved) && saved.length === 2 && saved[0] === scope[0] && saved[1] === scope[1]
  );
}

function declaredRobotFrame(config: Record<string, unknown>, frameId: unknown): frameId is string {
  return (
    typeof frameId === "string" &&
    isRecord(config.layers) &&
    Object.entries(config.layers).some(
      ([id, layer]) =>
        id.startsWith(URDF_LAYER_PREFIX) &&
        isRecord(layer) &&
        layer.layerId === "foxglove.Urdf" &&
        typeof layer.framePrefix === "string" &&
        layer.framePrefix.length > 0 &&
        frameId.startsWith(layer.framePrefix) &&
        frameId.length > layer.framePrefix.length,
    )
  );
}

/** Restore only view fields from the same Experiment and exact native pane. */
function restoreScopedView(
  managed: Record<string, unknown>,
  parked: LayoutData | undefined,
  scope: Xgc2LayoutScope,
): unknown {
  const previous = layoutHasXgc2Scope(parked, scope) ? parked : undefined;
  const next: SavedProps = {};
  if (!isRecord(managed.configById)) {
    return managed;
  }
  for (const [id, config] of Object.entries(managed.configById)) {
    const saved = previous?.configById[id];
    if (
      !isRecord(config) ||
      !isRecord(saved) ||
      !["3D", "Image"].includes(getPanelTypeFromId(id))
    ) {
      next[id] = config as PanelConfig;
      continue;
    }
    const isFollow = saved.followMode === "follow-position" || saved.followMode === "follow-pose";
    if (
      getPanelTypeFromId(id) === "3D" &&
      isFollow &&
      !declaredRobotFrame(config, saved.followTf)
    ) {
      // The current Core roster removed this robot. Use its current Overview, including camera.
      next[id] = { ...config, followMode: "follow-none" };
      continue;
    }
    next[id] = {
      ...config,
      ...(isRecord(saved.cameraState) ? { cameraState: saved.cameraState } : {}),
      ...(getPanelTypeFromId(id) === "3D" && isFollow
        ? { followMode: "follow-position", followTf: saved.followTf }
        : getPanelTypeFromId(id) === "3D" && saved.followMode === "follow-none"
          ? { followMode: "follow-none" }
          : {}),
    };
  }
  return {
    ...managed,
    configById: next,
    metadata: {
      ...(isRecord(managed.metadata) ? managed.metadata : {}),
      xgc2LayoutScope: [...scope],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function firstConfigOfType(configs: SavedProps | undefined, type: string): PanelConfig | undefined {
  if (configs == undefined) {
    return undefined;
  }
  for (const [id, config] of Object.entries(configs)) {
    if (getPanelTypeFromId(id) === type) {
      return config;
    }
  }
  return undefined;
}

function mergeManagedRecord(
  incoming: unknown,
  authority: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(authority)) {
    return isRecord(incoming) ? { ...incoming } : undefined;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(authority)) {
    const overlay = isRecord(incoming) ? incoming[key] : undefined;
    next[key] = isRecord(value) && isRecord(overlay) ? { ...value, ...overlay } : value;
  }
  return next;
}

function restoreScene(incoming: unknown, authority: unknown): Record<string, unknown> {
  const next = isRecord(incoming) ? { ...incoming } : {};
  if (!isRecord(authority)) {
    return next;
  }
  if (Object.hasOwn(authority, "obstacleScene")) {
    next.obstacleScene = authority.obstacleScene;
  } else {
    delete next.obstacleScene;
  }
  return next;
}

function mergeUrdfLayers(
  incoming: unknown,
  authority: unknown,
): Record<string, unknown> | undefined {
  const next = isRecord(incoming) ? { ...incoming } : {};
  for (const key of Object.keys(next)) {
    if (key.startsWith(URDF_LAYER_PREFIX)) {
      delete next[key];
    }
  }
  if (isRecord(authority)) {
    for (const [key, value] of Object.entries(authority)) {
      if (key.startsWith(URDF_LAYER_PREFIX)) {
        next[key] = value;
      }
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function restoreImageMode(
  incoming: unknown,
  authority: unknown,
): Record<string, unknown> | undefined {
  const next = isRecord(incoming) ? { ...incoming } : {};
  if (isRecord(authority)) {
    if (typeof authority.imageTopic === "string") {
      next.imageTopic = authority.imageTopic;
    }
    if (typeof authority.calibrationTopic === "string") {
      next.calibrationTopic = authority.calibrationTopic;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeThreeD(incoming: Record<string, unknown>, authority?: PanelConfig): PanelConfig {
  const next: Record<string, unknown> = { ...incoming };
  if (isRecord(authority)) {
    const topics = mergeManagedRecord(incoming.topics, authority.topics);
    if (topics) {
      next.topics = topics;
    }
    if (typeof authority.followTf === "string" && authority.followTf.length > 0) {
      next.followTf = authority.followTf;
    }
    if (typeof authority.followMode === "string" && authority.followMode.length > 0) {
      next.followMode = authority.followMode;
    }
    // Preserve explicit null from the authority; only an absent value leaves the import intact.
    if (typeof authority.transforms !== "undefined") {
      next.transforms = authority.transforms;
    }
    next.scene = restoreScene(incoming.scene, authority.scene);
    const layers = mergeUrdfLayers(incoming.layers, authority.layers);
    if (layers) {
      next.layers = layers;
    } else {
      delete next.layers;
    }
  }
  if (Object.hasOwn(incoming, "cameraState")) {
    next.cameraState = incoming.cameraState;
  }
  return next;
}

function sanitizeImage(incoming: Record<string, unknown>, authority?: PanelConfig): PanelConfig {
  const next: Record<string, unknown> = { ...incoming };
  if (isRecord(authority)) {
    const topics = mergeManagedRecord(incoming.topics, authority.topics);
    if (topics) {
      next.topics = topics;
    }
    const imageMode = restoreImageMode(incoming.imageMode, authority.imageMode);
    if (imageMode) {
      next.imageMode = imageMode;
    }
    const layers = mergeUrdfLayers(incoming.layers, authority.layers);
    if (layers) {
      next.layers = layers;
    } else {
      delete next.layers;
    }
  }
  if (Object.hasOwn(incoming, "cameraState")) {
    next.cameraState = incoming.cameraState;
  }
  return next;
}

export function sanitizeImportedPanelConfig(
  incoming: unknown,
  authority: PanelConfig | undefined,
  panelType: string,
): PanelConfig {
  if (!isRecord(incoming)) {
    return isRecord(authority) ? { ...authority } : {};
  }
  if (panelType === "3D") {
    return sanitizeThreeD(incoming, authority);
  }
  if (panelType === "Image") {
    return sanitizeImage(incoming, authority);
  }
  return { ...incoming };
}

export function sanitizeImportedLayoutData(incoming: unknown, authority?: LayoutData): unknown {
  if (!isRecord(incoming) || !isRecord(incoming.configById)) {
    return incoming;
  }
  const configById: SavedProps = {};
  for (const [id, config] of Object.entries(incoming.configById)) {
    const type = getPanelTypeFromId(id);
    const baseline =
      (authority?.configById != undefined && isRecord(authority.configById[id])
        ? authority.configById[id]
        : undefined) ?? firstConfigOfType(authority?.configById, type);
    configById[id] = sanitizeImportedPanelConfig(config, baseline, type);
  }
  return { ...incoming, configById };
}

function overlayParkedCameraState(
  managed: Record<string, unknown>,
  parked?: LayoutData,
): Record<string, unknown> {
  const configs = managed.configById;
  if (!isRecord(configs)) {
    return managed;
  }
  const next: SavedProps = {};
  for (const [id, config] of Object.entries(configs)) {
    if (!isRecord(config)) {
      next[id] = config as PanelConfig;
      continue;
    }
    const parkedConfig =
      (parked?.configById != undefined && isRecord(parked.configById[id])
        ? parked.configById[id]
        : undefined) ?? firstConfigOfType(parked?.configById, getPanelTypeFromId(id));
    next[id] =
      isRecord(parkedConfig) && Object.hasOwn(parkedConfig, "cameraState")
        ? { ...config, cameraState: parkedConfig.cameraState }
        : { ...config };
  }
  return { ...managed, configById: next };
}

/** Core layoutUrl JSON is the managed authority. Parked IndexedDB layout may keep cameraState. */
export function mergeManagedLayoutFromUrl(
  managed: unknown,
  parked?: LayoutData,
  scope?: Xgc2LayoutScope,
): unknown {
  if (!isRecord(managed) || !isRecord(managed.configById)) {
    return managed;
  }
  if (scope) {
    return restoreScopedView(managed, parked, scope);
  }
  return sanitizeImportedLayoutData(
    overlayParkedCameraState(managed, parked),
    managed as LayoutData,
  );
}
