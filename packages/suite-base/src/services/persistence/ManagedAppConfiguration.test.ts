// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { ManagedAppConfiguration } from "./ManagedAppConfiguration";
import {
  ManagedBatchReceipt,
  ManagedDocumentStore,
  ManagedRequest,
  ManagedRequestError,
} from "./ManagedDocumentStore";

it("settings and change listeners publish only after the FULL receipt", async () => {
  const token = { database_id: "settings", schema: "v1", revision: "0" };
  let send!: (request: Extract<ManagedRequest, { operation: "batch" }>) => void;
  const sent = new Promise<Extract<ManagedRequest, { operation: "batch" }>>((resolve) => {
    send = resolve;
  });
  let acknowledge!: (receipt: ManagedBatchReceipt) => void;
  const receipt = new Promise<ManagedBatchReceipt>((resolve) => {
    acknowledge = resolve;
  });
  const store = new ManagedDocumentStore(async (request) => {
    if (request.operation === "snapshot") {
      return {
        token,
        records:
          "keys" in request
            ? request.keys.map((key) => ({ ...key, version: "0", missing: true }))
            : [],
      };
    }
    if (request.operation === "batch") {
      send(request);
      return await receipt;
    }
    throw new Error("Unexpected receipt query");
  });
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store, { language: "en" });
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  const saving = configuration.set("language", "de");
  const request = await sent;
  expect(configuration.get("language")).toBe("en");
  expect(changed).not.toHaveBeenCalled();
  expect(store.state.pending).toBe(1);
  acknowledge({
    token: { ...token, revision: "1" },
    requestId: request.requestId,
    durability: "sqlite-full",
    versions: [{ family: "configuration", key: "language", version: "1" }],
  });
  await saving;
  expect(configuration.get("language")).toBe("de");
  expect(changed).toHaveBeenCalledWith("de");
});
it("rejected setting changes retain the loaded setting and do not notify a saved value", async () => {
  const token = { database_id: "settings", schema: "v1", revision: "1" };
  const store = new ManagedDocumentStore(async (request) => {
    if (request.operation === "snapshot") {
      return {
        token,
        records: [{ family: "configuration", key: "language", value: "en", version: "1" }],
      };
    }
    throw new ManagedRequestError(
      "another window changed settings",
      "conflict",
      "application_rejected",
    );
  });
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store);
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  await expect(configuration.set("language", "de")).rejects.toThrow("another window");
  expect(configuration.get("language")).toBe("en");
  expect(changed).not.toHaveBeenCalled();
  expect(store.state.uncertainRequestId).toBeUndefined();
});
it("a recovered receipt updates the setting mirror and subscribers without replaying the write", async () => {
  const token = { database_id: "settings", schema: "v1", revision: "0" };
  let committed: ManagedBatchReceipt | undefined;
  let writes = 0;
  const store = new ManagedDocumentStore(async (request) => {
    if (request.operation === "snapshot") {
      return {
        token,
        records:
          "keys" in request
            ? request.keys.map((key) => ({ ...key, version: "0", missing: true }))
            : [],
      };
    }
    if (request.operation === "receipt") {
      return committed;
    }
    writes++;
    committed = {
      token: { ...token, revision: "1" },
      requestId: request.requestId,
      durability: "sqlite-full",
      versions: [{ family: "configuration", key: "language", version: "1" }],
    };
    throw new ManagedRequestError("receipt lost", "unavailable", "outcome_unknown");
  });
  await store.bootstrap(["configuration"]);
  const configuration = new ManagedAppConfiguration(store, { language: "en" });
  const changed = jest.fn();
  configuration.addChangeListener("language", changed);
  await expect(configuration.set("language", "de")).rejects.toThrow("receipt lost");
  expect(configuration.get("language")).toBe("en");
  expect(changed).not.toHaveBeenCalled();
  await store.resolveReceipt();
  expect(configuration.get("language")).toBe("de");
  expect(changed).toHaveBeenCalledWith("de");
  expect(writes).toBe(1);
});
