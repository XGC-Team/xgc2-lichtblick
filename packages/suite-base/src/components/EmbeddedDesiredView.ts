// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import Logger from "@lichtblick/log";

import { XGC2_EMBED_SURFACES, type Xgc2EmbeddedSurface } from "./EmbeddedWorkspaceProtocol";

const log = Logger.getLogger(__filename);

/**
 * The desired view of an embedded viewer: what the controlling service wants the page to show.
 * An absent field means that the page keeps its own choice. The launcher stores the view and
 * streams it to every page of its origin; the page applies each revision once and then leaves
 * the operator in charge, so a manual camera change is never fought.
 */
export type DesiredView = {
  layoutId?: string;
  followRobot?: string;
  perspective?: boolean;
  visibleSurfaces?: readonly Xgc2EmbeddedSurface[];
};

export type DesiredViewState = { revision: string; view: DesiredView };

const VIEW_FIELDS = ["layoutId", "followRobot", "perspective", "visibleSurfaces"];
const REVISION = /^(0|[1-9]\d*)$/;
const VIEW_EVENTS_PATH = "xgc2/view/events";

/** The sidebars hold one item at a time; the left one serves four surfaces, the right one a single surface. */
const SIDEBAR_GROUPS: readonly (readonly Xgc2EmbeddedSurface[])[] = [
  ["panel-settings", "alerts", "topics", "layouts"],
  ["variables"],
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

/** Reads one `{revision, view}` document of the stream; anything else is not a view and is ignored. */
export function parseDesiredViewState(value: unknown): DesiredViewState | undefined {
  if (!isPlainRecord(value) || typeof value.revision !== "string" || !REVISION.test(value.revision)) {
    return undefined;
  }
  const wire = value.view;
  if (!isPlainRecord(wire) || Object.keys(wire).some((key) => !VIEW_FIELDS.includes(key))) {
    return undefined;
  }
  const { layoutId, followRobot, perspective, visibleSurfaces } = wire;
  const view: DesiredView = {};
  if (layoutId != undefined) {
    if (typeof layoutId !== "string" || layoutId === "") {
      return undefined;
    }
    view.layoutId = layoutId;
  }
  if (followRobot != undefined) {
    if (typeof followRobot !== "string" || followRobot === "") {
      return undefined;
    }
    view.followRobot = followRobot;
  }
  if (perspective != undefined) {
    if (typeof perspective !== "boolean") {
      return undefined;
    }
    view.perspective = perspective;
  }
  if (visibleSurfaces != undefined) {
    if (
      !Array.isArray(visibleSurfaces) ||
      visibleSurfaces.some(
        (surface) =>
          typeof surface !== "string" || !(XGC2_EMBED_SURFACES as readonly string[]).includes(surface),
      )
    ) {
      return undefined;
    }
    view.visibleSurfaces = visibleSurfaces as Xgc2EmbeddedSurface[];
  }
  return { revision: value.revision, view };
}

/** The frame a robot's viewer is anchored to: the body frame every robot publishes under its name. */
export function robotFollowFrameId(robot: string): string {
  return `xgc/robots/${robot}/base_link`;
}

/** What the page shows now, as far as the desired view can be compared with it. */
export type ObservedView = {
  layoutId: string | undefined;
  visibleSurfaces: readonly Xgc2EmbeddedSurface[];
  /** The one native 3D panel that can be navigated; undefined while there is none or more than one. */
  panel: { panelId: string; perspective: boolean; followFrameId: string | undefined } | undefined;
};

export type ViewField = "layout" | "surfaces" | "follow" | "perspective";
export type ViewStep =
  | { type: "layout"; layoutId: string }
  | { type: "surface"; surface: Xgc2EmbeddedSurface }
  | { type: "follow"; panelId: string; frameId: string }
  | { type: "perspective"; panelId: string };

/** The fields of a view that state something. */
export function viewFields(view: DesiredView): Set<ViewField> {
  const fields = new Set<ViewField>();
  if (view.layoutId != undefined) {
    fields.add("layout");
  }
  if (view.visibleSurfaces != undefined) {
    fields.add("surfaces");
  }
  if (view.followRobot != undefined) {
    fields.add("follow");
  }
  if (view.perspective != undefined) {
    fields.add("perspective");
  }
  return fields;
}

/** The surfaces to toggle to turn `current` into `desired`; a sidebar shows one item, so selecting one replaces another. */
export function surfaceToggles(
  current: readonly Xgc2EmbeddedSurface[],
  desired: readonly Xgc2EmbeddedSurface[],
): Xgc2EmbeddedSurface[] {
  const toggles: Xgc2EmbeddedSurface[] = [];
  const grouped = new Set(SIDEBAR_GROUPS.flat());
  for (const group of SIDEBAR_GROUPS) {
    const has = group.find((surface) => current.includes(surface));
    // Only the first desired item of a sidebar can be shown.
    const want = group.find((surface) => desired.includes(surface));
    if (want !== has) {
      toggles.push((want ?? has)!);
    }
  }
  for (const surface of XGC2_EMBED_SURFACES) {
    if (!grouped.has(surface) && current.includes(surface) !== desired.includes(surface)) {
      toggles.push(surface);
    }
  }
  return toggles;
}

/**
 * Decides what to do now for the fields of `pending`, and which fields remain pending.
 * The layout and the surfaces are stated once; the camera fields stay pending until the
 * navigable panel shows them, which also covers a panel that appears after a layout switch.
 * `layoutSettled` says that the layout is the desired one, or cannot become it.
 */
export function planDesiredView(
  view: DesiredView,
  observed: ObservedView,
  pending: ReadonlySet<ViewField>,
  { layoutSettled }: { layoutSettled: boolean },
): { steps: ViewStep[]; pending: Set<ViewField> } {
  const steps: ViewStep[] = [];
  const next = new Set(pending);
  if (next.has("layout") && view.layoutId != undefined) {
    if (observed.layoutId !== view.layoutId) {
      steps.push({ type: "layout", layoutId: view.layoutId });
    }
    next.delete("layout");
  }
  if (next.has("surfaces") && view.visibleSurfaces != undefined) {
    for (const surface of surfaceToggles(observed.visibleSurfaces, view.visibleSurfaces)) {
      steps.push({ type: "surface", surface });
    }
    next.delete("surfaces");
  }
  const { panel } = observed;
  if (layoutSettled && panel != undefined) {
    if (next.has("follow") && view.followRobot != undefined) {
      const frameId = robotFollowFrameId(view.followRobot);
      if (panel.followFrameId === frameId) {
        next.delete("follow");
      } else {
        steps.push({ type: "follow", panelId: panel.panelId, frameId });
      }
    }
    if (next.has("perspective") && view.perspective != undefined) {
      if (panel.perspective === view.perspective) {
        next.delete("perspective");
      } else {
        steps.push({ type: "perspective", panelId: panel.panelId });
      }
    }
  }
  return { steps, pending: next };
}

/**
 * Follows the desired view of this origin. The stream opens with the current state, so a page
 * that opens later, or reconnects, never depends on having been open when the view changed.
 * Returns the function that closes the stream.
 */
export function connectDesiredView(
  onState: (state: DesiredViewState) => void,
  createSource: (url: string) => EventSource = (url) => new EventSource(url),
): () => void {
  const source = createSource(new URL(VIEW_EVENTS_PATH, document.baseURI).href);
  const handleView = (event: Event) => {
    let state: DesiredViewState | undefined;
    try {
      state = parseDesiredViewState(JSON.parse((event as MessageEvent<string>).data));
    } catch {
      state = undefined;
    }
    if (state) {
      onState(state);
    } else {
      log.warn("Ignoring a desired view the viewer cannot read");
    }
  };
  source.addEventListener("view", handleView);
  return () => {
    source.removeEventListener("view", handleView);
    source.close();
  };
}
