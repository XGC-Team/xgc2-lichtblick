// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect } from "react";

import { useEmbeddedWorkspaceControls } from "@lichtblick/suite-base/context/EmbeddedWorkspaceControlsContext";
import { useWorkspaceStore } from "@lichtblick/suite-base/context/Workspace/WorkspaceContext";
import { useWorkspaceActions } from "@lichtblick/suite-base/context/Workspace/useWorkspaceActions";

export const XGC2_EMBED_CHANNEL = "xgc2.lichtblick.embed";
export const XGC2_EMBED_VERSION = 2;
export const XGC2_EMBED_SURFACES = [
  "panel-settings",
  "alerts",
  "topics",
  "layouts",
  "variables",
  "panel-controls",
] as const;

export type Xgc2EmbeddedSurface = (typeof XGC2_EMBED_SURFACES)[number];

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

/**
 * Exposes the small, versioned command surface used by the same-origin XGC2 embed host.
 *
 * This component must only be mounted by an embedded Workspace. The source and origin checks keep
 * messages from other frames and windows from driving Workspace UI.
 */
export default function EmbeddedWorkspaceBridge(): null {
  const { sidebarActions } = useWorkspaceActions();
  const { panelControlsVisible, togglePanelControls } = useEmbeddedWorkspaceControls();

  const sidebars = useWorkspaceStore((store) => store.sidebars);

  useEffect(() => {
    const parentWindow = window.parent;
    const expectedOrigin = window.location.origin;

    const handleMessage = (event: MessageEvent<unknown>) => {
      if (
        event.origin !== expectedOrigin ||
        event.source !== parentWindow ||
        !isXgc2EmbeddedHostCommand(event.data)
      ) {
        return;
      }

      switch (event.data.surface) {
        case "panel-settings":
        case "alerts":
        case "topics":
        case "layouts":
          sidebarActions.left.selectItem(
            sidebars.left.open && sidebars.left.item === event.data.surface
              ? undefined
              : event.data.surface,
          );
          break;
        case "variables":
          sidebarActions.right.selectItem(
            sidebars.right.open && sidebars.right.item === event.data.surface
              ? undefined
              : event.data.surface,
          );
          break;
        case "panel-controls":
          togglePanelControls();
          break;
      }
    };

    window.addEventListener("message", handleMessage);

    const readyMessage: Xgc2EmbeddedReadyMessage = {
      channel: XGC2_EMBED_CHANNEL,
      version: XGC2_EMBED_VERSION,
      sender: "lichtblick",
      type: "ready",
      capabilities: XGC2_EMBED_SURFACES,
      visibleSurfaces: XGC2_EMBED_SURFACES.filter((surface) =>
        surface === "panel-controls"
          ? panelControlsVisible
          : (sidebars.left.open && sidebars.left.item === surface) ||
            (sidebars.right.open && sidebars.right.item === surface),
      ),
    };
    parentWindow.postMessage(readyMessage, expectedOrigin);

    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [panelControlsVisible, sidebarActions, sidebars, togglePanelControls]);

  return null;
}
