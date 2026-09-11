// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutData } from "@lichtblick/suite-base/context/CurrentLayoutContext";
import { PanelConfig, SavedProps } from "@lichtblick/suite-base/types/panels";
import { getPanelTypeFromId } from "@lichtblick/suite-base/util/layout";

const URDF_LAYER_PREFIX = "xgc2-urdf-";

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

function mergeManagedRecord(incoming: unknown, authority: unknown): Record<string, unknown> | undefined {
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

function mergeUrdfLayers(incoming: unknown, authority: unknown): Record<string, unknown> | undefined {
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

function restoreImageMode(incoming: unknown, authority: unknown): Record<string, unknown> | undefined {
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
    if (authority.transforms !== undefined) {
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

function overlayParkedCameraState(managed: Record<string, unknown>, parked?: LayoutData): Record<string, unknown> {
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
export function mergeManagedLayoutFromUrl(managed: unknown, parked?: LayoutData): unknown {
  if (!isRecord(managed) || !isRecord(managed.configById)) {
    return managed;
  }
  return sanitizeImportedLayoutData(overlayParkedCameraState(managed, parked), managed as LayoutData);
}
