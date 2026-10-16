// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { XGC2_HOST_VISIBILITY_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceProtocol";

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
 *
 * Host visibility is retained here, not in the player or a panel module. The
 * bridge validates parent origin and source, then rebroadcasts one window
 * event. This module listens to that event once per document so a 3D panel
 * that mounts after the ready handshake still sees the current embedded
 * visibility. The retained value does not park the player by itself and is
 * not a standalone message gate.
 */

// eslint-disable-next-line @lichtblick/no-boolean-parameters
export type EmbeddedParkedListener = (parked: boolean) => void;

/** Same vocabulary as the renderer canvas: visible or hidden. */
export type EmbeddedCanvasVisibility = "visible" | "hidden";

export type EmbeddedCanvasVisibilityReporter = {
  /** Update this canvas's converged visibility. Cheap; recomputes the aggregate. */
  setVisible(visible: boolean): void;
  /** Remove this canvas from the aggregate (panel unmounted). */
  dispose(): void;
};

const canvasVisibilityById = new Map<string, boolean>();
const listeners = new Set<EmbeddedParkedListener>();
let parked = false;

// eslint-disable-next-line @lichtblick/no-boolean-parameters
export type EmbeddedHostVisibilityListener = (visible: boolean) => void;

const hostVisibilityListeners = new Set<EmbeddedHostVisibilityListener>();
let hostVisibilityInstalled = false;
/** Undefined until the bridge has rebroadcast a host visibility message. */
let embeddedHostVisible: boolean | undefined;

function rememberHostVisibility(event: Event): void {
  const detail = (event as CustomEvent<{ visible?: unknown } | null>).detail;
  if (typeof detail?.visible !== "boolean") {
    return;
  }
  embeddedHostVisible = detail.visible;
  for (const listener of hostVisibilityListeners) {
    listener(detail.visible);
  }
}

function installEmbeddedHostVisibilityListener(): void {
  if (hostVisibilityInstalled || typeof window === "undefined") {
    return;
  }
  hostVisibilityInstalled = true;
  window.addEventListener(XGC2_HOST_VISIBILITY_EVENT, rememberHostVisibility);
}

installEmbeddedHostVisibilityListener();

/** Latest host visibility rebroadcast by the bridge. Not a parked-state signal. */
export function lastEmbeddedHostVisibility(): boolean | undefined {
  return embeddedHostVisible;
}

/**
 * Subsequent host visibility events only. Does not replay the retained value,
 * so a standalone panel that subscribes for live drawing updates does not
 * inherit a message that arrived before it existed.
 */
export function subscribeEmbeddedHostVisibility(
  listener: EmbeddedHostVisibilityListener,
): () => void {
  hostVisibilityListeners.add(listener);
  return () => {
    hostVisibilityListeners.delete(listener);
  };
}

/** Test isolation. Does not remove the document listener. */
export function resetEmbeddedHostVisibilityForTests(): void {
  embeddedHostVisible = undefined;
}

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
 * Register a 3D canvas. The initial value is written before the aggregate
 * recomputes, so a canvas that is already hidden does not appear visible for
 * one notification and unpark the player. Default remains visible, matching
 * the renderer before any host or intersection report.
 */
export function registerEmbeddedCanvasVisibility(
  canvasId: string,
  initialVisibility: EmbeddedCanvasVisibility = "visible",
): EmbeddedCanvasVisibilityReporter {
  canvasVisibilityById.set(canvasId, initialVisibility === "visible");
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
