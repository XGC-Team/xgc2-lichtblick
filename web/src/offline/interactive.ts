// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { requireValue } from "./state";

/** Interactive preview shares the query channel with xgcTfHistorySeconds. */
export const INTERACTIVE_QUERY = "xgcInteractive";

/**
 * The interactive preview mode renders to the visible WebGL canvas and lets
 * the user pan/zoom between host-driven frame requests. It is opt-in through
 * the entry query string; the strict capture path is the default.
 */
export function interactivePreviewEnabled(search: string): boolean {
  return new URLSearchParams(search).get(INTERACTIVE_QUERY) === "1";
}

/**
 * Formal capture requires devicePixelRatio=1 so the 4K readback maps 1:1 to
 * output pixels. Interactive frames are only ever displayed, never captured,
 * so any device pixel ratio is acceptable there.
 */
export function requireCapturePixelRatio(devicePixelRatio: number, interactive: boolean): void {
  requireValue(interactive || devicePixelRatio === 1, "Offline capture requires devicePixelRatio=1");
}

/**
 * A failed frame in strict capture taints the page: the final render's
 * integrity is never relaxed. An interactive scrub frame may fail or time out
 * without tainting; the host decides whether to retry or drop the frame.
 */
export function taintsOnFrameError(interactive: boolean): boolean {
  return !interactive;
}
