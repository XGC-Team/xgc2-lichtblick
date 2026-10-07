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
