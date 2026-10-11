// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EMPTY_VIEW, ViewStore, normalizeView } = require("../launcher/view-state.cjs");
const { startStorage } = require("./storage_fixture.cjs");

const full = { layoutId: "camera-ar", followRobot: "uav1", perspective: true, visibleSurfaces: ["topics", "3d-tools"] };

test("a view is exactly four nullable fields in canonical form", () => {
  assert.deepEqual(normalizeView({}), EMPTY_VIEW);
  assert.deepEqual(normalizeView(full), { layoutId: "camera-ar", followRobot: "uav1", perspective: true, visibleSurfaces: ["3d-tools", "topics"] });
  assert.deepEqual(normalizeView({ perspective: false }).perspective, false);
  for (const bad of [null, [], "view", { unknown: 1 }, { layoutId: "" }, { layoutId: 3 }, { layoutId: "a\nb" }, { layoutId: "x".repeat(257) },
    { followRobot: "uav 1" }, { followRobot: "1uav" }, { followRobot: 7 }, { perspective: "yes" }, { visibleSurfaces: "topics" },
    { visibleSurfaces: ["nowhere"] }, { visibleSurfaces: ["topics", "topics"] }, { visibleSurfaces: ["topics", "layouts"] }]) {
    assert.throws(() => normalizeView(bad), (error) => error.code === "invalid_argument" && error.status === 400, JSON.stringify(bad));
  }
});

test("the view family has a scope of its own that pages cannot reach", async (t) => {
  const { client, storage } = await startStorage(t);
  const view = { operation: "snapshot", keys: [{ family: "view", key: "desired" }] };
  for (const request of [view, { operation: "snapshot", families: ["view"] },
    { operation: "batch", expected: { database_id: "x", schema: "x", revision: "0" }, requestId: "page-writes-view", changes: [{ family: "profile", key: "user", expectedVersion: "0", value: {} }, { family: "view", key: "desired", expectedVersion: "0", value: {} }] }]) {
    await assert.rejects(client.request(request), (error) => error.code === "permission_denied" && error.status === 403, JSON.stringify(request));
  }
  // The view scope holds the view and nothing else.
  for (const request of [{ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }, { operation: "snapshot", families: ["layouts"] }]) {
    await assert.rejects(client.requestView(request), (error) => error.code === "permission_denied" && error.status === 403, JSON.stringify(request));
  }
  assert.equal(storage.state.calls.length, 0, "a refused request never reaches the storage");
  assert.deepEqual((await client.requestView(view)).records.map((record) => record.missing), [true]);
  assert.deepEqual(storage.state.calls.map((call) => call.scope), ["view"]);
});

test("a client without a view scope cannot hold a view", async (t) => {
  const { client } = await startStorage(t, { withViewScope: false });
  await assert.rejects(client.requestView({ operation: "snapshot", keys: [{ family: "view", key: "desired" }] }), (error) => error.code === "unavailable" && error.status === 503);
  await assert.rejects(new ViewStore(client).load(), (error) => error.code === "unavailable");
});

test("the revision is the storage version: unset is 0, a write advances it, an identical view keeps it", async (t) => {
  const { client } = await startStorage(t);
  const store = new ViewStore(client);
  assert.deepEqual(await store.load(), { revision: "0", view: EMPTY_VIEW });
  const seen = [];
  store.subscribe((state) => seen.push(state));
  const first = await store.set(full);
  assert.equal(first.unchanged, false);
  assert.ok(BigInt(first.revision) > 0n);
  assert.deepEqual(first.view, normalizeView(full));
  assert.deepEqual(store.state, { revision: first.revision, view: normalizeView(full) });
  const same = await store.set(full);
  assert.deepEqual({ revision: same.revision, unchanged: same.unchanged }, { revision: first.revision, unchanged: true });
  const second = await store.set({ ...full, followRobot: "uav2" });
  assert.ok(BigInt(second.revision) > BigInt(first.revision));
  assert.deepEqual(seen.map((state) => state.revision), [first.revision, second.revision], "subscribers hear changes only");
  // A new store over the same storage sees the persisted view.
  const restarted = new ViewStore(client);
  assert.deepEqual(await restarted.load(), { revision: second.revision, view: normalizeView({ ...full, followRobot: "uav2" }) });
});

test("expectedRevision makes the write conditional and a stale one changes nothing", async (t) => {
  const { client, storage } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  const first = await store.set(full, { expectedRevision: "0" });
  await assert.rejects(store.set({ perspective: false }, { expectedRevision: "0" }), (error) => error.code === "conflict" && error.status === 409);
  assert.deepEqual(store.state, { revision: first.revision, view: normalizeView(full) });
  assert.equal(storage.document("view", "desired").version, BigInt(first.revision));
  const second = await store.set({ perspective: false }, { expectedRevision: first.revision });
  assert.ok(BigInt(second.revision) > BigInt(first.revision));
  await assert.rejects(store.set(full, { expectedRevision: 5 }), (error) => error.code === "invalid_argument");
  await assert.rejects(store.set(full, { expectedRevision: "01" }), (error) => error.code === "invalid_argument");
});

test("saves of the pages never touch the revision a view write depends on", async (t) => {
  const { client, storage } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  // A page saves its documents between our read and our write: the view scope does not notice.
  storage.state.beforeBatch = () => { storage.touch("profile", "user", { currentLayoutId: "x" }); storage.state.beforeBatch = undefined; };
  const written = await store.set(full);
  assert.equal(storage.state.calls.filter((call) => call.route === "/v1/batch").length, 1, "no retry: the pages' scope is not the view's scope");
  assert.deepEqual(written.view, normalizeView(full));
  assert.equal(storage.revision, 1n, "the pages' scope moved only by their own save");
  // And the other way round: a view write leaves the revision the pages are fenced by alone.
  const before = storage.revision;
  await store.set({ ...full, followRobot: "uav2" });
  assert.equal(storage.revision, before);
});

test("a write that lost a race with another writer of the view is read again, not replayed blindly", async (t) => {
  const { client, storage } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  let raced = false;
  storage.state.beforeBatch = () => { if (!raced) { raced = true; storage.touch("view", "desired", { ...EMPTY_VIEW, followRobot: "uav9" }); } };
  // An unconditional write re-reads and replaces the competitor's view.
  const written = await store.set(full);
  assert.equal(raced, true);
  assert.equal(storage.state.calls.filter((call) => call.route === "/v1/batch").length, 2, "one retry after the revision moved");
  assert.deepEqual(written.view, normalizeView(full));
  // A conditional write does not: it is a real conflict, and the competitor's view stays.
  storage.state.beforeBatch = () => { storage.touch("view", "desired", { ...EMPTY_VIEW, followRobot: "uav9" }); storage.state.beforeBatch = undefined; };
  await assert.rejects(store.set({ perspective: true }, { expectedRevision: store.state.revision }), (error) => error.code === "conflict");
  assert.equal(store.state.view.followRobot, "uav9");
});

test("an uncertain write is settled by reading the storage", async (t) => {
  const { client, storage } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  storage.state.failNextBatch = { commit: true, destroy: true };
  await assert.rejects(store.set(full), (error) => error.outcome === "outcome_unknown");
  assert.deepEqual(store.state.view, normalizeView(full), "the committed write is what the store now reports");
  assert.equal(store.state.revision, String(storage.document("view", "desired").version));
  storage.state.failNextBatch = { commit: false, status: 503 };
  await assert.rejects(store.set({ perspective: false }), (error) => error.code === "unavailable");
  assert.deepEqual(store.state.view, normalizeView(full));
});

test("a stored document of another schema reads as unset and the next write replaces it", async (t) => {
  const { client, storage } = await startStorage(t);
  storage.touch("view", "desired", { layoutId: 17, surprise: true });
  const store = new ViewStore(client);
  const loaded = await store.load();
  assert.deepEqual(loaded.view, EMPTY_VIEW);
  assert.notEqual(loaded.revision, "0");
  const replaced = await store.set(EMPTY_VIEW);
  assert.equal(replaced.unchanged, false, "an unreadable document is replaced even by an empty view");
  assert.deepEqual(storage.document("view", "desired").data.value, EMPTY_VIEW);
});

test("concurrent writes are serialized and the last one wins", async (t) => {
  const { client } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  const results = await Promise.all([store.set({ followRobot: "uav1" }), store.set({ followRobot: "uav2" }), store.set({ followRobot: "uav3" })]);
  assert.deepEqual(results.map((result) => result.view.followRobot), ["uav1", "uav2", "uav3"]);
  assert.ok(BigInt(results[0].revision) < BigInt(results[1].revision) && BigInt(results[1].revision) < BigInt(results[2].revision));
  assert.equal(store.state.view.followRobot, "uav3");
});
