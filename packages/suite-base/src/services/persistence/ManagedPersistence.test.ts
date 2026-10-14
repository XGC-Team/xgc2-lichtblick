// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CoreUiDocumentAssets } from "./CoreUiDocumentAssets";
import { CoreUiDocumentClient } from "./CoreUiDocumentClient";
import { CoreUiDocumentStore } from "./CoreUiDocumentStore";
import type { ManagedAssetTransport } from "./ManagedAsset";
import { ManagedDocumentStore } from "./ManagedDocumentStore";
import {
  getManagedAssetTransport,
  getManagedDocumentStore,
  initializeManagedPersistence,
} from "./ManagedPersistence";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

const mockReload = jest.fn();

beforeEach(() => {
  mockReload.mockReset();
  Object.defineProperty(globalThis, "window", {
    value: { location: { reload: mockReload } },
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: { baseURI: "https://core.test/visualization/targets/target/lichtblick/instance/" },
    configurable: true,
  });
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  delete (globalThis as { document?: unknown }).document;
});

it("initializes the web store and first-seen profile through Core before exposing persistence", async () => {
  const server = new CoreUiDocumentServer();
  jest.spyOn(globalThis, "fetch").mockImplementation(server.fetch);
  const store = await initializeManagedPersistence();
  expect(store).toBeInstanceOf(CoreUiDocumentStore);
  expect(getManagedDocumentStore()).toBe(store);
  expect(getManagedAssetTransport()).toBeInstanceOf(CoreUiDocumentAssets);
  expect(store.get("profile", "user")).toEqual({
    firstSeenTime: expect.any(String),
    firstSeenTimeIsFirstLoad: true,
  });
  expect(server.requests.slice(0, 5).every(({ options }) => options?.method == undefined)).toBe(
    true,
  );
  expect(
    server.requests.every(({ url }) => url.pathname.startsWith("/api/ui-documents/lichtblick/")),
  ).toBe(true);
  expect(server.requests.some(({ url }) => url.pathname.includes("/desktop"))).toBe(false);
});

it("keeps the viewer alive after a refused save and accepts the next explicit edit", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  await client.put("configuration", "language", "en", "0");
  jest.spyOn(globalThis, "fetch").mockImplementation(server.fetch);
  const store = await initializeManagedPersistence();
  await client.put("configuration", "language", "fr", "1");
  await expect(
    store.commit([{ family: "configuration", key: "language", value: "de" }]),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(store.state.pending).toBe(0);
  expect(store.get("configuration", "language")).toBe("fr");
  expect(mockReload).not.toHaveBeenCalled();
  await store.commit([{ family: "workspace", key: "ui", value: {} }]);
  expect(store.get("workspace", "ui")).toEqual({});
  expect(mockReload).not.toHaveBeenCalled();
});

it("refuses startup when Core is unavailable", async () => {
  const server = new CoreUiDocumentServer();
  server.unavailable = true;
  jest.spyOn(globalThis, "fetch").mockImplementation(server.fetch);
  await expect(initializeManagedPersistence()).rejects.toMatchObject({ code: "unavailable" });
  expect(server.requests).toHaveLength(1);
});

it("keeps the desktop initializer's explicit IPC transport and asset interface", async () => {
  const bootstrap = jest.spyOn(ManagedDocumentStore.prototype, "bootstrap").mockResolvedValue();
  jest
    .spyOn(ManagedDocumentStore.prototype, "get")
    .mockReturnValue({ firstSeenTime: "2026-10-11T00:00:00Z" });
  const fetcher = jest.spyOn(globalThis, "fetch");
  const transport = jest.fn();
  const assets: ManagedAssetTransport = { publish: jest.fn(), load: jest.fn() };
  const store = await initializeManagedPersistence(transport, assets);
  expect(store).toBeInstanceOf(ManagedDocumentStore);
  expect(bootstrap).toHaveBeenCalledTimes(1);
  expect(getManagedDocumentStore()).toBe(store);
  expect(getManagedAssetTransport()).toBe(assets);
  expect(fetcher).not.toHaveBeenCalled();
});
