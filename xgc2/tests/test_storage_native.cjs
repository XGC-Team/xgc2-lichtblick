// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { buildSync } = require("esbuild");
const test = require("node:test");
const { createDomainFixture } = require("./tls_fixture.cjs");
const { createManagedDomainClientFromBootstrap, createManagedPolicy } = require("../launcher/managed-storage.cjs");

test("actual managed document client restores camera after browser replacement and storage restart; competing CAS cannot overwrite", async (t) => {
  const binary = process.env.XGC2_STORAGE_TEST_BINARY;
  assert.ok(binary, "set XGC2_STORAGE_TEST_BINARY to the built formal storage provider");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s8-native-"));
  const assets = path.join(root, "assets"); await fs.mkdir(assets, { mode: 0o700 });
  const db = path.join(root, "storage.db");
  const socket = path.join(root, "rpc.sock");
  const refs = path.join(root, "refs.json");
  const grants = path.join(root, "grants.json");
  const ownerGrant = "native-fixture-owner-grant-32-bytes-long";
  const scope = { namespace: "lichtblick", user: "fixture", workspace: "lab" };
  await fs.writeFile(grants, JSON.stringify([{ ...scope, token: ownerGrant }]), { mode: 0o600 });
  const manifest = path.resolve(__dirname, "../contracts/storage-manifest.json");
  let child;
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const owner = child;
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGTERM");
    await Promise.race([exited, delay(5000, undefined, { ref: false }).then(() => { throw Error("storage owner did not drain"); })]);
  }
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await stop(); await fs.rm(root, { recursive: true, force: true });
  });
  async function start(create) {
    await fs.unlink(refs).catch((error) => { if (error.code !== "ENOENT") throw error; });
    child = spawn(binary, ["--db", db, "--manifest", manifest, "--grants", grants, "--http-socket", socket, "--target-id", "fixture", "--ref-out", refs, ...(create ? ["--create"] : [])], { stdio: ["ignore", "ignore", "pipe"] });
    let failure = ""; child.stderr.on("data", (chunk) => { failure += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw Error(`storage provider failed: ${failure}`);
      try {
        const all = JSON.parse(await fs.readFile(refs, "utf8"));
        assert.equal(all.length, 1);
        return all[0];
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(20);
    }
    throw Error("storage provider did not publish a reference");
  }
  function product(ref) {
    const client = createManagedDomainClientFromBootstrap(createDomainFixture(ref, scope, assets, ownerGrant), createManagedPolicy({}));
    clients.push(client); return client;
  }
  const moduleFile = path.join(root, "document-client.cjs");
  buildSync({ entryPoints: [path.resolve(__dirname, "../../packages/suite-base/src/services/persistence/ManagedDocumentStore.ts")], bundle: true, outfile: moduleFile, platform: "node", format: "cjs", target: "node22" });
  const { ManagedDocumentStore, ManagedRequestError } = require(moduleFile);
  const transport = (client) => async (request) => {
    try { return await client.request(request); }
    catch (error) { throw new ManagedRequestError(error.message, error.code, error.outcome, error.requestId); }
  };
  const firstRef = await start(true);
  const firstClient = product(firstRef);
  const first = new ManagedDocumentStore(transport(firstClient)); await first.bootstrap();
  const second = new ManagedDocumentStore(transport(firstClient)); await second.bootstrap();
  const viewKey = JSON.stringify(["local", "camera-view"]);
  const view = { id: "camera-view", name: "Camera", permission: "CREATOR_WRITE", baseline: { data: { configById: {} } }, working: { data: { configById: { "3D!fixture": { cameraState: { distance: 37, phi: 0.7, target: [2, 3, 4] } } } } } };
  const receipt = await first.commit([{ family: "layouts", key: viewKey, value: view }, { family: "profile", key: "user", value: { currentLayoutId: "camera-view" } }]);
  assert.equal(receipt.durability, "sqlite-full"); assert.equal(receipt.versions.length, 2);
  assert.equal(first.state.pending, 0);
  await assert.rejects(second.commit([{ family: "profile", key: "user", value: { currentLayoutId: "stale" } }]), (error) => error.code === "conflict");
  assert.equal(second.get("profile", "user"), undefined);
  // A new frontend instance has no localStorage, IndexedDB or former memory.
  const freshBrowser = new ManagedDocumentStore(transport(firstClient)); await freshBrowser.bootstrap();
  assert.deepEqual(freshBrowser.get("layouts", viewKey).working.data.configById["3D!fixture"].cameraState, view.working.data.configById["3D!fixture"].cameraState);
  assert.equal(freshBrowser.get("profile", "user").currentLayoutId, "camera-view");
  await firstClient.close();
  await stop();
  const secondRef = await start(false);
  assert.notEqual(secondRef.instance_id, firstRef.instance_id);
  const restartedClient = product(secondRef);
  const restarted = new ManagedDocumentStore(transport(restartedClient)); await restarted.bootstrap();
  assert.equal(restarted.get("profile", "user").currentLayoutId, "camera-view");
  assert.deepEqual(restarted.get("layouts", viewKey).working.data.configById["3D!fixture"].cameraState, view.working.data.configById["3D!fixture"].cameraState);
  const durable = await restartedClient.request({ operation: "receipt", requestId: receipt.requestId });
  assert.equal(durable.requestId, receipt.requestId); assert.equal(durable.durability, "sqlite-full");
});
