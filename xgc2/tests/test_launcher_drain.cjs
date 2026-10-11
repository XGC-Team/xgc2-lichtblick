// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createManagedDomainClient } = require("../launcher/managed-storage.cjs");
const { LAUNCHER } = require("./launcher_fixture.cjs");
const { privateDirectory, writeStartupInput } = require("./input_fixture.cjs");
const { writeWebRoot } = require("./launcher_fixture.cjs");

function deferred() { let release; return { promise: new Promise((resolve) => { release = resolve; }), release: () => release() }; }
const token = { database_id: "drain-db", schema: "lichtblick.persistence.v1", revision: "0" };

test("actual launcher retains the domain lease after an incomplete native drain and closes on a later owner request", { timeout: 15000 }, async (t) => {
  const root = privateDirectory("lichtblick-drain-");
  const assets = path.join(root, "assets"); await fs.mkdir(assets, { mode: 0o700 });
  const { web, buildInfo } = writeWebRoot(root);
  const entered = deferred(); const blocked = deferred();
  let requests = 0;
  // A storage that answers the launcher's own startup read at once and then holds the operation of a page.
  const peer = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Native peer holds its accepted operation. */ }
    if (++requests > 1) { entered.release(); await blocked.promise; }
    response.setHeader("X-Xrpc-Instance-ID", "drain-peer");
    response.end(JSON.stringify({ token, results: [{ collection: "documents", records: [{ key: "profile:user", version: "0", missing: true }, { key: "view:desired", version: "0", missing: true }] }] }));
  });
  const socket = path.join(root, "storage.sock");
  peer.listen(socket); await new Promise((resolve) => peer.once("listening", resolve));
  const scope = { namespace: "lichtblick", user: "fixture", workspace: "drain" };
  const reference = { target_id: "fixture", service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: "drain-peer", profile: "http.v1", endpoint: { kind: "unix", address: socket } };
  const input = writeStartupInput(root, { reference, scope, assets });
  const controlSocket = path.join(root, "control.sock");
  const owner = spawn(process.execPath, [LAUNCHER, "--startup-input", input, "--control-socket", controlSocket, "--host", "127.0.0.1", "--port", "0", "--shutdown-ms", "50", "--frame-ancestors", "'self'"],
    { env: { ...process.env, XGC2_LICHTBLICK_WEB_STATIC_ROOT: web, XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfo, XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(root, "no-defaults"), ALLOWED_ORIGINS: "", FRAME_ANCESTORS: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errorOutput = "";
  owner.stdout.on("data", (chunk) => { output += chunk; }); owner.stderr.on("data", (chunk) => { errorOutput += chunk; });
  async function waitFor(predicate) {
    await new Promise((resolve, reject) => {
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(Error(`owner condition failed: ${output} ${errorOutput}`)); }, 4000);
      const cleanup = () => { clearTimeout(timer); owner.stdout.off("data", check); owner.stderr.off("data", check); };
      owner.stdout.on("data", check); owner.stderr.on("data", check); check();
    });
  }
  t.after(async () => {
    blocked.release();
    if (owner.exitCode === null) { const stopped = new Promise((resolve) => owner.once("exit", resolve)); owner.kill("SIGKILL"); await stopped; }
    peer.closeAllConnections(); await new Promise((resolve) => peer.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  await waitFor(() => /serving Lichtblick web bundle on http:\/\/127\.0\.0\.1:[0-9]+/.test(output));
  const origin = /serving Lichtblick web bundle on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(output)[1];
  const attempt = fetch(`${origin}/xgc2/storage`, { method: "POST", body: JSON.stringify({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }), headers: { Origin: origin, "Content-Type": "application/json" } });
  attempt.catch(() => {});
  await entered.promise; owner.kill("SIGTERM");
  await waitFor(() => (output + errorOutput).includes("shutdown incomplete; owner retains resources"));
  assert.equal(owner.exitCode, null);
  const contender = createManagedDomainClient({ scope, assetRoot: assets, call: async () => { throw Error("unexpected call"); } });
  await assert.rejects(contender.ready, (error) => error.code === "conflict"); await contender.close();
  await assert.rejects(attempt);
  const stopped = new Promise((resolve) => owner.once("exit", resolve)); owner.kill("SIGTERM"); blocked.release(); await stopped;
  assert.equal(owner.exitCode, 0);
  const diagnostics = errorOutput.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  assert.ok(diagnostics.some((record) => record.event === "shutdown_started"), "native diagnostic worker acknowledged its bounded records before exit");
  assert.ok(diagnostics.every((record) => record.event !== "sink_failed"));
  await assert.rejects(fs.stat(controlSocket), { code: "ENOENT" });
  const next = createManagedDomainClient({ scope, assetRoot: assets, call: async () => {} }); await next.ready; await next.close();
});
