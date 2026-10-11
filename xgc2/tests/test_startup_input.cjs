// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadStartupInput } = require("../launcher/startup-input.cjs");
const { privateDirectory, writeStartupInput } = require("./input_fixture.cjs");

const reference = { target_id: "fixture", service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: "storage-1", profile: "http.v1", endpoint: { kind: "unix", address: "/run/xgc2/sockets/storage.sock" } };
const scope = { namespace: "lichtblick", user: "alice", workspace: "lab" };
function fixture(t, options = {}) {
  const root = privateDirectory();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  return { root, file: writeStartupInput(root, { reference, scope, assets, ...options }), assets };
}

test("the startup input carries the storage reference, scope, credential header and asset grant", (t) => {
  const { file, assets } = fixture(t, { timeZone: "Etc/UTC", token: "token-value.123_~+/=" });
  const input = loadStartupInput(file);
  assert.equal(input.operatorTimeZone, "Etc/UTC");
  assert.deepEqual(input.storage.reference, reference);
  assert.deepEqual(input.storage.scope, scope);
  assert.deepEqual(input.storage.authorization, { Authorization: "Bearer token-value.123_~+/=" });
  assert.deepEqual(input.assets, { root: assets, access: "read-write" });
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.storage.reference));
});

test("an input or credential that is not private, owned and plain is refused", (t) => {
  const { root, file } = fixture(t);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadStartupInput(file), /mode 0600/);
  fs.chmodSync(file, 0o600);
  const token = path.join(root, "storage-token");
  fs.chmodSync(token, 0o640);
  assert.throws(() => loadStartupInput(file), /mode 0600/);
  fs.chmodSync(token, 0o600);
  assert.doesNotThrow(() => loadStartupInput(file));
  fs.linkSync(file, path.join(root, "second-name"));
  assert.throws(() => loadStartupInput(file), /single-link/);
  fs.unlinkSync(path.join(root, "second-name"));
  const link = path.join(root, "link.json");
  fs.symlinkSync(file, link);
  assert.throws(() => loadStartupInput(link));
  fs.chmodSync(root, 0o755);
  assert.throws(() => loadStartupInput(file), /mode 0700/);
  fs.chmodSync(root, 0o700);
  assert.throws(() => loadStartupInput("relative/input.json"), /absolute/);
  assert.throws(() => loadStartupInput(path.join(root, "absent.json")));
  const fifo = path.join(root, "fifo.json");
  require("node:child_process").execFileSync("mkfifo", ["-m", "600", fifo]);
  assert.throws(() => loadStartupInput(fifo));
});

test("only the declared schema is accepted", (t) => {
  const rejected = (change, pattern) => {
    const { file } = fixture(t, { change });
    assert.throws(() => loadStartupInput(file), pattern);
  };
  rejected((input) => { input.schema_version = 2; }, /schema/);
  rejected((input) => { input.extra = true; }, /unknown startup input field/);
  rejected((input) => { delete input.assets; }, /missing startup input field assets/);
  rejected((input) => { input.operator_time_zone = ""; }, /time zone/);
  rejected((input) => { input.storage.reference.service = "xgc2.other"; }, /storage-v1/);
  rejected((input) => { input.storage.reference.endpoint = { kind: "https", address: "https://127.0.0.1:1" }; }, /Unix/);
  rejected((input) => { input.storage.reference.endpoint.address = "relative.sock"; }, /absolute/);
  rejected((input) => { input.storage.reference.endpoint.address = `/${"x".repeat(120)}`; }, /shorter/);
  rejected((input) => { input.storage.reference.instance_id = "has space"; }, /instance_id/);
  rejected((input) => { input.storage.scope.namespace = "other"; }, /lichtblick/);
  rejected((input) => { input.storage.scope.user = ""; }, /scope user/);
  rejected((input) => { input.storage.scope.extra = 1; }, /unknown storage scope field/);
  rejected((input) => { input.assets.access = "write"; }, /access/);
  rejected((input) => { input.assets.root = "assets"; }, /canonical/);
  rejected((input) => { input.assets.root = "/a/../b"; }, /canonical/);
  const { root, file } = fixture(t);
  fs.writeFileSync(path.join(root, "storage-token"), "token\n", { mode: 0o600 });
  assert.throws(() => loadStartupInput(file), /bearer token/);
  fs.writeFileSync(path.join(root, "storage-token"), "x".repeat(1025), { mode: 0o600 });
  assert.throws(() => loadStartupInput(file), /1024 bytes/);
  fs.writeFileSync(file, "{ not json", { mode: 0o600 });
  assert.throws(() => loadStartupInput(file), /not valid JSON/);
});
