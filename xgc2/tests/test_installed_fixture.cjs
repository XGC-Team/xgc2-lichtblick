// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { createFixture, processIdentity } = require("./installed_fixture.cjs");
const { loadStartupInput } = require("../launcher/startup-input.cjs");

test("installed fixture fails explicitly when an installed prerequisite is absent", () => {
  assert.throws(() => createFixture({ sdkPath: "/nonexistent-installed-xgc2/xrpc", storageBinary: "/usr/bin/xgc2-storage" }), /MODULE_NOT_FOUND|Cannot find module/);
});

test("fixture seeds storage with FULL receipts, writes the private startup input and restarts the real provider", { timeout: 15000 }, async (t) => {
  assert.ok(process.env.XGC2_STORAGE_TEST_BINARY, "explicit built formal storage binary required");
  assert.ok(process.env.LICHTBLICK_TEST_SDK, "explicit SDK source/install path required");
  const fixture = createFixture({ sdkPath: process.env.LICHTBLICK_TEST_SDK, storageBinary: process.env.XGC2_STORAGE_TEST_BINARY });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "installed-fixture-"));
  t.after(async () => { await fixture.stopStorage(root); fs.rmSync(root, { recursive: true, force: true }); });
  await fixture.prepare(root);
  const state = fixture.load(root);
  // The product's own loader accepts what the fixture hands a launcher or the desktop.
  const input = loadStartupInput(path.join(root, "startup-input.json"));
  assert.equal(input.operatorTimeZone, "Etc/UTC");
  assert.equal(input.assets.access, "read-write");
  assert.equal(input.assets.root, path.join(root, "assets"));
  assert.deepEqual(input.storage.reference, state.storageRef);
  assert.deepEqual(input.storage.scope, state.scope);
  assert.deepEqual(input.storage.viewScope, { ...state.scope, workspace: `${state.scope.workspace}.view` });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "grants.json"), "utf8")).map((grant) => grant.workspace), [state.scope.workspace, input.storage.viewScope.workspace]);
  assert.deepEqual(input.storage.authorization, { Authorization: `Bearer ${state.storageToken}` });
  for (const name of ["startup-input.json", "fixture.json", "grants.json", "storage-token"]) assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  for (const retired of ["bootstrap.json", "rpc-token", "server.key", "client.key", "ca.pem"]) assert.ok(!fs.existsSync(path.join(root, retired)), `${retired} belongs to the retired wrapper`);
  assert.deepEqual(fixture.snapshotValues(await fixture.storageSnapshot(state)), state.expected);
  assert.equal(processIdentity(state.pid), state.pidIdentity);
  await fixture.verifyRestart(root);
  assert.notEqual(fixture.load(root).storageRef.instance_id, state.storageRef.instance_id);
  await fixture.stopStorage(root);
  assert.equal(processIdentity(fixture.load(root).pid), undefined);
});
