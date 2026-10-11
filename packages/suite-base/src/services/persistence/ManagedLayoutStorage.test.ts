// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import LayoutBuilder from "../../testing/builders/LayoutBuilder";
import { CoreUiDocumentClient } from "./CoreUiDocumentClient";
import { CoreUiDocumentStore } from "./CoreUiDocumentStore";
import { ManagedLayoutStorage, managedLayoutKey } from "./ManagedLayoutStorage";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

it("restores the working camera and active layout from a fresh page store", async () => {
  const client = new CoreUiDocumentClient(new CoreUiDocumentServer().fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  const layout = LayoutBuilder.layout({
    id: LayoutBuilder.layoutId("Layout-A"),
    permission: "CREATOR_WRITE",
  });
  layout.working = {
    ...layout.baseline,
    data: { ...layout.baseline.data, configById: { "3D!1": { cameraState: { distance: 7 } } } },
  };
  await new ManagedLayoutStorage(store).put("local", layout, { activate: true });
  const fresh = new CoreUiDocumentStore(client);
  await fresh.bootstrap();
  expect(fresh.get("profile", "user")).toEqual({ currentLayoutId: layout.id });
  expect(
    (await new ManagedLayoutStorage(fresh).get("local", layout.id))?.working?.data.configById[
      "3D!1"
    ],
  ).toEqual({ cameraState: { distance: 7 } });
});

it("refuses a conflicting layout save and reloads the newer layout into the store", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const layout = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("a"), name: "old" });
  await client.put("layouts", managedLayoutKey("local", layout.id), layout, "0");
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  await client.put(
    "layouts",
    managedLayoutKey("local", layout.id),
    { ...layout, name: "newer" },
    "1",
  );
  const storage = new ManagedLayoutStorage(store);
  await expect(
    storage.put("local", { ...layout, name: "conflicting" }, { activate: true }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await storage.get("local", layout.id))?.name).toBe("newer");
  expect(store.get("profile", "user")).toBeUndefined();
  expect(store.state.error).toMatchObject({ code: "conflict" });
});

it("keeps a successful layout write when profile activation conflicts and refuses import success", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  const storage = new ManagedLayoutStorage(store);
  const old = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("old") });
  await storage.put("local", old, { activate: true });
  const profileRevision = store.records("profile")[0]!.version;
  await client.put(
    "profile",
    "user",
    { currentLayoutId: old.id, name: "other tab" },
    profileRevision,
  );
  const next = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("next") });
  await expect(
    storage.putLayouts("local", [next], { activate: true, replaceIds: [old.id] }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(await storage.get("local", next.id)).toBeDefined();
  expect(await storage.get("local", old.id)).toBeDefined();
  expect(store.get("profile", "user")).toEqual({ currentLayoutId: old.id, name: "other tab" });
});

it("completes scoped replacement, deletion and namespace imports in document order", async () => {
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(new CoreUiDocumentServer().fetch));
  await store.bootstrap();
  const storage = new ManagedLayoutStorage(store);
  const first = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("first"), name: "view" });
  const last = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("last"), name: "view" });
  await storage.put("local", first, { activate: true });
  await storage.putLayouts("local", [last], { activate: true, replaceIds: [first.id] });
  expect(await storage.get("local", first.id)).toBeUndefined();
  expect(store.get("profile", "user")).toEqual({ currentLayoutId: last.id });
  const duplicate = LayoutBuilder.layout({ id: LayoutBuilder.layoutId("existing"), name: "view" });
  await storage.put("team", duplicate);
  await storage.importLayouts({ fromNamespace: "local", toNamespace: "team" });
  expect(await storage.list("local")).toHaveLength(0);
  expect(store.get("profile", "user")).toEqual({ currentLayoutId: duplicate.id });
  await storage.delete("team", duplicate.id);
  expect(await storage.list("team")).toEqual([]);
  expect(store.get("profile", "user")).toEqual({});
});
