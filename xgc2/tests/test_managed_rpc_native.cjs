// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { HTTPClient } = require("@xgc2/xrpc");
const { createManagedPolicy } = require("../launcher/managed-storage.cjs");
const { createManagedDomainRPC } = require("../launcher/managed-rpc.cjs");
const { createTLSFixture } = require("./tls_fixture.cjs");

test("native Lichtblick RPC requires verified mutual TLS, an owner grant and a live instance; owner stop closes it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s8-tls-"));
  const tls = createTLSFixture(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  let observed;
  const client = { ready: Promise.resolve(), async request(input, context) { calls++; observed = context; return { value: input.operation }; } };
  const product = createManagedDomainRPC(client, { ...tls, policy: createManagedPolicy({}) });
  const reference = await product.start();
  t.after(() => product.close());
  const transport = new HTTPClient({ tls: tls.clientTLS, maxReferences: 2 });
  const untrusted = new HTTPClient({ tls: { rejectUnauthorized: true }, maxReferences: 1 });
  const noIdentity = new HTTPClient({ tls: { ca: tls.clientTLS.ca, rejectUnauthorized: true }, maxReferences: 1 });
  t.after(() => { transport.close(); untrusted.close(); noIdentity.close(); });
  const options = { timeoutMs: 1000, headers: { Authorization: `Bearer ${tls.grant}` } };
  let response = await transport.call(reference, "/v1/describe", options);
  assert.deepEqual(JSON.parse(response.body).service_ref, reference);
  assert.equal(calls, 0);
  await assert.rejects(untrusted.call(reference, "/v1/describe", options));
  await assert.rejects(noIdentity.call(reference, "/v1/describe", options));
  response = await transport.call(reference, "/v1/persistence", { ...options, method: "POST", json: { operation: "snapshot", families: ["profile"] }, headers: { Authorization: "Bearer invalid" } });
  assert.equal(response.status, 403); assert.equal(calls, 0);
  await assert.rejects(transport.call({ ...reference, instance_id: "previous-instance" }, "/v1/persistence", { ...options, method: "POST", json: { operation: "snapshot" } }), (error) => error.code === "conflict");
  assert.equal(calls, 0);
  response = await transport.call(reference, "/v1/persistence", { ...options, timeoutMs: 250, requestId: "current-read", method: "POST", json: { operation: "snapshot" } });
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.equal(observed.requestId, "current-read"); assert.ok(observed.timeoutMs <= 250); assert.ok(observed.signal instanceof AbortSignal);
  response = await transport.call(reference, "/v1/persistence", { ...options, requestId: "transport-id", method: "POST", json: { operation: "batch", requestId: "other-id" } });
  assert.equal(response.status, 409); assert.equal(calls, 1);
  await product.close();
  await assert.rejects(transport.call(reference, "/v1/describe", options));
  const restarted = createManagedDomainRPC(client, { ...tls, policy: createManagedPolicy({}) });
  t.after(() => restarted.close());
  const newReference = await restarted.start();
  assert.notEqual(newReference.instance_id, reference.instance_id);
  await assert.rejects(transport.call({ ...newReference, instance_id: reference.instance_id }, "/v1/describe", options), (error) => error.code === "conflict");
});
