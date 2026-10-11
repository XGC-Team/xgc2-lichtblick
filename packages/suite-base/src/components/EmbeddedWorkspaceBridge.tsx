// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Logger from "@lichtblick/log";
import {
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
  type LayoutID,
  type LayoutState,
} from "@lichtblick/suite-base/context/CurrentLayoutContext";
import {
  useEmbeddedWorkspaceControls,
  type EmbeddedHostTheme,
} from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { useLayoutManager } from "@lichtblick/suite-base/context/LayoutManagerContext";
import { useWorkspaceStore } from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import { useWorkspaceActions } from "@lichtblick/suite-base/context/Workspace/useWorkspaceActions";

import {
  connectDesiredView,
  planDesiredView,
  viewFields,
  type DesiredViewState,
  type ObservedView,
  type ViewField,
  type ViewStep,
} from "./EmbeddedDesiredView";
import { embeddedSceneBridge } from "./EmbeddedSceneBridge";
import { embeddedViewCapture } from "./EmbeddedViewCapture";
import {
  XGC2_EMBED_CHANNEL,
  XGC2_EMBED_SURFACES,
  XGC2_EMBED_VERSION,
  XGC2_HOST_VISIBILITY_EVENT,
  XGC2_NAVIGATION_STATE_EVENT,
  embeddedParentOrigin,
  isXgc2EmbeddedNavigationState,
  isXgc2EmbeddedVisibilityMessage,
  type Xgc2EmbeddedNavigationState,
  type Xgc2EmbeddedSurface,
} from "./EmbeddedWorkspaceProtocol";

const log = Logger.getLogger(__filename);

export {
  XGC2_EMBED_CHANNEL,
  XGC2_EMBED_SURFACES,
  XGC2_EMBED_VERSION,
  XGC2_HOST_VISIBILITY_EVENT,
  embeddedParentOrigin,
  publishNavigationState,
} from "./EmbeddedWorkspaceProtocol";
export type { Xgc2EmbeddedSurface } from "./EmbeddedWorkspaceProtocol";
export type Xgc2EmbeddedHostCommand = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "xgc2";
  type: "toggle-surface";
  surface: Xgc2EmbeddedSurface;
};

export type Xgc2EmbeddedReadyMessage = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "lichtblick";
  type: "ready";
  capabilities: readonly Xgc2EmbeddedSurface[];
  visibleSurfaces: readonly Xgc2EmbeddedSurface[];
};

export type EmbeddedThemeCommand = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "xgc2";
  type: "theme";
} & EmbeddedHostTheme;

export function isEmbeddedThemeCommand(value: unknown): value is EmbeddedThemeCommand {
  const keys = ["channel", "version", "sender", "type", "colorScheme", "backgroundColor"];
  return (
    isPlainObject(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    value.channel === XGC2_EMBED_CHANNEL &&
    value.version === XGC2_EMBED_VERSION &&
    value.sender === "xgc2" &&
    value.type === "theme" &&
    (value.colorScheme === "dark" || value.colorScheme === "light") &&
    typeof value.backgroundColor === "string" &&
    /^#[\da-f]{6}$/i.test(value.backgroundColor)
  );
}

// Navigation remains on this authenticated embed channel and names one native panel.
export const EMBEDDED_NAVIGATION_EVENT = "xgc2.lichtblick.native-navigation";
export const EMBEDDED_3D_PANEL_ATTRIBUTE = "data-xgc-native-3d-panel-id";
export type EmbeddedNavigationCommand = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "xgc2";
  type: "navigation";
  panelId: string;
} & (
  | { action: "goal" | "overview" | "robot-frames" | "perspective" }
  | { action: "follow" | "follow-pose"; frameId: string }
);

export function isEmbeddedNavigationCommand(value: unknown): value is EmbeddedNavigationCommand {
  if (
    !isPlainObject(value) ||
    value.channel !== XGC2_EMBED_CHANNEL ||
    value.version !== XGC2_EMBED_VERSION ||
    value.sender !== "xgc2" ||
    value.type !== "navigation" ||
    typeof value.panelId !== "string" ||
    !value.panelId
  ) {
    return false;
  }
  const keys = ["channel", "version", "sender", "type", "panelId", "action"];
  if (value.action === "follow" || value.action === "follow-pose") {
    keys.push("frameId");
    if (typeof value.frameId !== "string" || !value.frameId) {
      return false;
    }
  } else if (!["goal", "overview", "robot-frames", "perspective"].includes(String(value.action))) {
    return false;
  }
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

/** Delivers a navigation command to the one native panel it names; duplicate or unknown identities are unavailable, never broadcast to all renderers. */
function dispatchEmbeddedNavigation(command: EmbeddedNavigationCommand): void {
  const targets = [
    ...document.querySelectorAll<HTMLElement>(`[${EMBEDDED_3D_PANEL_ATTRIBUTE}]`),
  ].filter((element) => element.getAttribute(EMBEDDED_3D_PANEL_ATTRIBUTE) === command.panelId);
  if (targets.length === 1) {
    targets[0]!.dispatchEvent(new CustomEvent(EMBEDDED_NAVIGATION_EVENT, { detail: command }));
  }
}

const HOST_COMMAND_KEYS = ["channel", "version", "sender", "type", "surface"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype == null;
}

function hasOnlyHostCommandKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === HOST_COMMAND_KEYS.length &&
    keys.every((key) => (HOST_COMMAND_KEYS as readonly string[]).includes(key))
  );
}

export function isXgc2EmbeddedHostCommand(value: unknown): value is Xgc2EmbeddedHostCommand {
  return (
    isPlainObject(value) &&
    hasOnlyHostCommandKeys(value) &&
    value.channel === XGC2_EMBED_CHANNEL &&
    value.version === XGC2_EMBED_VERSION &&
    value.sender === "xgc2" &&
    value.type === "toggle-surface" &&
    typeof value.surface === "string" &&
    (XGC2_EMBED_SURFACES as readonly string[]).includes(value.surface)
  );
}

const selectedLayoutIdSelector = (state: LayoutState) => state.selectedLayout?.id;

/**
 * Applies the desired view that the launcher streams to this page. Each revision is applied
 * once: the layout is selected, the surfaces are shown, and the follow and perspective choices
 * are sent to the one navigable 3D panel as soon as it exists, which may be after a layout
 * switch. Once a field shows its desired value it is left to the operator.
 */
function useEmbeddedDesiredView(
  visibleSurfaces: readonly Xgc2EmbeddedSurface[],
  toggleSurface: (surface: Xgc2EmbeddedSurface) => void,
): void {
  const layoutManager = useLayoutManager();
  const { setSelectedLayoutId } = useCurrentLayoutActions();
  const layoutId = useCurrentLayoutSelector(selectedLayoutIdSelector);
  const [desired, setDesired] = useState<DesiredViewState>();
  const [panels, setPanels] = useState<ReadonlyMap<string, Xgc2EmbeddedNavigationState>>(
    new Map(),
  );
  // The revision whose layout does not exist; the rest of that view is applied to the current one.
  const [missingLayoutRevision, setMissingLayoutRevision] = useState<string>();
  const progress = useRef<{ revision: string; pending: Set<ViewField> }>();

  useEffect(
    () =>
      connectDesiredView((state) => {
        setDesired((current) => (current?.revision === state.revision ? current : state));
      }),
    [],
  );

  useEffect(() => {
    const handleNavigationState = (event: Event) => {
      const state = (event as CustomEvent<unknown>).detail;
      if (!isXgc2EmbeddedNavigationState(state)) {
        return;
      }
      setPanels((current) => {
        const known = current.get(state.panelId);
        return known?.available === state.available &&
          known.perspective === state.perspective &&
          known.followFrameId === state.followFrameId
          ? current
          : new Map(current).set(state.panelId, state);
      });
    };
    window.addEventListener(XGC2_NAVIGATION_STATE_EVENT, handleNavigationState);
    return () => {
      window.removeEventListener(XGC2_NAVIGATION_STATE_EVENT, handleNavigationState);
    };
  }, []);

  const panel = useMemo(() => {
    const available = [...panels.values()].filter((state) => state.available);
    return available.length === 1
      ? {
          panelId: available[0]!.panelId,
          perspective: available[0]!.perspective,
          followFrameId: available[0]!.followFrameId,
        }
      : undefined;
  }, [panels]);

  useEffect(() => {
    if (!desired) {
      return;
    }
    const { revision, view } = desired;
    if (progress.current?.revision !== revision) {
      progress.current = { revision, pending: viewFields(view) };
    }
    const current = progress.current;
    if (current.pending.size === 0) {
      return;
    }

    const selectLayout = async (id: string): Promise<void> => {
      try {
        if ((await layoutManager.getLayout(id as LayoutID)) != undefined) {
          setSelectedLayoutId(id as LayoutID);
          return;
        }
        log.warn(`The desired view names a layout that does not exist: ${id}`);
      } catch (error) {
        log.warn(`The desired layout could not be selected: ${String(error)}`);
      }
      setMissingLayoutRevision(revision);
    };
    const applyStep = (step: ViewStep): void => {
      switch (step.type) {
        case "layout":
          void selectLayout(step.layoutId);
          break;
        case "surface":
          toggleSurface(step.surface);
          break;
        case "follow":
        case "perspective":
          dispatchEmbeddedNavigation({
            channel: XGC2_EMBED_CHANNEL,
            version: XGC2_EMBED_VERSION,
            sender: "xgc2",
            type: "navigation",
            panelId: step.panelId,
            ...(step.type === "follow"
              ? { action: "follow", frameId: step.frameId }
              : { action: "perspective" }),
          });
          break;
      }
    };

    const observed: ObservedView = { layoutId, visibleSurfaces, panel };
    const layoutSettled =
      view.layoutId == undefined || layoutId === view.layoutId || missingLayoutRevision === revision;
    const plan = planDesiredView(view, observed, current.pending, { layoutSettled });
    current.pending = plan.pending;
    plan.steps.forEach(applyStep);
  }, [
    desired,
    layoutId,
    layoutManager,
    missingLayoutRevision,
    panel,
    setSelectedLayoutId,
    toggleSurface,
    visibleSurfaces,
  ]);
}

/**
 * Exposes the small, versioned command surface used by the XGC2 embed host.
 * The host may live on a different site (loopback alias) so the viewer gets an
 * isolated renderer process; the expected parent origin comes from the embed
 * URL rather than assuming the viewer's own origin.
 *
 * This component must only be mounted by an embedded Workspace. The source and origin checks keep
 * messages from other frames and windows from driving Workspace UI.
 */
export default function EmbeddedWorkspaceBridge(): null {
  const { sidebarActions } = useWorkspaceActions();
  const {
    panelControlsVisible,
    threeDToolsVisible,
    obstacleSceneVisible,
    toggleObstacleScene,
    togglePanelControls,
    toggleThreeDTools,
    setHostTheme,
  } = useEmbeddedWorkspaceControls();

  // Only which sidebar item is open matters to the host. Selecting the whole `sidebars` object also
  // tracked their sizes, so dragging a sidebar splitter re-sent `ready` on every pointer move and the
  // host re-rendered its frame and re-posted the scene binding each time.
  const leftItem = useWorkspaceStore((store) =>
    store.sidebars.left.open ? store.sidebars.left.item : undefined,
  );
  const rightItem = useWorkspaceStore((store) =>
    store.sidebars.right.open ? store.sidebars.right.item : undefined,
  );

  const visibleSurfaces = useMemo(
    () =>
      XGC2_EMBED_SURFACES.filter((surface) =>
        surface === "panel-controls"
          ? panelControlsVisible
          : surface === "obstacle-scene"
            ? obstacleSceneVisible
            : surface === "3d-tools"
              ? threeDToolsVisible
              : leftItem === surface || rightItem === surface,
      ),
    [leftItem, obstacleSceneVisible, panelControlsVisible, rightItem, threeDToolsVisible],
  );

  const toggleSurface = useCallback(
    (surface: Xgc2EmbeddedSurface) => {
      switch (surface) {
        case "panel-settings":
        case "alerts":
        case "topics":
        case "layouts":
          sidebarActions.left.selectItem(leftItem === surface ? undefined : surface);
          break;
        case "variables":
          sidebarActions.right.selectItem(rightItem === surface ? undefined : surface);
          break;
        case "panel-controls":
          togglePanelControls();
          break;
        case "obstacle-scene":
          toggleObstacleScene();
          break;
        case "3d-tools":
          toggleThreeDTools();
          break;
      }
    },
    [
      leftItem,
      rightItem,
      sidebarActions,
      toggleObstacleScene,
      togglePanelControls,
      toggleThreeDTools,
    ],
  );

  useEmbeddedDesiredView(visibleSurfaces, toggleSurface);

  useEffect(() => embeddedSceneBridge.connect(window.parent, embeddedParentOrigin()), []);
  useEffect(() => embeddedViewCapture.connect(window.parent, embeddedParentOrigin()), []);

  useEffect(() => {
    const parentWindow = window.parent;
    const expectedOrigin = embeddedParentOrigin();

    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== expectedOrigin || event.source !== parentWindow) {
        return;
      }

      if (isXgc2EmbeddedVisibilityMessage(event.data)) {
        window.dispatchEvent(
          new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: event.data.visible } }),
        );
        return;
      }

      if (isEmbeddedThemeCommand(event.data)) {
        const { colorScheme, backgroundColor } = event.data;
        setHostTheme({ colorScheme, backgroundColor });
        return;
      }

      if (isEmbeddedNavigationCommand(event.data)) {
        dispatchEmbeddedNavigation(event.data);
        return;
      }
      if (!isXgc2EmbeddedHostCommand(event.data)) {
        return;
      }

      toggleSurface(event.data.surface);
    };

    window.addEventListener("message", handleMessage);

    const readyMessage: Xgc2EmbeddedReadyMessage = {
      channel: XGC2_EMBED_CHANNEL,
      version: XGC2_EMBED_VERSION,
      sender: "lichtblick",
      type: "ready",
      capabilities: XGC2_EMBED_SURFACES,
      visibleSurfaces,
    };
    parentWindow.postMessage(readyMessage, expectedOrigin);

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [setHostTheme, toggleSurface, visibleSurfaces]);

  return null;
}
