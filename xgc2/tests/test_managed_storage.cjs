// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const test = require("node:test");
const { domainInput } = require("./input_fixture.cjs");
const { createHTTPHost } = require("@xgc2/xrpc");
const { createManagedDomainClient, createManagedDomainClientFromInput } = require("../launcher/managed-storage.cjs");
const { buildRequestListener, parseWsUrl } = require("../launcher/xgc2-lichtblick-web.js");

const scope = { namespace: "lichtblick", user: "alice", workspace: "lab" };
const token = { database_id: "fixture-db", schema: "lichtblick.persistence.v1", revision: "9007199254740993" };
async function fixture(t, call = async () => { throw Error("unexpected storage call"); }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol8-managed-"));
  const client = createManagedDomainClient({ scope, assetRoot: root, call });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.ready;
  return { root, client };
}
function receipt(body) {
  return { token, request_id: body.request_id, durability: "sqlite-full", versions: body.mutations.map((m) => ({ collection: "documents", key: m.key, version: token.revision })) };
}
test("layout and selected pointer retain one exact scope, token, CAS batch and large string revisions", async (t) => {
  let observed;
  const { client } = await fixture(t, async (route, body, options) => {
    observed = { route, body, options }; return receipt(body);
  });
  const changes = [
    { family: "layouts", key: "local/view", expectedVersion: "9007199254740992", value: { working: { cameraState: { distance: 42 } } } },
    { family: "profile", key: "user", expectedVersion: "2", value: { currentLayoutId: "view" } },
  ];
  const result = await client.request({ operation: "batch", expected: token, requestId: "atomic-view", changes });
  assert.equal(observed.route, "/v1/batch");
  assert.deepEqual(observed.body.scope, scope);
  assert.deepEqual(observed.body.expected, token);
  assert.equal(observed.body.mutations.length, 2);
  assert.equal(observed.body.mutations[0].expected_version, "9007199254740992");
  assert.equal(observed.options.requestId, "atomic-view");
  assert.equal(result.versions[0].version, "9007199254740993");
});
test("browser scope/path/collection, duplicate writes and preference oversize never reach storage", async (t) => {
  let calls = 0;
  const { client } = await fixture(t, async () => { calls++; });
  await assert.rejects(client.request({ operation: "snapshot", scope: { user: "bob" }, keys: [{ family: "profile", key: "user" }] }), /undeclared/);
  await assert.rejects(client.request({ operation: "snapshot", keys: [{ family: "sql", key: "SELECT" }] }), /family/);
  const write = { family: "profile", key: "user", expectedVersion: "0", value: {} };
  await assert.rejects(client.request({ operation: "batch", expected: token, requestId: "duplicate", changes: [write, write] }), /duplicate/);
  await assert.rejects(client.request({ operation: "batch", expected: token, requestId: "large", changes: [{ ...write, value: { text: "x".repeat(65536) } }] }), /quota/);
  assert.equal(calls, 0);
});
test("missing/tombstone snapshots preserve versions and pin family pages", async (t) => {
  const { client } = await fixture(t, async (route, body) => {
    assert.equal(route, "/v1/snapshot"); assert.deepEqual(body.at, token);
    return { token, results: [{ collection: "documents", records: [
      { key: "layouts:local/old", version: "17", deleted: true },
      { key: "profile:user", version: "0", missing: true },
    ], next_after: "layouts:local/old" }] };
  });
  const result = await client.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }], at: token });
  assert.equal(result.records[0].version, "17"); assert.equal(result.records[0].deleted, true);
  assert.equal(result.records[1].missing, true); assert.equal(result.records[1].version, "0");
});
test("a false durability or mismatched receipt cannot become a saved value", async (t) => {
  const { client } = await fixture(t, async () => ({ token, request_id: "other", durability: "sqlite-full", versions: [] }));
  await assert.rejects(client.request({ operation: "receipt", requestId: "mine" }), /identity mismatch/);
  client.call = async () => ({ token, request_id: "mine", durability: "memory", versions: [] });
  await assert.rejects(client.request({ operation: "receipt", requestId: "mine" }), /durable receipt/);
  await assert.rejects(client.request({ operation: "batch", expected: token, requestId: "submitted", changes: [{ family: "profile", key: "user", expectedVersion: "0", value: {} }] }), (error) => error.outcome === "outcome_unknown" && error.requestId === "submitted");
});
test("immutable archives survive client restart and quota rejection without replacing the previous version", async (t) => {
  const { client, root } = await fixture(t);
  const bytes = Buffer.from("first installed archive");
  const asset = await client.publish(bytes, { id: "publisher.camera", version: "1.0.0" });
  client.maxAssets = 1;
  await assert.rejects(client.publish(Buffer.from("replacement"), { id: "publisher.camera", version: "2.0.0" }), /quota/);
  assert.deepEqual(Buffer.from(await client.load(asset)), bytes);
  await client.close();
  const reopened = createManagedDomainClient({ scope, assetRoot: root, call: client.call });
  await reopened.ready;
  assert.deepEqual(Buffer.from(await reopened.load(asset)), bytes);
  assert.equal(reopened.assetCount, 1);
  assert.match(asset.asset_id, /^publisher\.camera_1\.0\.0_/);
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.endsWith(".foxe")), [`${asset.asset_id}.foxe`]);
  await reopened.close();
});
test("archives reject traversal, digest tampering and symlink substitution", async (t) => {
  const { client, root } = await fixture(t);
  const asset = await client.publish(Buffer.from("archive"), { id: "camera", version: "1" });
  await assert.rejects(client.load({ ...asset, asset_id: "../outside" }), /reference/);
  await assert.rejects(client.load({ ...asset, sha256: "0".repeat(64) }), /digest/);
  const file = path.join(root, `${asset.asset_id}.foxe`);
  await fs.unlink(file); await fs.symlink(path.join(root, "outside"), file);
  await assert.rejects(client.load(asset), (error) => error.code === "ELOOP");
});
test("actual browser gateway rejects cross-origin and undeclared schema while serving a durable receipt", async (t) => {
  const { client } = await fixture(t, async (_route, body) => receipt(body));
  const runtime = createHTTPHost(buildRequestListener(parseWsUrl("ws://127.0.0.1:8765"), "/viewer", "", {}, {}, client, (origin) => origin === "http://studio.test"), { maxInFlight: 2 });
  runtime.server.listen(0, "127.0.0.1");
  await new Promise((resolve) => runtime.server.once("listening", resolve));
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}/viewer/xgc2/storage`;
  const request = { operation: "batch", expected: token, requestId: "from-browser", changes: [{ family: "profile", key: "user", expectedVersion: "0", value: {} }] };
  let response = await fetch(base, { method: "POST", headers: { Origin: "http://evil.test", "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(response.status, 403);
  response = await fetch(base, { method: "POST", headers: { Origin: "http://studio.test", "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(response.status, 200); assert.equal((await response.json()).durability, "sqlite-full");
  response = await fetch(base, { method: "POST", headers: { Origin: "http://studio.test", "Content-Type": "application/json" }, body: JSON.stringify({ ...request, scope }) });
  assert.equal(response.status, 400);
});
test("real SDK UDS client supplies instance binding and credential, preserves a storage conflict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sol8-managed-uds-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "storage.sock");
  // Native test peer only; a deployed storage provider uses the formal Go
  // host and its Unix lease. This fixture tests the client's wire behavior.
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${"g".repeat(32)}`);
    assert.equal(request.headers["x-xrpc-instance-id"], "storage-fixture");
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.deepEqual(body.scope, scope);
    response.setHeader("X-Xrpc-Instance-ID", "storage-fixture");
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "conflict", message: "stale revision" } }));
  });
  server.listen(socket); await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const reference = { target_id: "fixture", service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: "storage-fixture", profile: "http.v1", endpoint: { kind: "unix", address: socket } };
  const client = createManagedDomainClientFromInput(domainInput(reference, scope, root, "g".repeat(32)));
  // The grant directory and UDS fixture intentionally share a temporary root;
  // bind only after the product has inventoried its asset grant.
  await assert.rejects(client.ready, /undeclared entry/);
  const assetRoot = path.join(root, "assets"); await fs.mkdir(assetRoot, { mode: 0o700 });
  const configured = createManagedDomainClientFromInput(domainInput(reference, scope, assetRoot, "g".repeat(32)));
  await configured.ready;
  t.after(() => configured.close()); t.after(() => client.close());
  await assert.rejects(configured.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }), (error) => error.code === "conflict" && error.status === 409);
});

test("domain close fences new document calls and holds the asset lease until an admitted storage call returns", async (t) => {
  let release; let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const { client, root } = await fixture(t, async () => {
    enter(); await blocked;
    return { token, results: [{ collection: "documents", records: [{ key: "profile:user", version: "0", missing: true }] }] };
  });
  const reading = client.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] });
  await entered;
  let closed = false;
  const closing = client.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(client.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }), (error) => error.code === "unavailable");
  const contender = createManagedDomainClient({ scope, assetRoot: root, call: client.call });
  await assert.rejects(contender.ready, (error) => error.code === "conflict");
  await contender.close();
  release(); await reading; await closing;
  const next = createManagedDomainClient({ scope, assetRoot: root, call: client.call });
  await next.ready; await next.close();
});
