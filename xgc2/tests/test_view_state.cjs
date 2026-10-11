// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EMPTY_VIEW, ViewStore, normalizeView, rejectViewFamily } = require("../launcher/view-state.cjs");
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

test("browsers cannot name the view family in a document request", () => {
  for (const request of [{ operation: "snapshot", keys: [{ family: "view", key: "desired" }] }, { operation: "snapshot", families: ["view"] },
    { operation: "batch", changes: [{ family: "profile", key: "user" }, { family: "view", key: "desired" }] }]) {
    assert.throws(() => rejectViewFamily(request), (error) => error.code === "permission_denied" && error.status === 403);
  }
  assert.doesNotThrow(() => rejectViewFamily({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }));
  assert.doesNotThrow(() => rejectViewFamily(undefined));
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

test("a write that lost a race with an unrelated document is read again, not replayed blindly", async (t) => {
  const { client, storage } = await startStorage(t);
  const store = new ViewStore(client);
  await store.load();
  // A page saves a layout between our read and our write.
  let raced = false;
  storage.state.beforeBatch = () => { if (!raced) { raced = true; storage.touch("profile", "user", { currentLayoutId: "x" }); } };
  const written = await store.set(full);
  assert.equal(raced, true);
  assert.equal(storage.state.calls.filter((call) => call.route === "/v1/batch").length, 2, "one retry after the token moved");
  assert.deepEqual(written.view, normalizeView(full));
  // A competing writer of the view itself is not retried over: it is a real conflict.
  storage.state.beforeBatch = () => { storage.touch("view", "desired", { ...EMPTY_VIEW, followRobot: "uav9" }); storage.state.beforeBatch = undefined; };
  await assert.rejects(store.set({ perspective: true }, { expectedRevision: store.state.revision }), (error) => error.code === "conflict");
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
