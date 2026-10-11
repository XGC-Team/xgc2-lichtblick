// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CoreUiDocumentClient } from "./CoreUiDocumentClient";
import { CoreUiDocumentStore } from "./CoreUiDocumentStore";
import { ManagedAppConfiguration } from "./ManagedAppConfiguration";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

it("settings and listeners publish only after Core acknowledges the document", async () => {
  const server = new CoreUiDocumentServer();
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let sent!: () => void;
  const sending = new Promise<void>((resolve) => {
    sent = resolve;
  });
  const client = new CoreUiDocumentClient(async (input, options) => {
    const response = await server.fetch(input, options);
    if (options?.method === "PUT") {
      sent();
      await acknowledged;
    }
    return response;
  });
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store, { language: "en", timezone: "system" });
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  const saving = configuration.set("language", "de");
  await sending;
  expect(configuration.get("language")).toBe("en");
  expect(changed).not.toHaveBeenCalled();
  expect(store.state.pending).toBe(1);
  acknowledge();
  await saving;
  expect(configuration.get("language")).toBe("de");
  expect(changed).toHaveBeenCalledWith("de");
  configuration.removeChangeListener("language", changed);
  await configuration.set("language", "fr");
  expect(changed).toHaveBeenCalledTimes(1);
});

it("a conflicting setting rereads the other page's value and never publishes the refused value", async () => {
  const client = new CoreUiDocumentClient(new CoreUiDocumentServer().fetch);
  await client.put("configuration", "language", "en", "0");
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store);
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  await client.put("configuration", "language", "fr", "1");
  await expect(configuration.set("language", "de")).rejects.toMatchObject({ code: "conflict" });
  expect(configuration.get("language")).toBe("fr");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith("fr");
});

it("a lost write response updates the setting mirror by rereading, without replaying or claiming success", async () => {
  const server = new CoreUiDocumentServer();
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store, { language: "en" });
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  server.loseNextWriteResponse = true;
  await expect(configuration.set("language", "de")).rejects.toMatchObject({ code: "unavailable" });
  expect(configuration.get("language")).toBe("de");
  expect(changed).toHaveBeenCalledWith("de");
  expect(store.state.error).toBeDefined();
  expect(server.requests.filter(({ options }) => options?.method === "PUT")).toHaveLength(1);
});

it("clearing a stored time zone deletes its document and restores the system default", async () => {
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(new CoreUiDocumentServer().fetch));
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store, { timezone: "system" });
  await configuration.set("timezone", "America/Los_Angeles");
  expect(configuration.get("timezone")).toBe("America/Los_Angeles");
  await configuration.set("timezone", undefined);
  expect(configuration.get("timezone")).toBe("system");
  expect(store.get("configuration", "timezone")).toBeUndefined();
});
