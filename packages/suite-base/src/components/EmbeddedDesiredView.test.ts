/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  connectDesiredView,
  parseDesiredViewState,
  planDesiredView,
  robotFollowFrameId,
  surfaceToggles,
  viewFields,
  type DesiredView,
  type ObservedView,
  type ViewField,
} from "./EmbeddedDesiredView";

const NO_PANEL: ObservedView = { layoutId: undefined, visibleSurfaces: [], panel: undefined };

describe("parseDesiredViewState", () => {
  it("reads a revision and the four optional fields", () => {
    expect(
      parseDesiredViewState({
        revision: "12",
        view: {
          layoutId: "camera-ar",
          followRobot: "uav1",
          perspective: false,
          visibleSurfaces: ["3d-tools", "topics"],
        },
      }),
    ).toEqual({
      revision: "12",
      view: {
        layoutId: "camera-ar",
        followRobot: "uav1",
        perspective: false,
        visibleSurfaces: ["3d-tools", "topics"],
      },
    });
  });

  it("treats null fields as unstated and keeps an empty surface list as stated", () => {
    expect(
      parseDesiredViewState({
        revision: "0",
        view: { layoutId: null, followRobot: null, perspective: null, visibleSurfaces: null },
      }),
    ).toEqual({ revision: "0", view: {} });
    expect(parseDesiredViewState({ revision: "1", view: { visibleSurfaces: [] } })).toEqual({
      revision: "1",
      view: { visibleSurfaces: [] },
    });
  });

  it.each([
    undefined,
    "view",
    [],
    { view: {} },
    { revision: 3, view: {} },
    { revision: "03", view: {} },
    { revision: "-1", view: {} },
    { revision: "1" },
    { revision: "1", view: [] },
    { revision: "1", view: { unknown: true } },
    { revision: "1", view: { layoutId: 7 } },
    { revision: "1", view: { layoutId: "" } },
    { revision: "1", view: { followRobot: "" } },
    { revision: "1", view: { perspective: "yes" } },
    { revision: "1", view: { visibleSurfaces: "topics" } },
    { revision: "1", view: { visibleSurfaces: ["nowhere"] } },
  ])("ignores %j", (value) => {
    expect(parseDesiredViewState(value)).toBeUndefined();
  });
});

describe("surfaceToggles", () => {
  it("toggles only what differs", () => {
    expect(surfaceToggles([], [])).toEqual([]);
    expect(surfaceToggles(["3d-tools"], ["3d-tools"])).toEqual([]);
    expect(surfaceToggles([], ["3d-tools", "panel-controls"])).toEqual([
      "3d-tools",
      "panel-controls",
    ]);
    expect(surfaceToggles(["obstacle-scene", "variables"], [])).toEqual([
      "variables",
      "obstacle-scene",
    ]);
  });

  it("selects the wanted item of a sidebar instead of closing the open one", () => {
    // Selecting an item replaces the open one; toggling both would open the old item again.
    expect(surfaceToggles(["alerts"], ["topics"])).toEqual(["topics"]);
    expect(surfaceToggles(["alerts"], [])).toEqual(["alerts"]);
    expect(surfaceToggles([], ["layouts"])).toEqual(["layouts"]);
    expect(surfaceToggles(["topics"], ["topics", "variables"])).toEqual(["variables"]);
  });
});

describe("planDesiredView", () => {
  const view: DesiredView = {
    layoutId: "L1",
    followRobot: "uav1",
    perspective: true,
    visibleSurfaces: ["topics"],
  };
  const panel = { panelId: "3D!a", perspective: false, followFrameId: undefined };

  it("names the fields a view states", () => {
    expect(viewFields({})).toEqual(new Set());
    expect(viewFields(view)).toEqual(new Set(["layout", "surfaces", "follow", "perspective"]));
  });

  it("derives the follow frame from the robot name", () => {
    expect(robotFollowFrameId("uav1")).toBe("xgc/robots/uav1/base_link");
  });

  it("states the layout and the surfaces once and holds the camera until a panel exists", () => {
    const first = planDesiredView(view, NO_PANEL, viewFields(view), { layoutSettled: false });
    expect(first.steps).toEqual([
      { type: "layout", layoutId: "L1" },
      { type: "surface", surface: "topics" },
    ]);
    expect(first.pending).toEqual(new Set(["follow", "perspective"]));
    // A repeat evaluation does not state them again.
    expect(planDesiredView(view, NO_PANEL, first.pending, { layoutSettled: false }).steps).toEqual([]);
  });

  it("does not select a layout that is already selected", () => {
    const plan = planDesiredView(
      { layoutId: "L1" },
      { ...NO_PANEL, layoutId: "L1" },
      new Set<ViewField>(["layout"]),
      { layoutSettled: true },
    );
    expect(plan.steps).toEqual([]);
    expect(plan.pending.size).toBe(0);
  });

  it("steers the panel only once the layout is the desired one", () => {
    const pending = new Set<ViewField>(["follow", "perspective"]);
    const observed = { ...NO_PANEL, layoutId: "L1", panel };
    expect(planDesiredView(view, observed, pending, { layoutSettled: false }).steps).toEqual([]);
    const plan = planDesiredView(view, observed, pending, { layoutSettled: true });
    expect(plan.steps).toEqual([
      { type: "follow", panelId: "3D!a", frameId: "xgc/robots/uav1/base_link" },
      { type: "perspective", panelId: "3D!a" },
    ]);
    // Both stay pending until the panel reports them.
    expect(plan.pending).toEqual(pending);
  });

  it("settles the camera fields when the panel shows them and then leaves the operator in charge", () => {
    const shown = { ...panel, perspective: true, followFrameId: "xgc/robots/uav1/base_link" };
    const settled = planDesiredView(
      view,
      { ...NO_PANEL, layoutId: "L1", panel: shown },
      new Set<ViewField>(["follow", "perspective"]),
      { layoutSettled: true },
    );
    expect(settled.steps).toEqual([]);
    expect(settled.pending.size).toBe(0);
    // The operator changes the view afterwards: nothing is pending, so nothing is fought.
    const changed = planDesiredView(
      view,
      { ...NO_PANEL, layoutId: "L1", panel: { ...shown, perspective: false } },
      settled.pending,
      { layoutSettled: true },
    );
    expect(changed.steps).toEqual([]);
  });

  it("states nothing about fields the view leaves out", () => {
    const plan = planDesiredView({}, NO_PANEL, viewFields({}), { layoutSettled: true });
    expect(plan.steps).toEqual([]);
    expect(plan.pending.size).toBe(0);
  });
});

describe("connectDesiredView", () => {
  class FakeSource {
    public readonly listeners = new Map<string, Set<(event: Event) => void>>();
    public closed = false;
    public constructor(public readonly url: string) {}
    public addEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
    }
    public removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.get(type)?.delete(listener);
    }
    public close(): void {
      this.closed = true;
    }
    public emit(type: string, data: string | undefined): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(new MessageEvent(type, { data }));
      }
    }
  }

  it("opens the same-origin event stream and delivers readable states", () => {
    let source: FakeSource | undefined;
    const onState = jest.fn();
    const close = connectDesiredView(onState, (url) => {
      source = new FakeSource(url);
      return source as unknown as EventSource;
    });
    expect(source?.url).toBe(new URL("xgc2/view/events", document.baseURI).href);

    source!.emit("view", JSON.stringify({ revision: "4", view: { perspective: true } }));
    expect(onState).toHaveBeenCalledWith({ revision: "4", view: { perspective: true } });

    // A frame that is not a view never reaches the page.
    source!.emit("view", "not json");
    source!.emit("view", JSON.stringify({ revision: "x", view: {} }));
    expect(onState).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(2);
    (console.warn as jest.Mock).mockClear();

    close();
    expect(source!.closed).toBe(true);
    source!.emit("view", JSON.stringify({ revision: "5", view: {} }));
    expect(onState).toHaveBeenCalledTimes(1);
  });
});
