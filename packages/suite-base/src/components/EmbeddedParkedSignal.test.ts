// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import {
  registerEmbeddedCanvasVisibility,
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
