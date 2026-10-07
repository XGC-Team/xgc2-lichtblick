// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export const XGC2_EMBED_CHANNEL = "xgc2.lichtblick.embed";
export const XGC2_EMBED_VERSION = 2;

/**
 * The host page may embed the viewer from a different site (loopback alias for
 * renderer-process isolation). It passes its origin as xgc2ParentOrigin; fall
 * back to the viewer's own origin for the classic same-origin embed.
 */
export function embeddedParentOrigin(): string {
  const param = new URL(window.location.href).searchParams.get("xgc2ParentOrigin");
  if (param) {
    try {
      const origin = new URL(param).origin;
      if (origin !== "null") {
        return origin;
      }
    } catch {
      // Invalid parent origin parameter: keep the same-origin default.
    }
  }
  return window.location.origin;
}

/**
 * Host-driven visibility for the embed: parked/hidden panels keep the iframe
 * alive, so the viewer cannot self-detect; idle the render loop on false and
 * resume on true. The bridge acknowledges by idling; until then the message is
 * safely ignored by older bundles.
 */
export type Xgc2EmbeddedVisibilityMessage = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "xgc2";
  type: "visibility";
  visible: boolean;
};

export function isXgc2EmbeddedVisibilityMessage(
  value: unknown,
): value is Xgc2EmbeddedVisibilityMessage {
  if (typeof value !== "object" || value == undefined || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.channel === XGC2_EMBED_CHANNEL &&
    record.version === XGC2_EMBED_VERSION &&
    record.sender === "xgc2" &&
    record.type === "visibility" &&
    typeof record.visible === "boolean" &&
    Object.keys(record).length === 5
  );
}

/** Window event the bridge re-broadcasts host visibility as; every embedded 3D panel listens. */
export const XGC2_HOST_VISIBILITY_EVENT = "xgc2.lichtblick.host-visibility";
