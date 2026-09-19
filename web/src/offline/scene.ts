// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { assetPath, nanos, record, requireValue, type Asset } from "./validation";

export type TrackBase = {
  id: string;
  label: string;
  enabled?: boolean;
  span: { startNs: string; endNs: string };
  animation: {
    fadeInNs: string;
    fadeOutNs: string;
    easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
  };
};
export type Selector =
  | { kind: "topic"; topic: string }
  | { kind: "marker"; topic: string; namespace: string; id: number };
export type Track =
  | (TrackBase & {
      kind: "path";
      selector: { kind: "topic"; topic: string };
      style: { color: string; opacity: number; widthMeters: number };
    })
  | (TrackBase & {
      kind: "markers";
      selector: Selector;
      style: {
        color?: string;
        opacity: number;
        scale: number;
        presentation: "recorded" | "solid" | "wireframe";
      };
    })
  | (TrackBase & {
      kind: "robot-model";
      source: { modelId: string; frameId: string; bundleSha256?: string };
      style: { color?: string; opacity: number; scale: number };
    });
export type FrozenModel = {
  trackId: string;
  modelId: string;
  frameId: string;
  framePrefix: string;
  asset: Asset;
  bundleSha256?: string;
  provenance?: "operator-selected-controlled";
  jointPose?: "urdf-rest";
  resources?: { uri: string; asset: Asset; mediaType: string }[];
};

/** Pure frame-time evaluation; repeated/held source images still advance edits. */
export function trackOpacity(track: Track, time: bigint): number {
  if (track.enabled === false) {
    return 0;
  }
  const start = nanos(track.span.startNs),
    end = nanos(track.span.endNs);
  if (time < start || time >= end) {
    return 0;
  }
  const ease = (value: number) => {
    switch (track.animation.easing) {
      case "ease-in":
        return value * value;
      case "ease-out":
        return 1 - (1 - value) ** 2;
      case "ease-in-out":
        return value * value * (3 - 2 * value);
      default:
        return value;
    }
  };
  const fadeIn = nanos(track.animation.fadeInNs),
    fadeOut = nanos(track.animation.fadeOutNs);
  const incoming = fadeIn === 0n ? 1 : ease(Math.min(1, Number(time - start) / Number(fadeIn)));
  const outgoing = fadeOut === 0n ? 1 : ease(Math.min(1, Number(end - time) / Number(fadeOut)));
  return track.style.opacity * Math.min(incoming, outgoing);
}
export function activeTrack<T extends Track>(tracks: readonly T[], time: bigint): T | undefined {
  return tracks.find(
    (track) => nanos(track.span.startNs) <= time && time < nanos(track.span.endNs),
  );
}
export function parseTracks(value: unknown): Track[] {
  if (value == undefined) {
    return [];
  }
  requireValue(Array.isArray(value) && value.length <= 256, "Invalid editing tracks");
  for (const track of value) {
    requireValue(
      record(track) && typeof track.id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(track.id),
      "Invalid track ID",
    );
    requireValue(
      record(track.span) && nanos(track.span.endNs) > nanos(track.span.startNs),
      "Invalid track span",
    );
    requireValue(
      track.enabled == undefined || typeof track.enabled === "boolean",
      "Invalid track visibility",
    );
    requireValue(
      record(track.animation) &&
        ["linear", "ease-in", "ease-out", "ease-in-out"].includes(String(track.animation.easing)),
      "Invalid track easing",
    );
    requireValue(
      nanos(track.animation.fadeInNs) + nanos(track.animation.fadeOutNs) <=
        nanos(track.span.endNs) - nanos(track.span.startNs),
      "Invalid fade duration",
    );
    requireValue(
      record(track.style) &&
        typeof track.style.opacity === "number" &&
        Number.isFinite(track.style.opacity) &&
        track.style.opacity >= 0 &&
        track.style.opacity <= 1,
      "Invalid track opacity",
    );
    requireValue(
      track.style.color == undefined ||
        (typeof track.style.color === "string" && /^#[0-9a-fA-F]{6}$/.test(track.style.color)),
      "Invalid track color",
    );
    requireValue(
      ["path", "markers", "robot-model"].includes(String(track.kind)),
      "Unsupported track kind",
    );
    if (track.kind === "robot-model") {
      requireValue(
        record(track.source) &&
          typeof track.source.modelId === "string" &&
          /^[a-z0-9][a-z0-9-]{0,63}$/.test(track.source.modelId) &&
          typeof track.source.frameId === "string" &&
          track.source.frameId.length > 0 &&
          (track.source.bundleSha256 == undefined
            ? track.source.modelId === "mocap-rotor"
            : typeof track.source.bundleSha256 === "string" &&
              /^[a-f0-9]{64}$/.test(track.source.bundleSha256)),
        "Invalid robot model",
      );
    } else {
      requireValue(
        record(track.selector) &&
          typeof track.selector.topic === "string" &&
          ["topic", "marker"].includes(String(track.selector.kind)),
        "Invalid track selector",
      );
    }
  }
  return value as Track[];
}

/** URI suffixes also select native loaders, so they must agree with the frozen asset type. */
export function validFrozenResourceType(uri: string, asset: Asset, mediaType: unknown): boolean {
  switch (mediaType) {
    case "model/vnd.collada+xml":
      return /\.dae$/i.test(uri) && asset.path.endsWith(".dae");
    case "image/png":
      return /\.png$/i.test(uri) && asset.path.endsWith(".png");
    case "image/jpeg":
      // The worker retains source .jpeg URIs but stores JPEG bytes as content-addressed .jpg.
      return /\.jpe?g$/i.test(uri) && asset.path.endsWith(".jpg");
    default:
      return false;
  }
}

/** Every model and resource is bound to one frozen track, never a live package resolver. */
export function parseFrozenModels(value: unknown, tracks: readonly Track[]): FrozenModel[] {
  const models = value ?? [];
  requireValue(Array.isArray(models) && models.length <= 256, "Invalid frozen models");
  const ids = new Set<string>();
  const resources = new Map<string, string>();
  for (const model of models) {
    requireValue(record(model), "Invalid frozen model");
    const track = tracks.find((item) => item.kind === "robot-model" && item.id === model.trackId);
    requireValue(
      track?.kind === "robot-model" &&
        model.modelId === track.source.modelId &&
        model.frameId === track.source.frameId &&
        model.framePrefix === `__xgc_video_${track.id}/` &&
        !ids.has(track.id),
      "Unbound frozen robot model",
    );
    ids.add(track.id);
    assetPath(model.asset as Asset);
    requireValue(
      (model.asset as Asset).path.endsWith(".json") &&
        (model.asset as Asset).size <= 4 * 1024 * 1024,
      "Invalid frozen model description",
    );
    if (model.bundleSha256 == undefined) {
      requireValue(
        model.modelId === "mocap-rotor" &&
          track.source.bundleSha256 == undefined &&
          model.provenance == undefined &&
          model.jointPose == undefined &&
          model.resources == undefined,
        "Missing frozen model bundle",
      );
      continue;
    }
    requireValue(
      typeof model.bundleSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(model.bundleSha256) &&
        (track.source.bundleSha256 == undefined ||
          track.source.bundleSha256 === model.bundleSha256) &&
        model.provenance === "operator-selected-controlled" &&
        model.jointPose === "urdf-rest" &&
        Array.isArray(model.resources) &&
        model.resources.length <= 64,
      "Invalid frozen model bundle",
    );
    const prefix = `https://xgc2.invalid/models/${model.bundleSha256}/`;
    const seen = new Set<string>();
    let size = 0;
    for (const resource of model.resources) {
      requireValue(
        record(resource) && typeof resource.uri === "string" && resource.uri.startsWith(prefix),
        "Invalid model resource URI",
      );
      const relative = resource.uri.slice(prefix.length);
      requireValue(
        relative.length > 0 &&
          relative
            .split("/")
            .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..") &&
          !seen.has(resource.uri),
        "Invalid model resource path",
      );
      seen.add(resource.uri);
      const asset = resource.asset as Asset;
      assetPath(asset);
      requireValue(
        validFrozenResourceType(resource.uri, asset, resource.mediaType) &&
          asset.size <= 32 * 1024 * 1024,
        "Invalid model resource type",
      );
      size += asset.size;
      requireValue(size <= 64 * 1024 * 1024, "Model resource closure exceeds limit");
      const identity = JSON.stringify([asset.path, asset.sha256, asset.size, resource.mediaType]);
      requireValue(typeof identity === "string", "Invalid model resource identity");
      requireValue(
        !resources.has(resource.uri) || resources.get(resource.uri) === identity,
        "Conflicting model resource",
      );
      resources.set(resource.uri, identity);
    }
  }
  requireValue(
    tracks.filter((track) => track.kind === "robot-model").every((track) => ids.has(track.id)),
    "Missing frozen robot model",
  );
  return models as FrozenModel[];
}
