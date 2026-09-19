// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { nanos, record, requireValue, type Asset } from "./state";

export type TrackBase = {
  id: string;
  label: string;
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
      source: { modelId: "mocap-rotor"; frameId: string };
      style: { color?: string; opacity: number; scale: number };
    });
export type FrozenModel = {
  trackId: string;
  modelId: string;
  frameId: string;
  framePrefix: string;
  asset: Asset;
};

/** Pure frame-time evaluation; repeated/held source images still advance edits. */
export function trackOpacity(track: Track, time: bigint): number {
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
          track.source.modelId === "mocap-rotor" &&
          typeof track.source.frameId === "string",
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
