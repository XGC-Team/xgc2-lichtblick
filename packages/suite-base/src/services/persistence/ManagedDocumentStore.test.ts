// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { LayoutID } from "../../context/CurrentLayoutContext";
import { Layout, ISO8601Timestamp } from "../ILayoutStorage";
import {
  ManagedBatchReceipt,
  ManagedDocumentStore,
  ManagedRecord,
  ManagedRequest,
  ManagedRequestError,
  ManagedTransport,
} from "./ManagedDocumentStore";
import { ManagedLayoutStorage, managedLayoutKey } from "./ManagedLayoutStorage";

function backend(): {
  transport: ManagedTransport;
  records: Map<string, ManagedRecord>;
  writes: ManagedRequest[];
} {
  const records = new Map<string, ManagedRecord>();
  const receipts = new Map<string, ManagedBatchReceipt>();
  const writes: ManagedRequest[] = [];
  let revision = 9007199254740993n;
  const token = () => ({
    database_id: "fixture",
    schema: "lichtblick-v1",
    revision: String(revision),
  });
  const transport: ManagedTransport = async (request) => {
    if (request.operation === "receipt") {
      const receipt = receipts.get(request.requestId);
      if (!receipt) {
        throw new ManagedRequestError("missing", "not_found");
      }
      return receipt;
    }
    if (request.operation === "snapshot") {
      if (request.at && request.at.revision !== String(revision)) {
        throw new ManagedRequestError("changed", "conflict");
      }
      const result =
        "keys" in request
          ? request.keys.map(
              (key) =>
                records.get(JSON.stringify([key.family, key.key])!) ?? {
                  ...key,
                  version: "0",
                  missing: true,
                },
            )
          : [...records.values()].filter((record) => request.families.includes(record.family));
      return { token: token(), records: structuredClone(result) };
    }
    writes.push(request);
    if (request.expected.revision !== String(revision)) {
      throw new ManagedRequestError("changed", "conflict", "application_rejected");
    }
    for (const change of request.changes) {
      if (
        change.expectedVersion !==
        (records.get(JSON.stringify([change.family, change.key])!)?.version ?? "0")
      ) {
        throw new ManagedRequestError("version", "conflict", "application_rejected");
      }
    }
    revision++;
    for (const change of request.changes) {
      records.set(JSON.stringify([change.family, change.key])!, {
        family: change.family,
        key: change.key,
        version: String(revision),
        ...(change.delete === true ? { deleted: true } : { value: structuredClone(change.value) }),
      });
    }
    const receipt: ManagedBatchReceipt = {
      token: token(),
      requestId: request.requestId,
      durability: "sqlite-full",
      versions: request.changes.map(({ family, key }) => ({
        family,
        key,
        version: String(revision),
      })),
    };
    receipts.set(request.requestId, receipt);
    return receipt;
  };
  return { transport, records, writes };
}
function layout(id: string): Layout {
  return {
    id: id as LayoutID,
    name: "view",
    permission: "CREATOR_WRITE",
    baseline: {
      data: {
        configById: { "3D!1": { cameraState: { distance: 20 } } },
        globalVariables: {},
        playbackConfig: { speed: 1 },
        userNodes: {},
      },
      savedAt: "2026-10-09T00:00:00Z" as ISO8601Timestamp,
    },
    working: undefined,
    syncInfo: undefined,
  };
}
it("working camera and active layout restore from managed storage after a fresh browser instance", async () => {
  const server = backend();
  const first = new ManagedDocumentStore(server.transport);
  await first.bootstrap();
  const view = layout("a");
  view.working = {
    ...view.baseline,
    data: { ...view.baseline.data, configById: { "3D!1": { cameraState: { distance: 7 } } } },
  };
  await new ManagedLayoutStorage(first).put("local", view, { activate: true });
  const request = server.writes[0];
  expect(request?.operation).toBe("batch");
  expect(
    (request as Extract<ManagedRequest, { operation: "batch" }>).changes.map(
      (change) => change.family,
    ),
  ).toEqual(["layouts", "profile"]);
  const fresh = new ManagedDocumentStore(server.transport);
  await fresh.bootstrap();
  expect(fresh.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe("a");
  expect(
    (await new ManagedLayoutStorage(fresh).get("local", "a" as LayoutID))?.working?.data.configById[
      "3D!1"
    ],
  ).toEqual({ cameraState: { distance: 7 } });
});
it("two tabs cannot silently overwrite one snapshot revision", async () => {
  const server = backend();
  const first = new ManagedDocumentStore(server.transport);
  const second = new ManagedDocumentStore(server.transport);
  await first.bootstrap();
  await second.bootstrap();
  await first.commit([{ family: "configuration", key: "language", value: "en" }]);
  await expect(
    second.commit([{ family: "configuration", key: "language", value: "de" }]),
  ).rejects.toThrow("changed");
  expect(second.get("configuration", "language")).toBeUndefined();
  expect(first.get("configuration", "language")).toBe("en");
});
it("two local keystrokes advance through their own receipts and do not block later workspace saves", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const first = store.commit([{ family: "configuration", key: "rosPackagePath", value: "/" }]);
  const second = store.commit([{ family: "configuration", key: "rosPackagePath", value: "/h" }]);
  await Promise.all([first, second]);
  expect(store.get("configuration", "rosPackagePath")).toBe("/h");
  await store.commit([{ family: "workspace", key: "ui", value: { sidebars: {} } }]);
  expect(store.state.error).toBeUndefined();
  expect(server.writes).toHaveLength(3);
});
it("queued profile merges and a layout save retain all fields and the latest active pointer", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const storage = new ManagedLayoutStorage(store);
  await storage.put("local", layout("old"), { activate: true });
  const first = store.commit(() => [
    {
      family: "profile",
      key: "user",
      value: { ...store.get<object>("profile", "user"), onboarding: { done: true } },
    },
  ]);
  const second = storage.put("local", layout("new"), { activate: true });
  const third = store.commit(() => [
    {
      family: "profile",
      key: "user",
      value: { ...store.get<object>("profile", "user"), firstSeenTime: "2026-10-09" },
    },
  ]);
  await Promise.all([first, second, third]);
  expect(store.get("profile", "user")).toEqual({
    currentLayoutId: "new",
    onboarding: { done: true },
    firstSeenTime: "2026-10-09",
  });
  const oldWorking = layout("old");
  oldWorking.working = {
    ...oldWorking.baseline,
    data: { ...oldWorking.baseline.data, configById: { "3D!1": { cameraState: { distance: 7 } } } },
  };
  await storage.put("local", oldWorking);
  expect(store.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe("new");
});
it("lost receipt blocks replay and can be resolved without another write", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(async (request) => {
    const result = await server.transport(request);
    if (request.operation === "batch") {
      throw new Error("disconnect after commit");
    }
    return result;
  });
  await store.bootstrap();
  await expect(
    store.commit([{ family: "workspace", key: "ui", value: { sidebars: {} } }]),
  ).rejects.toThrow("disconnect");
  expect(store.get("workspace", "ui")).toBeUndefined();
  expect(store.state.uncertainRequestId).toBeDefined();
  await expect(store.commit([{ family: "workspace", key: "ui", value: {} }])).rejects.toThrow();
  await store.resolveReceipt();
  expect(store.get("workspace", "ui")).toEqual({ sidebars: {} });
  expect(server.writes).toHaveLength(1);
  expect(store.state.error).toBeUndefined();
});
it("scoped replacement atomically deletes old layouts and switches the profile", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const layouts = new ManagedLayoutStorage(store);
  await layouts.put("local", layout("old"), { activate: true });
  await layouts.put("local", layout("new"), { activate: true, replaceIds: ["old" as LayoutID] });
  expect(await layouts.get("local", "old" as LayoutID)).toBeUndefined();
  expect(store.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe("new");
  const replacement = server.writes[1];
  expect((replacement as Extract<ManagedRequest, { operation: "batch" }>).changes).toHaveLength(3);
});
it("multi-file import commits all layouts and its final active pointer in one batch", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const storage = new ManagedLayoutStorage(store);
  await storage.putLayouts("local", [layout("first"), layout("last")], { activate: true });
  expect(server.writes).toHaveLength(1);
  expect(
    (server.writes[0] as Extract<ManagedRequest, { operation: "batch" }>).changes,
  ).toHaveLength(3);
  const fresh = new ManagedDocumentStore(server.transport);
  await fresh.bootstrap();
  expect(fresh.records("layouts")).toHaveLength(2);
  expect(fresh.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe("last");
});
it("invalid imported data leaves every old layout and active pointer intact", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const storage = new ManagedLayoutStorage(store);
  await storage.put("local", layout("old"), { activate: true });
  const invalid = layout("bad");
  (invalid.baseline as { data: unknown }).data = { data: {} };
  await expect(
    storage.putLayouts("local", [layout("good"), invalid], {
      activate: true,
      replaceIds: ["old" as LayoutID],
    }),
  ).rejects.toThrow("Invalid current layout data");
  expect(server.writes).toHaveLength(1);
  expect(await storage.list("local")).toHaveLength(1);
  expect(store.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe("old");
  await store.commit([{ family: "workspace", key: "ui", value: {} }]);
  expect(store.state.error).toBeUndefined();
});
it("namespace import is a single atomic plan with duplicate-name active pointer remapping", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(server.transport);
  await store.bootstrap();
  const layouts = new ManagedLayoutStorage(store);
  await layouts.put("local", layout("old"), { activate: true });
  await layouts.put("team", layout("existing"));
  await layouts.importLayouts({ fromNamespace: "local", toNamespace: "team" });
  expect(await layouts.list("local")).toHaveLength(0);
  expect(await layouts.list("team")).toHaveLength(1);
  expect(store.get<{ currentLayoutId: string }>("profile", "user")?.currentLayoutId).toBe(
    "existing",
  );
});
it("startup rejects old layout data and an incomplete snapshot cannot enable saves", async () => {
  const server = backend();
  server.records.set(JSON.stringify(["layouts", managedLayoutKey("local", "old" as LayoutID)])!, {
    family: "layouts",
    key: managedLayoutKey("local", "old" as LayoutID),
    version: "1",
    value: { id: "old", data: {} },
  });
  const store = new ManagedDocumentStore(server.transport);
  await expect(store.bootstrap()).rejects.toThrow("Invalid current managed layout");
  expect(() => store.get("profile", "user")).toThrow("has not loaded");
  expect(server.writes).toHaveLength(0);
});
it("large layouts reduce only read-page size with a fixed token", async () => {
  const server = backend();
  const requests: ManagedRequest[] = [];
  const store = new ManagedDocumentStore(async (request) => {
    requests.push(request);
    if (
      request.operation === "snapshot" &&
      "families" in request &&
      request.families[0] === "layouts" &&
      (request.limit ?? 128) > 1
    ) {
      throw new ManagedRequestError("large page", "resource_exhausted");
    }
    return await server.transport(request);
  });
  await store.bootstrap();
  expect(
    requests
      .filter(
        (request) =>
          request.operation === "snapshot" &&
          "families" in request &&
          request.families[0] === "layouts",
      )
      .map((request) =>
        request.operation === "snapshot" && "families" in request ? request.limit : undefined,
      ),
  ).toEqual([128, 64, 32, 16, 8, 4, 2, 1]);
  expect(server.writes).toHaveLength(0);
});
it("an invalid durability receipt does not claim a saved value", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(async (request) => {
    const response = await server.transport(request);
    return request.operation === "batch"
      ? { ...(response as ManagedBatchReceipt), durability: "queued" }
      : response;
  });
  await store.bootstrap();
  await expect(store.commit([{ family: "workspace", key: "ui", value: {} }])).rejects.toThrow(
    "Invalid durable",
  );
  expect(store.get("workspace", "ui")).toBeUndefined();
  expect(store.state.uncertainRequestId).toBeDefined();
});
it("startup requests one family at a time and pins all families to its first token", async () => {
  const server = backend();
  const requests: ManagedRequest[] = [];
  const store = new ManagedDocumentStore(async (request) => {
    requests.push(request);
    return await server.transport(request);
  });
  await store.bootstrap();
  const snapshots = requests.filter((request) => request.operation === "snapshot");
  expect(snapshots).toHaveLength(6);
  expect(snapshots.map((request) => ("families" in request ? request.families.length : 0))).toEqual(
    [1, 1, 1, 1, 1, 1],
  );
  expect(snapshots[0]?.at).toBeUndefined();
  for (const snapshot of snapshots.slice(1)) {
    expect(snapshot.at?.revision).toBe("9007199254740993");
  }
});
it("a competing change during startup restarts the whole snapshot without mixing revisions", async () => {
  const server = backend();
  const writer = new ManagedDocumentStore(server.transport);
  await writer.bootstrap();
  let competed = false;
  const requests: ManagedRequest[] = [];
  const store = new ManagedDocumentStore(async (request) => {
    requests.push(request);
    if (
      !competed &&
      request.operation === "snapshot" &&
      "families" in request &&
      request.families[0] === "profile"
    ) {
      competed = true;
      await writer.commit([{ family: "configuration", key: "language", value: "de" }]);
    }
    return await server.transport(request);
  });
  await store.bootstrap();
  expect(store.get("configuration", "language")).toBe("de");
  expect(
    requests.filter(
      (request) =>
        request.operation === "snapshot" &&
        "families" in request &&
        request.families[0] === "layouts",
    ),
  ).toHaveLength(2);
  expect(server.writes).toHaveLength(1);
});
it("continuous startup conflicts stop after three complete attempts without enabling writes", async () => {
  let starts = 0;
  const store = new ManagedDocumentStore(async (request) => {
    if (
      request.operation === "snapshot" &&
      "families" in request &&
      request.families[0] === "layouts"
    ) {
      starts++;
      return {
        token: { database_id: "fixture", schema: "v1", revision: String(starts) },
        records: [],
      };
    }
    throw new ManagedRequestError("changed", "conflict");
  });
  await expect(store.bootstrap()).rejects.toThrow("changed");
  expect(starts).toBe(3);
  expect(() => store.get("profile", "user")).toThrow("has not loaded");
});
it("an error with no definite batch outcome requires a receipt check", async () => {
  const server = backend();
  const store = new ManagedDocumentStore(async (request) => {
    const response = await server.transport(request);
    if (request.operation === "batch") {
      throw new ManagedRequestError("invalid response", "internal");
    }
    return response;
  });
  await store.bootstrap();
  await expect(
    store.commit([{ family: "configuration", key: "language", value: "de" }]),
  ).rejects.toThrow("invalid response");
  expect(store.state.uncertainRequestId).toBeDefined();
  await store.resolveReceipt();
  expect(store.get("configuration", "language")).toBe("de");
  expect(server.writes).toHaveLength(1);
});
