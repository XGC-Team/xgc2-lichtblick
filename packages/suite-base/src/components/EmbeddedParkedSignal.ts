// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

/**
 * Parked-embed signal shared between the 3D panel (producer) and live players
 * (consumers). A 3D canvas reports the same converged visibility that drives
 * `IRenderer.setCanvasVisibility` (host visibility AND IntersectionObserver).
 * The embed counts as parked only while at least one canvas is registered and
 * every registered canvas is hidden: any visible canvas wants fresh data, so
 * one visible panel keeps the whole pipeline running.
 *
 * Lives in a module singleton because the player exists outside React and
 * cannot receive the panel's visibility through props or context.
 */

// eslint-disable-next-line @lichtblick/no-boolean-parameters
export type EmbeddedParkedListener = (parked: boolean) => void;

export type EmbeddedCanvasVisibilityReporter = {
  /** Update this canvas's converged visibility. Cheap; recomputes the aggregate. */
  setVisible(visible: boolean): void;
  /** Remove this canvas from the aggregate (panel unmounted). */
  dispose(): void;
};

const canvasVisibilityById = new Map<string, boolean>();
const listeners = new Set<EmbeddedParkedListener>();
let parked = false;

function recompute(): void {
  let next = canvasVisibilityById.size > 0;
  if (next) {
    for (const visible of canvasVisibilityById.values()) {
      if (visible) {
        next = false;
        break;
      }
    }
  }
  if (next === parked) {
    return;
  }
  parked = next;
  for (const listener of listeners) {
    listener(parked);
  }
}

/**
 * Register a 3D canvas. The canvas starts visible, matching the renderer's
 * initial assumption; the panel reports events from there.
 */
export function registerEmbeddedCanvasVisibility(
  canvasId: string,
): EmbeddedCanvasVisibilityReporter {
  canvasVisibilityById.set(canvasId, true);
  recompute();
  let registered = true;
  return {
    // eslint-disable-next-line @lichtblick/no-boolean-parameters
    setVisible(visible: boolean) {
      if (!registered) {
        return;
      }
      canvasVisibilityById.set(canvasId, visible);
      recompute();
    },
    dispose() {
      if (!registered) {
        return;
      }
      registered = false;
      canvasVisibilityById.delete(canvasId);
      recompute();
    },
  };
}

/**
 * Subscribe to parked-state changes. The listener is invoked immediately with
 * the current state so a player constructed while already parked starts parked.
 */
export function subscribeEmbeddedParkedState(listener: EmbeddedParkedListener): () => void {
  listeners.add(listener);
  listener(parked);
  return () => {
    listeners.delete(listener);
  };
}
