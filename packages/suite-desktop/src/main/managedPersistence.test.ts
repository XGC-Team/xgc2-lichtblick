// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ipcMain } from "electron";

import StudioWindow from "./StudioWindow";
import { registerManagedPersistenceIPC } from "./managedPersistence";
import type { ManagedDomainClient } from "../../../../xgc2/launcher/managed-storage.cjs";
import type { ManagedIPCReply } from "../common/types";

jest.mock("electron", () => ({ ipcMain: { handle: jest.fn() } }));
jest.mock("./StudioWindow", () => ({
  __esModule: true,
  default: { fromWebContentsId: jest.fn(), isRendererURL: jest.fn() },
}));
jest.mock("./settings", () => ({ observeCommittedSettings: jest.fn() }));

const frame = { url: "file:///app/renderer/index.html" };
const sender = { id: 7, mainFrame: frame };
const event = {
  sender,
  senderFrame: frame,
} as unknown as Electron.IpcMainInvokeEvent;
const request = { operation: "receipt", requestId: "request-a" };
type Handler = (
  event: Electron.IpcMainInvokeEvent,
  input: unknown,
) => Promise<ManagedIPCReply<unknown>>;

function handler(): Handler {
  const registered = (ipcMain.handle as jest.Mock).mock.calls.find(
    ([channel]) => channel === "managed-domain-request",
  );
  return registered![1] as Handler;
}
function client(requestFn: ManagedDomainClient["request"]): ManagedDomainClient {
  return {
    request: requestFn,
    ready: Promise.resolve(),
    publish: jest.fn(),
    load: jest.fn(),
    beginDrain: jest.fn(),
    close: jest.fn(),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  (StudioWindow.fromWebContentsId as jest.Mock).mockReturnValue({});
  (StudioWindow.isRendererURL as jest.Mock).mockReturnValue(true);
});

it("denies subframes and unknown windows before reaching storage", async () => {
  const call = jest.fn(async () => ({}));
  registerManagedPersistenceIPC(client(call));
  expect(
    await handler()(
      { ...event, senderFrame: { ...frame } } as Electron.IpcMainInvokeEvent,
      request,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "forbidden", outcome: "not_sent" },
  });
  (StudioWindow.fromWebContentsId as jest.Mock).mockReturnValue(undefined);
  expect(await handler()(event, request)).toMatchObject({
    ok: false,
    error: { code: "forbidden" },
  });
  expect(call).not.toHaveBeenCalled();
});

it("denies a known window after it navigates away from the application entry", async () => {
  const call = jest.fn(async () => ({}));
  registerManagedPersistenceIPC(client(call));
  (StudioWindow.isRendererURL as jest.Mock).mockReturnValue(false);
  expect(await handler()(event, request)).toMatchObject({
    ok: false,
    error: { code: "forbidden", outcome: "not_sent" },
  });
  expect(call).not.toHaveBeenCalled();
});

it("bounds concurrent IPC calls and restores capacity after completion", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = jest.fn(async () => {
    await pending;
    return {};
  });
  registerManagedPersistenceIPC(client(call));
  const calls = Array.from({ length: 8 }, async () => await handler()(event, request));
  expect(await handler()(event, request)).toMatchObject({
    ok: false,
    error: { code: "overloaded", outcome: "not_sent" },
  });
  expect(call).toHaveBeenCalledTimes(8);
  release();
  await Promise.all(calls);
  expect(await handler()(event, request)).toMatchObject({ ok: true });
});

it("preserves unknown outcomes without replaying a write", async () => {
  const call = jest.fn(async () => {
    throw Object.assign(new Error("Disconnected"), {
      code: "unavailable",
      outcome: "outcome_unknown",
      requestId: "request-a",
    });
  });
  registerManagedPersistenceIPC(client(call));
  expect(await handler()(event, request)).toMatchObject({
    ok: false,
    error: {
      code: "unavailable",
      outcome: "outcome_unknown",
      requestId: "request-a",
    },
  });
  expect(call).toHaveBeenCalledTimes(1);
});
