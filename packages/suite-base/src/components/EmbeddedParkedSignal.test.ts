/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { XGC2_HOST_VISIBILITY_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceProtocol";

import {
  lastEmbeddedHostVisibility,
  registerEmbeddedCanvasVisibility,
  resetEmbeddedHostVisibilityForTests,
  subscribeEmbeddedHostVisibility,
  subscribeEmbeddedParkedState,
  type EmbeddedCanvasVisibilityReporter,
} from "./EmbeddedParkedSignal";

describe("EmbeddedParkedSignal", () => {
  let reporters: EmbeddedCanvasVisibilityReporter[];
  let unsubscribers: (() => void)[];

  beforeEach(() => {
    reporters = [];
    unsubscribers = [];
  });

  afterEach(() => {
    for (const reporter of reporters) {
      reporter.dispose();
    }
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    resetEmbeddedHostVisibilityForTests();
  });

  function register(id: string): EmbeddedCanvasVisibilityReporter {
    const reporter = registerEmbeddedCanvasVisibility(id);
    reporters.push(reporter);
    return reporter;
  }

  function subscribe(listener: jest.Mock): void {
    unsubscribers.push(subscribeEmbeddedParkedState(listener));
    listener.mockClear();
  }

  it("is not parked with no registered canvases", () => {
    const listener = jest.fn();
    unsubscribers.push(subscribeEmbeddedParkedState(listener));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("parks when every registered canvas is hidden and resumes when one shows", () => {
    const listener = jest.fn();
    const canvas = register("a");
    subscribe(listener);

    canvas.setVisible(false);
    expect(listener).toHaveBeenLastCalledWith(true);

    canvas.setVisible(true);
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stays unparked while any canvas is visible", () => {
    const listener = jest.fn();
    const a = register("a");
    const b = register("b");
    subscribe(listener);

    a.setVisible(false);
    expect(listener).not.toHaveBeenCalled();

    b.setVisible(false);
    expect(listener).toHaveBeenLastCalledWith(true);

    a.setVisible(true);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("resumes when the last hidden canvas unregisters", () => {
    const listener = jest.fn();
    const a = register("a");
    const b = register("b");
    subscribe(listener);

    a.setVisible(false);
    b.setVisible(false);
    expect(listener).toHaveBeenLastCalledWith(true);

    a.dispose();
    expect(listener).toHaveBeenCalledTimes(1); // still parked: b remains hidden

    b.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it("ignores duplicate reports of the same state", () => {
    const listener = jest.fn();
    const canvas = register("a");
    subscribe(listener);

    canvas.setVisible(false);
    canvas.setVisible(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells a late subscriber the current parked state immediately", () => {
    const canvas = register("a");
    canvas.setVisible(false);

    const listener = jest.fn();
    unsubscribers.push(subscribeEmbeddedParkedState(listener));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);
  });

  it("retains one host visibility for a panel that has not mounted yet", () => {
    const parked = jest.fn();
    subscribe(parked);
    const host = jest.fn();
    unsubscribers.push(subscribeEmbeddedHostVisibility(host));

    expect(lastEmbeddedHostVisibility()).toBeUndefined();
    window.dispatchEvent(
      new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
    );
    expect(lastEmbeddedHostVisibility()).toBe(false);
    expect(host).toHaveBeenCalledTimes(1);
    expect(host).toHaveBeenLastCalledWith(false);
    expect(parked).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: {} }));
    expect(lastEmbeddedHostVisibility()).toBe(false);
    expect(host).toHaveBeenCalledTimes(1);
  });

  it("holds an embedded player before any canvas or host visibility report", () => {
    const previous = window.location.href;
    window.history.replaceState({}, "", "/?xgc2Embed=1");
    const listener = jest.fn();
    try {
      unsubscribers.push(subscribeEmbeddedParkedState(listener));
      expect(listener).toHaveBeenLastCalledWith(true);
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
      );
      expect(listener).toHaveBeenCalledTimes(1);
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: true } }),
      );
      expect(listener).toHaveBeenLastCalledWith(false);
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
      );
      expect(listener).toHaveBeenLastCalledWith(true);
      const canvas = register("visible-but-host-hidden");
      canvas.setVisible(true);
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      window.history.replaceState({}, "", previous);
    }
  });

  it("registers a second hidden canvas without unparking or flushing deferred bytes", () => {
    const listener = jest.fn();
    const first = register("first");
    first.setVisible(false);
    subscribe(listener);

    const deferred = ["latest-snapshot"];
    unsubscribers.push(
      subscribeEmbeddedParkedState((next) => {
        if (!next) {
          deferred.length = 0;
        }
      }),
    );

    const second = registerEmbeddedCanvasVisibility("second", "hidden");
    reporters.push(second);

    expect(listener).not.toHaveBeenCalled();
    expect(deferred).toEqual(["latest-snapshot"]);
  });

  it("ignores reports from a disposed reporter", () => {
    const listener = jest.fn();
    const canvas = register("a");
    subscribe(listener);

    canvas.setVisible(false);
    canvas.dispose();
    canvas.setVisible(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);
  });
});
