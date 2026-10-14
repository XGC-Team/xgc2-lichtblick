// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CoreUiDocumentClient, encodeCoreUiKey } from "./CoreUiDocumentClient";
import { CORE_UI_DOCUMENT_FAMILIES, CoreUiDocumentStore } from "./CoreUiDocumentStore";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

it("bootstraps every web family, following every include=body page and retaining revisions", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  for (let index = 0; index < 5; index++) {
    await client.put("configuration", `setting-${index}`, index, "0");
  }
  await client.put("workspace", "ui", { sidebars: {} }, "0");
  server.requests.length = 0;
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  expect(store.records("configuration")).toHaveLength(5);
  expect(store.records("configuration")[0]?.version).toBe("1");
  expect(store.get("workspace", "ui")).toEqual({ sidebars: {} });
  expect(new Set(server.requests.map(({ url }) => url.pathname.split("/").at(-1)))).toEqual(
    new Set(CORE_UI_DOCUMENT_FAMILIES),
  );
  const pages = server.requests.filter(({ url }) => url.pathname.endsWith("/configuration"));
  expect(pages.map(({ url }) => url.searchParams.get("after"))).toEqual([
    "",
    encodeCoreUiKey("setting-1"),
    encodeCoreUiKey("setting-3"),
  ]);
  expect(server.requests.every(({ url }) => url.searchParams.get("include") === "body")).toBe(true);
  await expect(store.bootstrap(["desktop"])).rejects.toThrow("families");
});

it("preserves the loaded map on a failed reload and never enables an incomplete first load", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  await client.put("profile", "user", { name: "operator" }, "0");
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  server.unavailable = true;
  await expect(store.bootstrap()).rejects.toMatchObject({ code: "unavailable" });
  expect(store.get("profile", "user")).toEqual({ name: "operator" });
  const unloaded = new CoreUiDocumentStore(client);
  await expect(unloaded.bootstrap()).rejects.toMatchObject({ code: "unavailable" });
  expect(() => unloaded.get("profile", "user")).toThrow("has not loaded");
  await expect(unloaded.commit([{ family: "profile", key: "user", value: {} }])).rejects.toThrow(
    "has not loaded",
  );
});

it("refuses saves and concurrent reloads while list pages are loading", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const list = jest.spyOn(client, "list").mockImplementation(async () => {
    await waiting;
    return { items: [], next: "" };
  });
  const loading = store.bootstrap();
  await expect(store.commit([{ family: "profile", key: "user", value: {} }])).rejects.toThrow(
    "reloading",
  );
  await expect(store.bootstrap()).rejects.toThrow("reload pending");
  finish();
  await loading;
  list.mockRestore();
  await store.commit([{ family: "profile", key: "user", value: {} }]);
  expect(store.state.pending).toBe(0);
});

it("rejects malformed documents and repeated cursors without enabling saves", async () => {
  const client = new CoreUiDocumentClient(
    async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "k-user",
              kind: "profile",
              revision: 1,
              updatedAt: "2026-10-11T00:00:00Z",
              size: 25,
              body: { key: "user", value: {} },
            },
          ],
          next: "k-user",
        }),
      ),
  );
  const store = new CoreUiDocumentStore(client);
  await expect(store.bootstrap(["profile"])).rejects.toThrow("Duplicate");
  expect(() => store.records("profile")).toThrow("has not loaded");
  const mismatch = new CoreUiDocumentStore(
    new CoreUiDocumentClient(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: "k-other",
                kind: "profile",
                revision: 1,
                updatedAt: "2026-10-11T00:00:00Z",
                size: 25,
                body: { key: "user", value: {} },
              },
            ],
            next: "",
          }),
        ),
    ),
  );
  await expect(mismatch.bootstrap(["profile"])).rejects.toThrow("identity");
});

it("keeps primitive, array and object values inside JSON object bodies and clones reads", async () => {
  const server = new CoreUiDocumentServer();
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await store.bootstrap();
  const values = ["en", false, 0, [1, 2], { sidebars: {} }];
  await store.commit(
    values.map((value, index) => ({ family: "workspace", key: String(index), value })),
  );
  const fresh = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await fresh.bootstrap();
  expect(values.map((_, index) => fresh.get("workspace", String(index)))).toEqual(values);
  const copy = fresh.get<{ sidebars: { left?: string } }>("workspace", "4")!;
  copy.sidebars.left = "topics";
  expect(fresh.get("workspace", "4")).toEqual({ sidebars: {} });
});

it("serializes queued edits using the revision acknowledged by the previous edit", async () => {
  const server = new CoreUiDocumentServer();
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await store.bootstrap();
  const first = store.commit([{ family: "configuration", key: "rosPackagePath", value: "/" }]);
  const second = store.commit([{ family: "configuration", key: "rosPackagePath", value: "/h" }]);
  expect(store.state.pending).toBe(2);
  await Promise.all([first, second]);
  expect(store.get("configuration", "rosPackagePath")).toBe("/h");
  expect(
    server.requests
      .filter(({ options }) => options?.method === "PUT")
      .map(({ url }) => url.searchParams.get("expectedRevision")),
  ).toEqual(["0", "1"]);
  expect(store.state).toEqual({ pending: 0 });
});

it("evaluates queued profile merges after earlier writes have finished", async () => {
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(new CoreUiDocumentServer().fetch));
  await store.bootstrap();
  const first = store.commit([
    { family: "profile", key: "user", value: { onboarding: { done: true } } },
  ]);
  const second = store.commit(() => [
    {
      family: "profile",
      key: "user",
      value: { ...store.get<object>("profile", "user"), currentLayoutId: "new" },
    },
  ]);
  await Promise.all([first, second]);
  expect(store.get("profile", "user")).toEqual({
    onboarding: { done: true },
    currentLayoutId: "new",
  });
});

it("validates the entire plan before writing and leaves validation errors retryable", async () => {
  const server = new CoreUiDocumentServer();
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await store.bootstrap();
  await expect(
    store.commit([
      { family: "workspace", key: "ui", value: {} },
      { family: "layouts", key: "old", value: { id: "old", data: {} } },
    ]),
  ).rejects.toThrow("Invalid current managed layout");
  await expect(
    store.commit([{ family: "workspace", key: "large", value: "a".repeat(65537) }]),
  ).rejects.toThrow("size limit");
  await expect(
    store.commit([{ family: "workspace", key: "a".repeat(127), value: {} }]),
  ).rejects.toThrow("128");
  await expect(store.commit([{ family: "desktop", key: "native", value: {} }])).rejects.toThrow(
    "Invalid managed batch",
  );
  expect(server.requests.filter(({ options }) => options?.method === "PUT")).toHaveLength(0);
  await expect(store.commit(() => [{ family: "layouts", key: "old", value: {} }])).rejects.toThrow(
    "Invalid current",
  );
  await store.commit([{ family: "workspace", key: "ui", value: {} }]);
  expect(store.state.error).toBeUndefined();
});

it("a conflicting create is refused, rereads the newer value, and allows a later explicit edit", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const first = new CoreUiDocumentStore(client);
  const second = new CoreUiDocumentStore(client);
  await first.bootstrap();
  await second.bootstrap();
  await first.commit([{ family: "configuration", key: "language", value: "en" }]);
  await expect(
    second.commit([{ family: "configuration", key: "language", value: "de" }]),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(second.get("configuration", "language")).toBe("en");
  expect(second.state).toMatchObject({ pending: 0, error: { code: "conflict" } });
  await second.commit([{ family: "configuration", key: "language", value: "de" }]);
  expect(second.get("configuration", "language")).toBe("de");
});

it("competing edits to independent documents do not have a global revision conflict", async () => {
  const client = new CoreUiDocumentClient(new CoreUiDocumentServer().fetch);
  const first = new CoreUiDocumentStore(client);
  const second = new CoreUiDocumentStore(client);
  await first.bootstrap();
  await second.bootstrap();
  await first.commit([{ family: "configuration", key: "language", value: "en" }]);
  await second.commit([{ family: "configuration", key: "timezone", value: "system" }]);
  expect(second.state.error).toBeUndefined();
});

it("stops a partial batch at its conflict, keeps earlier writes, rereads documents, and refuses queued writes", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  await client.put("configuration", "language", "en", "0");
  server.requests.length = 0;
  const batch = store.commit([
    { family: "workspace", key: "ui", value: { sidebars: {} } },
    { family: "configuration", key: "language", value: "de" },
    { family: "profile", key: "user", value: { currentLayoutId: "new" } },
  ]);
  const queued = store.commit([{ family: "workspace", key: "recents", value: [] }]);
  const results = await Promise.allSettled([batch, queued]);
  expect(results.every((result) => result.status === "rejected")).toBe(true);
  expect(store.get("workspace", "ui")).toEqual({ sidebars: {} });
  expect(store.get("configuration", "language")).toBe("en");
  expect(store.get("profile", "user")).toBeUndefined();
  expect(server.requests.filter(({ options }) => options?.method === "PUT")).toHaveLength(2);
  expect(server.requests.filter(({ options }) => options?.method == undefined)).toHaveLength(3);
  expect(store.state.pending).toBe(0);
  expect(store.state.error).toMatchObject({ code: "conflict" });
  const fresh = new CoreUiDocumentStore(client);
  await fresh.bootstrap();
  expect(fresh.get("workspace", "ui")).toEqual({ sidebars: {} });
  expect(fresh.get("workspace", "recents")).toBeUndefined();
});

it("rereads a saved document after a lost response without replaying or claiming batch success", async () => {
  const server = new CoreUiDocumentServer();
  const store = new CoreUiDocumentStore(new CoreUiDocumentClient(server.fetch));
  await store.bootstrap();
  server.loseNextWriteResponse = true;
  await expect(
    store.commit([{ family: "workspace", key: "ui", value: { sidebars: {} } }]),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(store.get("workspace", "ui")).toEqual({ sidebars: {} });
  expect(store.state.error).toBeDefined();
  expect(server.requests.filter(({ options }) => options?.method === "PUT")).toHaveLength(1);
});

it("surfaces failed recovery and continues to refuse writes", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(async (input, options) => {
    const response = await server.fetch(input, options);
    if (options?.method === "PUT") {
      server.unavailable = true;
    }
    return response;
  });
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  server.rejectNextWrite = { status: 409, code: "conflict" };
  await expect(store.commit([{ family: "workspace", key: "ui", value: {} }])).rejects.toMatchObject(
    { code: "conflict", message: expect.stringContaining("reload failed") },
  );
  await expect(store.commit([{ family: "profile", key: "user", value: {} }])).rejects.toThrow(
    "reload failed",
  );
});

it.each([
  [413, "too_large"],
  [429, "quota_exceeded"],
  [503, "unavailable"],
])("retains the loaded document after HTTP %i and records the failed save", async (status, code) => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  await client.put("configuration", "language", "en", "0");
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  server.rejectNextWrite = { status, code };
  await expect(
    store.commit([{ family: "configuration", key: "language", value: "de" }]),
  ).rejects.toMatchObject({ code });
  expect(store.get("configuration", "language")).toBe("en");
  expect(store.state.error).toMatchObject({ code });
});

it("deletes with CAS and accepts an already absent document even with a stale revision", async () => {
  const client = new CoreUiDocumentClient(new CoreUiDocumentServer().fetch);
  const store = new CoreUiDocumentStore(client);
  await store.bootstrap();
  await store.commit([{ family: "workspace", key: "ui", value: {} }]);
  await client.delete("workspace", "ui", "1");
  await store.commit([{ family: "workspace", key: "ui", delete: true }]);
  expect(store.records("workspace")).toEqual([]);
  await store.commit([{ family: "workspace", key: "ui", value: {} }]);
  expect(store.records("workspace")[0]?.version).toBe("3");
});
