// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const test = require("node:test");
const { setTimeout: delay } = require("node:timers/promises");

const { rawCall, startControl } = require("./control_fixture.cjs");
const { createControlService } = require("../launcher/control-service.cjs");
const { normalizeView } = require("../launcher/view-state.cjs");

const view = {
  layoutId: "camera-ar",
  followRobot: "uav1",
  perspective: true,
  visibleSurfaces: ["3d-tools"],
};

test("describe is the unbound discovery call and reports readiness and facts", async (t) => {
  const { control, socketPath } = await startControl(t, { ready: false });
  let response = await rawCall(socketPath, "GET", "/v1/describe");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-xrpc-instance-id"], control.instanceId);
  assert.deepEqual(Object.keys(response.json).sort(), [
    "api_version",
    "facts",
    "instance_id",
    "ready",
    "service",
  ]);
  assert.deepEqual(
    {
      service: response.json.service,
      api_version: response.json.api_version,
      instance_id: response.json.instance_id,
      ready: response.json.ready,
    },
    {
      service: "xgc2.lichtblick.v1",
      api_version: "1",
      instance_id: control.instanceId,
      ready: false,
    },
  );
  assert.equal(response.json.facts.reason, "starting");
  assert.deepEqual(response.json.facts.capabilities, ["view.v1"]);
  assert.equal(response.json.facts.view_revision, "0");
  control.markReady();
  response = await rawCall(socketPath, "GET", "/v1/describe");
  assert.equal(response.json.ready, true);
  assert.equal(response.json.facts.reason, undefined);
  assert.equal(response.json.facts.http_port, 18081);
  assert.equal(response.json.facts.storage, undefined);
  assert.equal(response.json.facts.assets, undefined);
});

test("unbound wait_ready_ms holds the call until the launcher is ready, without polling", async (t) => {
  const { control, socketPath, call } = await startControl(t, { ready: false });
  const started = Date.now();
  let earlyResponse;
  const held = rawCall(socketPath, "GET", "/v1/describe?wait_ready_ms=5000").then((response) => {
    earlyResponse = response;
    return response;
  });
  await delay(150);
  assert.equal(
    earlyResponse?.status,
    undefined,
    "unbound readiness call must remain held before markReady",
  );
  control.markReady();
  const response = await held;
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-xrpc-instance-id"], control.instanceId);
  assert.equal(response.json.ready, true);
  assert.ok(
    Date.now() - started >= 140 && Date.now() - started < 2000,
    `answered when ready, after ${Date.now() - started} ms`,
  );
  t.diagnostic(
    `unbound readiness answered HTTP ${response.status} after ${Date.now() - started} ms`,
  );
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
  for (const target of [
    "/v1/describe?wait_ready_ms=",
    "/v1/describe?wait_ready_ms=x",
    "/v1/describe?wait_ready_ms=30001",
    "/v1/describe?wait_ready_ms=05",
    "/v1/describe?other=1",
  ]) {
    const response = await call("GET", target);
    assert.equal(response.status, 400, target);
    assert.equal(response.json.code, "invalid_argument");
  }
  const held = Array.from({ length: 16 }, () => call("GET", "/v1/describe?wait_ready_ms=1500"));
  await delay(150);
  const overflow = await call("GET", "/v1/describe?wait_ready_ms=1500");
  assert.equal(overflow.status, 503);
  assert.equal(overflow.json.code, "resource_exhausted");
  assert.deepEqual(
    (await Promise.all(held)).map((response) => response.status),
    new Array(16).fill(200),
  );
});

test("every other call needs a ready launcher and the live instance", async (t) => {
  const { control, socketPath, call } = await startControl(t, { ready: false });
  for (const [method, target] of [
    ["GET", "/v1/view"],
    ["PUT", "/v1/view"],
    ["GET", "/v1/health"],
  ]) {
    const response = await call(method, target, method === "PUT" ? { body: { view } } : {});
    assert.equal(response.status, 503, `${method} ${target}`);
    assert.equal(response.json.code, "unavailable");
  }
  control.markReady();
  assert.equal((await call("GET", "/v1/view")).status, 200);
  // The instance fence rejects a caller of another process before any dispatch.
  assert.equal((await rawCall(socketPath, "GET", "/v1/view")).status, 409);
  assert.equal(
    (await rawCall(socketPath, "GET", "/v1/view", { instance: "previous-instance" })).status,
    409,
  );
  assert.equal((await rawCall(socketPath, "GET", "/v1/describe?wait_ready_ms=5000")).status, 200);
  // An explicitly supplied stale instance is fenced even on a discovery path.
  assert.equal(
    (await call("GET", "/v1/describe?wait_ready_ms=5000", { instance: "previous-instance" }))
      .status,
    409,
  );
  assert.equal((await call("GET", "/v1/nothing")).status, 404);
  assert.equal((await call("DELETE", "/v1/view")).status, 404);
});

test("health is instance-bound and retired persistence and asset operations are absent", async (t) => {
  const { call, socketPath } = await startControl(t);
  assert.deepEqual((await call("GET", "/v1/health")).json, { status: "ok" });
  assert.equal((await rawCall(socketPath, "GET", "/v1/health")).status, 409);
  for (const target of ["/v1/persistence", "/v1/extensions/assets", "/v1/extensions/load"])
    {assert.equal((await call("POST", target, { body: {} })).status, 404, target);}
});

test("the desired view is read and stated with a revision", async (t) => {
  const { call, viewStore } = await startControl(t);
  let response = await call("GET", "/v1/view");
  assert.deepEqual(response.json, {
    revision: "0",
    view: { layoutId: null, followRobot: null, perspective: null, visibleSurfaces: null },
  });
  response = await call("PUT", "/v1/view", { body: { view, expectedRevision: "0" } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.view, normalizeView(view));
  assert.equal(response.json.unchanged, false);
  const revision = response.json.revision;
  assert.deepEqual((await call("GET", "/v1/view")).json, { revision, view: normalizeView(view) });
  // Identical, stale and invalid requests.
  response = await call("PUT", "/v1/view", { body: { view } });
  assert.deepEqual(
    { revision: response.json.revision, unchanged: response.json.unchanged },
    { revision, unchanged: true },
  );
  response = await call("PUT", "/v1/view", {
    body: { view: { perspective: false }, expectedRevision: "0" },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json.code, "conflict");
  assert.equal(viewStore.state.revision, revision);
  for (const body of [
    {},
    { view: {}, extra: 1 },
    { view: { unknown: 1 } },
    { view: { followRobot: "no way" } },
    { view: {}, expectedRevision: 1 },
    [],
  ]) {
    response = await call("PUT", "/v1/view", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.json.code, "invalid_argument");
  }
  response = await call("PUT", "/v1/view", {
    body: "{",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 400);
  response = await call("PUT", "/v1/view", {
    body: JSON.stringify({ view }),
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(response.status, 400);
  assert.equal(viewStore.state.revision, revision);
});

test("the socket is private, a stale one is reclaimed and a live one is never taken", async (t) => {
  const { control, socketPath, viewStore } = await startControl(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const second = createControlService({ socketPath, viewStore });
  t.after(() => second.close());
  await assert.rejects(second.start(), (error) => error.code === "EADDRINUSE");
  assert.equal(
    (await rawCall(socketPath, "GET", "/v1/describe")).json.instance_id,
    control.instanceId,
    "the live owner still answers",
  );
  const first = control.instanceId;
  await control.close();
  assert.equal(fs.existsSync(socketPath), false, "close removes the socket it created");
  // A killed owner leaves its socket behind; the next owner reclaims it.
  const owner = spawn(
    process.execPath,
    [
      "-e",
      "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const exited = new Promise((resolve) => owner.once("close", resolve));
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {owner.kill("SIGKILL");}
    await exited;
  });
  await new Promise((resolve) => owner.stdout.once("data", resolve));
  owner.kill("SIGKILL");
  await exited;
  assert.equal(fs.existsSync(socketPath), true);
  const next = createControlService({ socketPath, viewStore });
  t.after(() => next.close());
  await next.start();
  next.markReady();
  assert.notEqual(next.instanceId, first, "every start has a new instance identity");
  assert.equal(
    (await rawCall(socketPath, "GET", "/v1/view", { instance: first })).status,
    409,
    "a caller of the previous process is fenced",
  );
  assert.equal(
    (await rawCall(socketPath, "GET", "/v1/view", { instance: next.instanceId })).status,
    200,
  );
});
