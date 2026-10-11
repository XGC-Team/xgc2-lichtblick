// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const test = require("node:test");
const { createManagedDomainClientFromInput } = require("../launcher/managed-storage.cjs");
const { ViewStore, normalizeView, EMPTY_VIEW } = require("../launcher/view-state.cjs");
const { domainInput, privateDirectory } = require("./input_fixture.cjs");

const scope = { namespace: "lichtblick", user: "view", workspace: "native" };
const credential = "native-view-fixture-owner-grant-32-bytes";
const view = { layoutId: "camera-ar", followRobot: "uav1", perspective: true, visibleSurfaces: ["3d-tools", "topics"] };

test("the desired view keeps its revision and CAS semantics on the actual storage provider across a restart", { timeout: 60000 }, async (t) => {
  const binary = process.env.XGC2_STORAGE_TEST_BINARY;
  assert.ok(binary, "set XGC2_STORAGE_TEST_BINARY to the built formal storage provider");
  const root = privateDirectory("lichtblick-view-native-");
  const assets = path.join(root, "assets"); await fs.mkdir(assets, { mode: 0o700 });
  const refs = path.join(root, "refs.json");
  const grants = path.join(root, "grants.json");
  await fs.writeFile(grants, JSON.stringify([{ ...scope, token: credential }]), { mode: 0o600 });
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const owner = child;
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGTERM");
    await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw Error("storage owner did not drain"); })]);
  }
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await stop(); await fs.rm(root, { recursive: true, force: true }); });
  async function start(create) {
    await fs.rm(refs, { force: true });
    child = spawn(binary, ["--db", path.join(root, "storage.db"), "--manifest", path.resolve(__dirname, "../contracts/storage-manifest.json"), "--grants", grants,
      "--http-socket", path.join(root, "rpc.sock"), "--target-id", "fixture", "--ref-out", refs, ...(create ? ["--create"] : [])], { stdio: ["ignore", "ignore", "pipe"] });
    let failure = ""; child.stderr.on("data", (chunk) => { failure += chunk.toString(); });
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw Error(`storage provider failed: ${failure}`);
      try { return JSON.parse(await fs.readFile(refs, "utf8"))[0]; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(20);
    }
    throw Error("storage provider did not publish a reference");
  }
  function product(reference) {
    const client = createManagedDomainClientFromInput(domainInput(reference, scope, assets, credential));
    clients.push(client);
    return client;
  }
  const firstClient = product(await start(true));
  const store = new ViewStore(firstClient);
  assert.deepEqual(await store.load(), { revision: "0", view: EMPTY_VIEW });
  const first = await store.set(view, { expectedRevision: "0" });
  assert.ok(BigInt(first.revision) > 0n);
  // A page saves its own documents: the database token moves, the view write still lands.
  const profile = await firstClient.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] });
  await firstClient.request({ operation: "batch", expected: profile.token, requestId: "page-profile-1", changes: [{ family: "profile", key: "user", expectedVersion: "0", value: { currentLayoutId: "a" } }] });
  const second = await store.set({ ...view, perspective: false });
  assert.ok(BigInt(second.revision) > BigInt(first.revision));
  await assert.rejects(store.set(view, { expectedRevision: first.revision }), (error) => error.code === "conflict");
  assert.equal((await store.set({ ...view, perspective: false })).unchanged, true);
  // A second owner of the same scope (it only reads assets) races for the same document.
  const reference = await readReference(refs);
  const rivalClient = createManagedDomainClientFromInput(domainInput(reference, scope, assets, credential, "read-only"));
  clients.push(rivalClient);
  const rival = new ViewStore(rivalClient);
  await rival.load();
  const mine = await store.set({ ...view, followRobot: "uav2" }, { expectedRevision: second.revision });
  await assert.rejects(rival.set({ ...view, followRobot: "uav3" }, { expectedRevision: second.revision }), (error) => error.code === "conflict");
  const theirs = await rival.set({ ...view, followRobot: "uav3" });
  assert.ok(BigInt(theirs.revision) > BigInt(mine.revision));
  await firstClient.close();
  await stop();
  const restarted = new ViewStore(product(await start(false)));
  assert.deepEqual(await restarted.load(), { revision: theirs.revision, view: normalizeView({ ...view, followRobot: "uav3" }) });
  const third = await restarted.set({ layoutId: null }, { expectedRevision: theirs.revision });
  assert.ok(BigInt(third.revision) > BigInt(theirs.revision));
  assert.deepEqual(third.view, EMPTY_VIEW);
});

async function readReference(refs) { return JSON.parse(await fs.readFile(refs, "utf8"))[0]; }
