/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  EmbeddedViewCapture,
  VIEW_CAPTURE_CHANNEL,
  VIEW_CAPTURE_VERSION,
} from "./EmbeddedViewCapture";

const pixels = () => ({ png: new ArrayBuffer(9), renderedTimeNs: "12300000000" });
const request = {
  channel: VIEW_CAPTURE_CHANNEL,
  version: VIEW_CAPTURE_VERSION,
  sender: "host",
  type: "capture",
  requestId: "a".repeat(32),
  view: "3d",
  timeoutMs: 100,
};

function dispatch(data: unknown, overrides: Partial<MessageEventInit> = {}) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      source: window.parent,
      origin: window.location.origin,
      ...overrides,
    }),
  );
}

describe("embedded view capture", () => {
  it("selects actual mounted panel identity and requires disambiguation", async () => {
    const bridge = new EmbeddedViewCapture();
    bridge.register({ panelId: "3D!one", view: "3d", capture: async () => pixels() });
    const unregister = bridge.register({
      panelId: "3D!two",
      view: "3d",
      capture: async () => pixels(),
    });
    const signal = new AbortController().signal;
    await expect(bridge.capture("3d", undefined, signal)).rejects.toThrow("Multiple matching");
    await expect(bridge.capture("3d", "3D!two", signal)).resolves.toMatchObject({
      viewPanelId: "3D!two",
    });
    unregister();
    await expect(bridge.capture("3d", undefined, signal)).resolves.toMatchObject({
      viewPanelId: "3D!one",
    });
    await expect(bridge.capture("ar", undefined, signal)).rejects.toThrow("not mounted");
  });

  it("rejects foreign sources, origins, versions, and malformed commands", async () => {
    const bridge = new EmbeddedViewCapture();
    const capture = jest.fn(async () => pixels());
    bridge.register({ panelId: "3D!one", view: "3d", capture });
    const disconnect = bridge.connect(window.parent, window.location.origin);
    try {
      dispatch(request, { source: null });
      dispatch(request, { origin: "https://foreign.invalid" });
      dispatch({ ...request, version: 99 });
      dispatch({ ...request, extra: true });
      dispatch({ ...request, timeoutMs: 0 });
      await Promise.resolve();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      disconnect();
    }
  });

  it("replies once with pixels and rejects replayed request IDs", async () => {
    const bridge = new EmbeddedViewCapture();
    const capture = jest.fn(async () => pixels());
    bridge.register({ panelId: "3D!one", view: "3d", capture });
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    const disconnect = bridge.connect(window.parent, window.location.origin);
    try {
      dispatch(request);
      for (let step = 0; step < 8; step++) {
        await Promise.resolve();
      }
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: "viewer",
          type: "captured",
          viewPanelId: "3D!one",
          renderedTimeNs: "12300000000",
        }),
        window.location.origin,
        expect.any(Array),
      );
      dispatch(request);
      await Promise.resolve();
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      disconnect();
    }
  });

  it("times out only its request and leaves another view usable", async () => {
    jest.useFakeTimers();
    const bridge = new EmbeddedViewCapture();
    bridge.register({
      panelId: "3D!one",
      view: "3d",
      capture: async () => await new Promise(() => {}),
    });
    bridge.register({ panelId: "Image!one", view: "ar", capture: async () => pixels() });
    const postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
    const disconnect = bridge.connect(window.parent, window.location.origin);
    try {
      dispatch(request);
      await jest.advanceTimersByTimeAsync(100);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", error: expect.stringContaining("timed out") }),
        window.location.origin,
        [],
      );
      await expect(
        bridge.capture("ar", undefined, new AbortController().signal),
      ).resolves.toMatchObject({ viewPanelId: "Image!one" });
    } finally {
      disconnect();
      jest.useRealTimers();
    }
  });

  it("does not publish success after provider disposal", async () => {
    const bridge = new EmbeddedViewCapture();
    let finish: ((value: ReturnType<typeof pixels>) => void) | undefined;
    const unregister = bridge.register({
      panelId: "3D!one",
      view: "3d",
      capture: async () =>
        await new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = bridge.capture("3d", undefined, new AbortController().signal);
    unregister();
    finish?.(pixels());
    await expect(pending).rejects.toThrow("disposed");
  });
});
