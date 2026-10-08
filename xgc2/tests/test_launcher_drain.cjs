// SPDX-License-Identifier: MPL-2.0
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { createTLSFixture } = require("./tls_fixture.cjs");
const { createManagedDomainClient } = require("../launcher/managed-storage.cjs");

function deferred() { let release; return { promise: new Promise((resolve) => { release = resolve; }), release: () => release() }; }

test("actual launcher retains the domain lease after an incomplete native drain and closes on a later owner request", { timeout: 10000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "s8-drain-"));
  const assets = path.join(root, "assets"); await fs.mkdir(assets, { mode: 0o700 });
  const web = path.join(root, "web"); await fs.mkdir(web);
  await fs.writeFile(path.join(web, "index.html"), "<!doctype html><html><head></head><body>Native fixture</body></html>");
  const buildInfo = path.join(root, "build-info.json");
  await fs.writeFile(buildInfo, JSON.stringify({ schema: "xgc2.lichtblick-web.build.v1", package: "xgc2-lichtblick-web", version: "1.27.0-1~test", upstreamSha: "1".repeat(40) }));
  const entered = deferred(); const blocked = deferred();
  const peer = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Native peer holds its accepted operation. */ }
    entered.release(); await blocked.promise;
    response.setHeader("X-Xrpc-Instance-ID", "drain-peer"); response.end(JSON.stringify({ token: { database_id: "drain-db", schema: "lichtblick.persistence.v1", revision: "0" }, results: [{ collection: "documents", records: [{ key: "profile:user", version: "0", missing: true }] }] }));
  });
  const socket = path.join(root, "storage.sock");
  peer.listen(socket); await new Promise((resolve) => peer.once("listening", resolve));
  const scope = { namespace: "lichtblick", user: "fixture", workspace: "drain" };
  const tls = createTLSFixture(root);
  const input = tls.writeInput({ schema_version: 1, storage: { grant: "fixture-documents", reference: { target_id: "fixture", service: "xgc2.storage.v1.Storage", api_version: "1", instance_id: "drain-peer", profile: "http.v1", endpoint: { kind: "unix", address: socket } }, scope, authorization: "fixture-storage-auth" }, assets: { access: "read-write", grant: "fixture-assets", root: assets } });
  const owner = spawn(process.execPath, [path.resolve(__dirname, "../launcher/xgc2-lichtblick-web.js"), "--bootstrap-input", input, "--host", "127.0.0.1", "--port", "0"], { env: { ...process.env, XGC2_XRPC_LOG_LEVEL: "info", XGC2_XRPC_LOG_FORMAT: "json", XGC2_XRPC_SHUTDOWN_TIMEOUT_MS: "50", XGC2_LICHTBLICK_WEB_STATIC_ROOT: web, XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfo, XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(root, "no-defaults") }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let errorOutput = "";
  owner.stdout.on("data", (chunk) => { output += chunk; }); owner.stderr.on("data", (chunk) => { errorOutput += chunk; });
  async function waitFor(predicate) {
    await new Promise((resolve, reject) => {
      const check = () => { if (predicate()) { cleanup(); resolve(); } };
      const timer = setTimeout(() => { cleanup(); reject(Error(`owner condition failed: ${output} ${errorOutput}`)); }, 2000);
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
  await waitFor(() => output.includes('{"type":"service_ref"'));
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
  const next = createManagedDomainClient({ scope, assetRoot: assets, call: async () => {} }); await next.ready; await next.close();
});
