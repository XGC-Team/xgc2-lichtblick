// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");
const { createControlService } = require("../launcher/control-service.cjs");
const { createFakeStorage } = require("./fake_storage.cjs");
const { ViewStore, normalizeView } = require("../launcher/view-state.cjs");
const { rawCall, startControl } = require("./control_fixture.cjs");

const view = { layoutId: "camera-ar", followRobot: "uav1", perspective: true, visibleSurfaces: ["3d-tools"] };

test("describe is the unbound discovery call and reports readiness and facts", async (t) => {
  const { control, socketPath } = await startControl(t, { ready: false });
  let response = await rawCall(socketPath, "GET", "/v1/describe");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-xrpc-instance-id"], control.instanceId);
  assert.deepEqual(Object.keys(response.json).sort(), ["api_version", "facts", "instance_id", "ready", "service"]);
  assert.deepEqual({ service: response.json.service, api_version: response.json.api_version, instance_id: response.json.instance_id, ready: response.json.ready },
    { service: "xgc2.lichtblick.v1", api_version: "1", instance_id: control.instanceId, ready: false });
  assert.equal(response.json.facts.reason, "starting");
  assert.deepEqual(response.json.facts.capabilities, ["persistence.v1", "extensions.assets.v1", "view.v1"]);
  assert.equal(response.json.facts.view_revision, "0");
  control.markReady();
  response = await rawCall(socketPath, "GET", "/v1/describe");
  assert.equal(response.json.ready, true);
  assert.equal(response.json.facts.reason, undefined);
  assert.deepEqual({ storage: response.json.facts.storage, http_port: response.json.facts.http_port }, { storage: "ready", http_port: 18081 });
});

test("unbound wait_ready_ms holds the call until the launcher is ready, without polling", async (t) => {
  const { control, socketPath, call } = await startControl(t, { ready: false });
  const started = Date.now();
  let earlyResponse;
  const held = rawCall(socketPath, "GET", "/v1/describe?wait_ready_ms=5000").then((response) => { earlyResponse = response; return response; });
  await delay(150);
  assert.equal(earlyResponse?.status, undefined, "unbound readiness call must remain held before markReady");
  control.markReady();
  const response = await held;
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-xrpc-instance-id"], control.instanceId);
  assert.equal(response.json.ready, true);
  assert.ok(Date.now() - started >= 140 && Date.now() - started < 2000, `answered when ready, after ${Date.now() - started} ms`);
  t.diagnostic(`unbound readiness answered HTTP ${response.status} after ${Date.now() - started} ms`);
  // A wait that elapses answers with the current document.
  control.markNotReady("restarting");
  const waited = Date.now();
  const expired = await call("GET", "/v1/describe?wait_ready_ms=200");
  assert.equal(expired.json.ready, false);
  assert.equal(expired.json.facts.reason, "restarting");
  assert.ok(Date.now() - waited >= 190 && Date.now() - waited < 1500);
  // The wait never outlives the caller's own deadline.
  const bounded = await call("GET", "/v1/describe?wait_ready_ms=30000", { timeoutMs: 500 });
  assert.equal(bounded.status, 200);
  assert.equal(bounded.json.ready, false);
  // Stopping answers every held call.
  const stopping = call("GET", "/v1/describe?wait_ready_ms=30000");
  await delay(100);
  const closed = control.close();
  assert.equal((await stopping).json.facts.reason, "stopping");
  await closed;
});

test("describe waits are validated and bounded", async (t) => {
  const { call } = await startControl(t, { ready: false });
  for (const target of ["/v1/describe?wait_ready_ms=", "/v1/describe?wait_ready_ms=x", "/v1/describe?wait_ready_ms=30001", "/v1/describe?wait_ready_ms=05", "/v1/describe?other=1"]) {
    const response = await call("GET", target);
    assert.equal(response.status, 400, target);
    assert.equal(response.json.code, "invalid_argument");
  }
  const held = Array.from({ length: 16 }, () => call("GET", "/v1/describe?wait_ready_ms=1500"));
  await delay(150);
  const overflow = await call("GET", "/v1/describe?wait_ready_ms=1500");
  assert.equal(overflow.status, 503);
  assert.equal(overflow.json.code, "resource_exhausted");
  assert.deepEqual((await Promise.all(held)).map((response) => response.status), new Array(16).fill(200));
});

test("every other call needs a ready launcher and the live instance", async (t) => {
  const { control, socketPath, call } = await startControl(t, { ready: false });
  for (const [method, target] of [["GET", "/v1/view"], ["POST", "/v1/persistence"], ["POST", "/v1/extensions/load"]]) {
    const response = await call(method, target, method === "POST" ? { body: {} } : {});
    assert.equal(response.status, 503, `${method} ${target}`);
    assert.equal(response.json.code, "unavailable");
  }
  control.markReady();
  assert.equal((await call("GET", "/v1/view")).status, 200);
  // The instance fence rejects a caller of another process before any dispatch.
  assert.equal((await rawCall(socketPath, "GET", "/v1/view")).status, 409);
  assert.equal((await rawCall(socketPath, "GET", "/v1/view", { instance: "previous-instance" })).status, 409);
  assert.equal((await call("GET", "/v1/describe?wait_ready_ms=5000", { instance: "previous-instance" })).status, 409);
  assert.equal((await call("GET", "/v1/nothing")).status, 404);
  assert.equal((await call("DELETE", "/v1/view")).status, 404);
});

test("persistence passes through to the managed client with the transport identity", async (t) => {
  const { storage, call } = await startControl(t);
  let response = await call("POST", "/v1/persistence", { body: { operation: "snapshot", keys: [{ family: "profile", key: "user" }] } });
  assert.equal(response.status, 200);
  assert.equal(response.json.records[0].missing, true);
  const token = response.json.token;
  const batch = { operation: "batch", expected: token, requestId: "from-core", changes: [{ family: "profile", key: "user", expectedVersion: "0", value: { currentLayoutId: "a" } }] };
  response = await call("POST", "/v1/persistence", { body: batch, headers: { "X-Request-ID": "from-core" } });
  assert.equal(response.status, 200);
  assert.equal(response.json.durability, "sqlite-full");
  assert.equal(storage.document("profile", "user").data.value.currentLayoutId, "a");
  // The domain request identity must be the transport's.
  response = await call("POST", "/v1/persistence", { body: { ...batch, requestId: "other-id" }, headers: { "X-Request-ID": "from-core-2" } });
  assert.equal(response.status, 409);
  response = await call("POST", "/v1/persistence", { body: "not json", headers: { "Content-Type": "application/json" } });
  assert.equal(response.status, 400);
  response = await call("POST", "/v1/persistence", { body: { operation: "snapshot", keys: [{ family: "sql", key: "x" }] } });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, "invalid_argument");
});

test("extension archives are published and loaded by immutable reference", async (t) => {
  const { call } = await startControl(t);
  const archive = Buffer.from("PK-extension-archive");
  let response = await call("POST", "/v1/extensions/assets?name=publisher.camera&version=1.0.0", { body: archive });
  assert.equal(response.status, 200);
  assert.equal(response.json.owner, "lichtblick");
  assert.equal(response.json.bytes, archive.length);
  const asset = response.json;
  response = await call("POST", "/v1/extensions/load", { body: asset });
  assert.equal(response.status, 200);
  assert.deepEqual(response.raw, archive);
  response = await call("POST", "/v1/extensions/load", { body: { ...asset, sha256: "0".repeat(64) } });
  assert.equal(response.status, 409);
  response = await call("POST", "/v1/extensions/assets?name=../bad&version=1", { body: archive });
  assert.equal(response.status, 400);
  response = await call("POST", "/v1/extensions/assets?name=publisher.camera&version=1", { body: archive, headers: { "Content-Type": "application/json" } });
  assert.equal(response.status, 400);
});

test("the desired view is read and stated with a revision", async (t) => {
  const { call, viewStore } = await startControl(t);
  let response = await call("GET", "/v1/view");
  assert.deepEqual(response.json, { revision: "0", view: { layoutId: null, followRobot: null, perspective: null, visibleSurfaces: null } });
  response = await call("PUT", "/v1/view", { body: { view, expectedRevision: "0" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.view, normalizeView(view));
  assert.equal(response.json.unchanged, false);
  const revision = response.json.revision;
  assert.deepEqual((await call("GET", "/v1/view")).json, { revision, view: normalizeView(view) });
  // Identical, stale and invalid requests.
  response = await call("PUT", "/v1/view", { body: { view } });
  assert.deepEqual({ revision: response.json.revision, unchanged: response.json.unchanged }, { revision, unchanged: true });
  response = await call("PUT", "/v1/view", { body: { view: { perspective: false }, expectedRevision: "0" } });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, "conflict");
  assert.equal(viewStore.state.revision, revision);
  for (const body of [{}, { view: {}, extra: 1 }, { view: { unknown: 1 } }, { view: { followRobot: "no way" } }, { view: {}, expectedRevision: 1 }, []]) {
    response = await call("PUT", "/v1/view", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.code, "invalid_argument");
  }
  response = await call("PUT", "/v1/view", { body: "{", headers: { "Content-Type": "application/json" } });
  assert.equal(response.status, 400);
  response = await call("PUT", "/v1/view", { body: JSON.stringify({ view }), headers: { "Content-Type": "text/plain" } });
  assert.equal(response.status, 400);
  assert.equal(viewStore.state.revision, revision);
});

test("the socket is private, a stale one is reclaimed and a live one is never taken", async (t) => {
  const { control, socketPath, storage, client, viewStore } = await startControl(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const second = createControlService(client, { socketPath, viewStore });
  await assert.rejects(second.start(), (error) => error.code === "EADDRINUSE");
  assert.equal((await rawCall(socketPath, "GET", "/v1/describe")).json.instance_id, control.instanceId, "the live owner still answers");
  const first = control.instanceId;
  await control.close();
  assert.equal(fs.existsSync(socketPath), false, "close removes the socket it created");
  // A killed owner leaves its socket behind; the next owner reclaims it.
  const owner = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))", socketPath], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => owner.stdout.once("data", resolve));
  owner.kill("SIGKILL");
  await new Promise((resolve) => owner.once("exit", resolve));
  assert.equal(fs.existsSync(socketPath), true);
  const next = createControlService(client, { socketPath, viewStore });
  t.after(() => next.close());
  await next.start();
  next.markReady();
  assert.notEqual(next.instanceId, first, "every start has a new instance identity");
  assert.equal((await rawCall(socketPath, "GET", "/v1/view", { instance: first })).status, 409, "a caller of the previous process is fenced");
  assert.equal((await rawCall(socketPath, "GET", "/v1/view", { instance: next.instanceId })).status, 200);
  void storage;
});

async function untilDescribed(call, predicate, milliseconds = 4000) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const response = await call("GET", "/v1/describe");
    if (predicate(response.json)) return response.json;
    assert.ok(Date.now() < deadline, `describe never satisfied the condition: ${JSON.stringify(response.json)}`);
    await delay(20);
  }
}

test("a storage that stops answering makes the service not ready, and ready again when it answers", async (t) => {
  const { storage, call, changes } = await startControl(t, { monitor: 30 });
  assert.equal((await call("GET", "/v1/describe")).json.ready, true);
  storage.state.failSnapshots = 100000;
  const degraded = await untilDescribed(call, (document) => document.ready === false);
  assert.equal(degraded.facts.storage, "unavailable");
  assert.equal(degraded.facts.reason, "storage unavailable (unavailable)");
  // Persistence is not refused by readiness: it fails by itself, with its own error.
  assert.deepEqual(changes, [{ ready: false, reason: "storage unavailable (unavailable)" }]);
  // One held describe is answered when the storage answers again, without polling by the caller.
  const held = call("GET", "/v1/describe?wait_ready_ms=5000");
  await delay(100);
  storage.state.failSnapshots = 0;
  const recovered = await held;
  assert.equal(recovered.json.ready, true);
  assert.equal(recovered.json.facts.storage, "ready");
  assert.equal(recovered.json.facts.reason, undefined);
  assert.deepEqual(changes.map((change) => change.ready), [false, true]);
});

test("a stopped or replaced storage is never rebound: the service stays not ready with the reason", async (t) => {
  const { storage, call, scope } = await startControl(t, { monitor: 30 });
  const { socketPath, token } = storage;
  await storage.close();
  const stopped = await untilDescribed(call, (document) => document.ready === false);
  assert.match(stopped.facts.reason, /^storage unavailable \(/);
  // Another storage instance at the same socket is a different environment for this binding.
  const replacement = createFakeStorage({ socketPath, scope, token });
  await replacement.start();
  t.after(() => replacement.close());
  await delay(300);
  const after = (await call("GET", "/v1/describe")).json;
  assert.equal(after.ready, false);
  assert.match(after.facts.reason, /^storage unavailable \(/);
  assert.equal(after.facts.storage, "unavailable");
});

test("the launcher's own state comes first, and closing stops asking the storage", async (t) => {
  const { control, storage, call } = await startControl(t, { monitor: 30, ready: false });
  storage.state.failSnapshots = 100000;
  await delay(150);
  const document = (await call("GET", "/v1/describe")).json;
  assert.equal(document.ready, false);
  assert.equal(document.facts.reason, "starting", "the launcher is not serving yet");
  await control.close();
  // A question already on its way when the service closed may still arrive.
  await delay(100);
  const before = storage.state.calls.filter((entry) => entry.route === "/v1/snapshot").length;
  await delay(150);
  assert.equal(storage.state.calls.filter((entry) => entry.route === "/v1/snapshot").length, before, "a closed service asks nothing");
});
