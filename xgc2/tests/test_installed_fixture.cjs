// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { createFixture, processIdentity } = require("./installed_fixture.cjs");

test("installed fixture fails explicitly when an installed prerequisite is absent", () => {
  assert.throws(() => createFixture({ sdkPath: "/nonexistent-installed-xgc2/xrpc", storageBinary: "/usr/bin/xgc2-storage" }), /MODULE_NOT_FOUND|Cannot find module/);
});

test("fixture uses formal storage FULL receipts, private common Bootstrap and a real provider restart", { timeout: 15000 }, async (t) => {
  assert.ok(process.env.XGC2_STORAGE_TEST_BINARY, "explicit built formal storage binary required");
  assert.ok(process.env.LICHTBLICK_TEST_SDK, "explicit SDK source/install path required");
  const fixture = createFixture({ sdkPath: process.env.LICHTBLICK_TEST_SDK, storageBinary: process.env.XGC2_STORAGE_TEST_BINARY });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-fixture-"));
  t.after(async () => { await fixture.stopStorage(root); fs.rmSync(root, { recursive: true, force: true }); });
  await fixture.prepare(root);
  const state = fixture.load(root);
  const { loadBootstrapInput } = require(process.env.LICHTBLICK_TEST_SDK);
  const input = loadBootstrapInput(path.join(root, "bootstrap.json"), { role: "server" });
  assert.equal(input.binding.authentication, "mutual_tls");
  assert.equal(input.application.operator_time_zone, "Etc/UTC");
  assert.equal(input.application.assets.access, "read-write");
  assert.deepEqual(input.application.storage.reference, state.storageRef);
  assert.equal(input.application.storage.authorization, "smoke-storage-auth");
  for (const name of ["bootstrap.json", "fixture.json", "grants.json", "rpc-token", "storage-token", "server.key", "client.key"]) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  assert.deepEqual(fixture.snapshotValues(await fixture.storageSnapshot(state)), state.expected);
  assert.equal(processIdentity(state.pid), state.pidIdentity);
  await fixture.verifyRestart(root);
  assert.notEqual(fixture.load(root).storageRef.instance_id, state.storageRef.instance_id);
  await fixture.stopStorage(root);
  assert.equal(processIdentity(fixture.load(root).pid), undefined);
});
