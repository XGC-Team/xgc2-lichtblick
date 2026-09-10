/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { EmbeddedSceneBridge, isSceneHostMessage } from "./EmbeddedSceneBridge";
import { XGC2_EMBED_CHANNEL, XGC2_EMBED_VERSION } from "./EmbeddedWorkspaceProtocol";

const header = { channel: XGC2_EMBED_CHANNEL, version: XGC2_EMBED_VERSION, sender: "xgc2" };
const binding = {
  ...header,
  type: "scene-binding",
  binding: { namespace: "/xgc/scene", editable: true },
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

describe("authenticated scene embed transport", () => {
  let bridge: EmbeddedSceneBridge;
  let disconnect: () => void;
  let postMessage: jest.SpyInstance;
  beforeEach(() => {
    bridge = new EmbeddedSceneBridge();
    disconnect = bridge.connect(window.parent, window.location.origin);
    postMessage = jest.spyOn(window.parent, "postMessage").mockImplementation();
  });
  afterEach(() => {
    disconnect();
    jest.useRealTimers();
  });

  it("requires explicit parent binding and rejects source/origin spoofing", async () => {
    dispatch(binding, { source: null });
    dispatch(binding, { origin: "https://elsewhere.invalid" });
    expect(bridge.getBinding()).toBeUndefined();
    await expect(
      bridge.command("/xgc/scene", { operation: "get", requestId: "one" }),
    ).rejects.toThrow("unavailable");
    dispatch(binding);
    await expect(
      bridge.command("/other/scene", { operation: "get", requestId: "one" }),
    ).rejects.toThrow("unavailable");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("correlates results and only trusts the same authenticated parent", async () => {
    dispatch(binding);
    const command = { operation: "get" as const, requestId: "request-1" };
    const pending = bridge.command("/xgc/scene", command);
    expect(postMessage).toHaveBeenCalledWith(
      {
        ...header,
        sender: "lichtblick",
        type: "scene-command",
        requestId: command.requestId,
        command,
      },
      window.location.origin,
    );
    const result = {
      ...header,
      type: "scene-command-result",
      requestId: "request-1",
      result: { success: true },
    };
    dispatch(result, { origin: "https://elsewhere.invalid" });
    dispatch({ ...result, requestId: "different" });
    dispatch(result);
    await expect(pending).resolves.toEqual({ success: true });
  });

  it("revocation cancels pending operations and disables further writes", async () => {
    dispatch(binding);
    const pending = bridge.command("/xgc/scene", { operation: "get", requestId: "one" });
    const rejection = pending.catch((error: unknown) => error);
    dispatch({ ...header, type: "scene-binding" });
    expect(await rejection).toBeInstanceOf(Error);
    expect(bridge.getBinding()).toBeUndefined();
  });

  it("times out without pretending the scene was accepted", async () => {
    jest.useFakeTimers();
    dispatch(binding);
    const pending = bridge.command("/xgc/scene", { operation: "get", requestId: "one" });
    const rejection = pending.catch((error: unknown) => error);
    jest.advanceTimersByTime(30_000);
    expect(await rejection).toBeInstanceOf(Error);
  });

  it.each([
    { ...binding, version: 1 },
    { ...binding, extra: true },
    { ...binding, binding: null },
    { ...binding, binding: { namespace: "../../scene", editable: true } },
    { ...binding, binding: { namespace: "/xgc/scene", editable: true, token: "untrusted" } },
    { ...header, type: "scene-command-result", requestId: "a", result: {} },
  ])("rejects malformed messages %p", (value) => {
    expect(isSceneHostMessage(value)).toBe(false);
  });
});
