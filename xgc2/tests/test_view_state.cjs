// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EMPTY_VIEW, ViewStore, normalizeView } = require("../launcher/view-state.cjs");

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

test("each changed statement advances the decimal revision exactly once; equal views change nothing", async () => {
  const store = new ViewStore();
  assert.deepEqual(store.state, { revision: "0", view: EMPTY_VIEW });
  const seen = [];
  const unsubscribe = store.subscribe((state) => seen.push(state));
  const first = await store.set(full);
  assert.deepEqual(first, { revision: "1", view: normalizeView(full), unchanged: false });
  const same = await store.set({ ...full, visibleSurfaces: ["3d-tools", "topics"] });
  assert.deepEqual(same, { ...first, unchanged: true });
  const second = await store.set({ ...full, followRobot: "uav2" });
  assert.equal(second.revision, "2");
  assert.deepEqual(seen.map((state) => state.revision), ["1", "2"]);
  unsubscribe();
  await store.set({ perspective: false });
  assert.equal(seen.length, 2);
  assert.deepEqual(new ViewStore().state, { revision: "0", view: EMPTY_VIEW }, "a new launcher has no retained state");
});

test("the first empty statement has a revision; another equal empty statement is unchanged", async () => {
  const store = new ViewStore();
  assert.deepEqual(await store.set({}), { revision: "1", view: EMPTY_VIEW, unchanged: false });
  assert.deepEqual(await store.set(EMPTY_VIEW), { revision: "1", view: EMPTY_VIEW, unchanged: true });
});

test("expectedRevision is checked even for equal views and a rejected write changes nothing", async () => {
  const store = new ViewStore();
  const first = await store.set(full, { expectedRevision: "0" });
  await assert.rejects(store.set({ perspective: false }, { expectedRevision: "0" }), (error) => error.code === "conflict" && error.status === 409);
  await assert.rejects(store.set(full, { expectedRevision: "0" }), (error) => error.code === "conflict");
  assert.deepEqual(store.state, { revision: first.revision, view: normalizeView(full) });
  for (const expectedRevision of [5, "01", "-1", "", null])
    await assert.rejects(store.set(full, { expectedRevision }), (error) => error.code === "invalid_argument");
  const second = await store.set({ perspective: false }, { expectedRevision: "1" });
  assert.equal(second.revision, "2", "a rejected write does not poison the queue");
});

test("concurrent writes serialize, and competing conditional writes cannot both apply", async () => {
  const store = new ViewStore();
  const results = await Promise.all([store.set({ followRobot: "uav1" }), store.set({ followRobot: "uav2" }), store.set({ followRobot: "uav3" })]);
  assert.deepEqual(results.map((result) => result.revision), ["1", "2", "3"]);
  assert.equal(store.state.view.followRobot, "uav3");
  const raced = await Promise.allSettled([store.set({ followRobot: "uav4" }, { expectedRevision: "3" }), store.set({ followRobot: "uav5" }, { expectedRevision: "3" })]);
  assert.equal(raced[0].status, "fulfilled");
  assert.equal(raced[1].reason.code, "conflict");
  assert.equal(store.state.revision, "4");
  assert.equal(store.state.view.followRobot, "uav4");
});

test("a caller cannot mutate a stated view without advancing its revision", async () => {
  const store = new ViewStore();
  const input = structuredClone(full);
  await store.set(input);
  input.visibleSurfaces.pop();
  assert.deepEqual(store.state.view, normalizeView(full));
  assert.throws(() => { store.state.revision = "99"; }, TypeError);
  assert.throws(() => { store.state.view.followRobot = "uav9"; }, TypeError);
  assert.throws(() => store.state.view.visibleSurfaces.pop(), TypeError);
});
