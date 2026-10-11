// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only installed-package fixture. Never imported by either launcher.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

const INSTALLED_SDK = "/usr/lib/xgc2/node_modules/@xgc2/xrpc";
const INSTALLED_STORAGE = "/usr/bin/xgc2-storage";
const layoutKey = JSON.stringify(["local", "installed-camera"]);
const documentKeys = [`layouts:${layoutKey}`, "profile:user", "configuration:language"];
const viewKey = "view:desired";
// The desired view lives in a scope of its own; the pages' saves are fenced by the revision of the other one.
const viewScopeOf = (scope) => ({ ...scope, workspace: `${scope.workspace}.view` });
const CONTROL_SOCKET = "control.sock";
function write(file, value) { fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); }
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function processIdentity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return fields[0] === "Z" ? undefined : fields[19];
  } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function createFixture({ sdkPath = INSTALLED_SDK, storageBinary = INSTALLED_STORAGE } = {}) {
  // Absolute paths deliberately prevent a checkout or ambient Node from masking
  // an absent installed SDK/provider. Explicit overrides exist only for unit tests.
  assert.ok(path.isAbsolute(sdkPath) && path.isAbsolute(storageBinary));
  const { HTTPClient } = require(sdkPath);
  const websocketModule = require.resolve("ws", { paths: [sdkPath] });
  const dependencyRoot = sdkPath === INSTALLED_SDK ? "/usr/lib/xgc2/node_modules" : sdkPath;
  assert.ok(fs.realpathSync(websocketModule).startsWith(`${fs.realpathSync(dependencyRoot)}/`), "ws must be owned by the explicit SDK installation");
  const WebSocket = require(websocketModule);
  fs.accessSync(storageBinary, fs.constants.X_OK);
  const stateFile = (root) => path.join(root, "fixture.json");
  const save = (root, state) => write(stateFile(root), state);
  const load = (root) => read(stateFile(root));
  function privateRoot(root) {
    assert.equal(fs.realpathSync(root), root, "fixture root must be canonical");
    const stat = fs.statSync(root);
    assert.ok(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, "fixture root must be private and owned");
  }
  async function stopStorage(root) {
    if (!fs.existsSync(stateFile(root))) return;
    const state = load(root);
    if (!state.pid || !state.pidIdentity || processIdentity(state.pid) !== state.pidIdentity) return;
    process.kill(state.pid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      if (processIdentity(state.pid) !== state.pidIdentity) return;
      await delay(50);
    }
    process.kill(state.pid, "SIGKILL");
    throw Error("formal storage provider did not drain after SIGTERM");
  }
  async function startStorage(root, state, create) {
    const refs = path.join(root, "refs.json");
    fs.rmSync(refs, { force: true });
    const log = fs.openSync(path.join(root, "storage.log"), "a", 0o600);
    const child = spawn(storageBinary, ["--db", path.join(root, "storage.db"), "--manifest", path.join(root, "manifest.json"), "--grants", path.join(root, "grants.json"), "--http-socket", path.join(root, "rpc.sock"), "--target-id", "fixture", "--ref-out", refs, ...(create ? ["--create"] : [])], { detached: true, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    let failure; child.once("error", (error) => { failure = error; });
    state.pid = child.pid; state.pidIdentity = processIdentity(child.pid); save(root, state);
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (failure) throw failure;
      assert.equal(child.exitCode, null, `formal storage failed: ${fs.readFileSync(path.join(root, "storage.log"), "utf8")}`);
      if (fs.existsSync(refs)) {
        const references = read(refs); assert.equal(references.length, 1);
        state.storageRef = references[0]; save(root, state); return;
      }
      await delay(20);
    }
    throw Error("formal storage did not publish an actual ServiceRef");
  }
  async function storage(state, route, body, requestId) {
    const client = new HTTPClient({ localTarget: "fixture" });
    try {
      const response = await client.call(state.storageRef, route, { timeoutMs: 3000, method: "POST", json: body, ...(requestId ? { requestId } : {}), headers: { Authorization: `Bearer ${state.storageToken}` } });
      const result = JSON.parse(response.body); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    } finally { client.close(); }
  }
  function storageSnapshot(state) { return storage(state, "/v1/snapshot", { scope: state.scope, queries: [{ collection: "documents", keys: Object.keys(state.expected) }] }); }
  function viewSnapshot(state) { return storage(state, "/v1/snapshot", { scope: viewScopeOf(state.scope), queries: [{ collection: "documents", keys: [viewKey] }] }); }
  function snapshotValues(snapshot) {
    assert.equal(snapshot.results.length, 1);
    return Object.fromEntries(snapshot.results[0].records.map((record) => [record.key, record.data?.value]));
  }
  async function prepare(root) {
    privateRoot(root);
    assert.ok(!fs.existsSync(stateFile(root)), "fixture already initialized");
    const state = { scope: { namespace: "lichtblick", user: "installed-smoke", workspace: "isolated" }, storageToken: randomUUID() };
    try {
      fs.copyFileSync(path.resolve(__dirname, "../contracts/storage-manifest.json"), path.join(root, "manifest.json"));
      fs.chmodSync(path.join(root, "manifest.json"), 0o600);
      write(path.join(root, "grants.json"), [{ ...state.scope, token: state.storageToken }, { ...viewScopeOf(state.scope), token: state.storageToken }]);
      await startStorage(root, state, true);
      const camera = { distance: 20, perspective: true, phi: 60, target: [0, 0, 0], targetOffset: [0, 0, 0], targetOrientation: [0, 0, 0, 1], thetaOffset: 45, fovy: 45, near: 0.5, far: 5000 };
      const data = { configById: { "3D!installed": { cameraState: camera } }, globalVariables: {}, userNodes: {}, playbackConfig: { speed: 1 }, layout: "3D!installed" };
      state.expected = { [documentKeys[0]]: { id: "installed-camera", name: "Installed Managed Camera", permission: "CREATOR_WRITE", baseline: { data, savedAt: new Date().toISOString() } }, "profile:user": { currentLayoutId: "installed-camera", firstSeenTime: new Date().toISOString() }, "configuration:language": "en" };
      const snapshot = await storageSnapshot(state); const requestId = randomUUID();
      const receipt = await storage(state, "/v1/batch", { scope: state.scope, expected: snapshot.token, request_id: requestId, mutations: documentKeys.map((key) => { const family = key.slice(0, key.indexOf(":")); return { collection: "documents", key, expected_version: "0", data: { family, key: key.slice(family.length + 1), value: state.expected[key] } }; }) }, requestId);
      assert.equal(receipt.durability, "sqlite-full"); assert.equal(receipt.request_id, requestId); assert.equal(receipt.versions.length, 3);
      write(path.join(root, "storage-token"), state.storageToken);
      fs.mkdirSync(path.join(root, "assets"), { mode: 0o700 });
      write(path.join(root, "startup-input.json"), { schema_version: 1, operator_time_zone: "Etc/UTC", storage: { reference: state.storageRef, scope: state.scope, view_scope: viewScopeOf(state.scope), token_file: path.join(root, "storage-token") }, assets: { root: path.join(root, "assets"), access: "read-write" } });
      save(root, state);
    } catch (error) { await stopStorage(root); throw error; }
  }
  const failurePattern = /Desktop initialization failed|Error occurred in the main process|renderer process.*(crash|gone)|cannot prepare web entrypoint|startup failed/i;
  /** Waits for the line an application prints when it is up: the web origin of the launcher, or the ready line of the desktop. */
  async function awaitStarted(logFile, seconds, web) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const log = fs.readFileSync(logFile, "utf8");
      assert.ok(!failurePattern.test(log), log);
      const origin = /serving Lichtblick web bundle on (http:\/\/127\.0\.0\.1:[0-9]+)/.exec(log)?.[1];
      if (web ? origin : log.split("\n").some((line) => line === '{"type":"ready"}')) return origin;
      await delay(100);
    }
    throw Error(`application readiness timed out: ${fs.readFileSync(logFile, "utf8")}`);
  }
  /** One HTTP call to the control socket; `instance` adds the fence header of the service instance. */
  function control(root, method, target, { instance, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request({
        socketPath: path.join(root, CONTROL_SOCKET), method, path: target,
        headers: { "X-Request-ID": randomUUID(), "X-Xrpc-Timeout-Ms": "5000", ...(instance ? { "X-Xrpc-Instance-ID": instance } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }) },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
      });
      request.setTimeout(8000, () => request.destroy(Error("control call timed out")));
      request.on("error", reject);
      request.end(payload);
    });
  }
  /** Discovery and readiness are unbound calls; the readiness wait needs no instance. */
  async function describe(root, seconds) {
    const discovered = await control(root, "GET", "/v1/describe");
    assert.equal(discovered.status, 200, JSON.stringify(discovered.json));
    const wait = Math.min(30000, Math.max(0, Math.floor(seconds * 1000)));
    const response = await control(root, "GET", `/v1/describe?wait_ready_ms=${wait}`);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const document = response.json;
    assert.equal(document.service, "xgc2.lichtblick.v1");
    assert.equal(document.api_version, "1");
    assert.equal(document.instance_id, discovered.json.instance_id);
    assert.equal(document.ready, true, JSON.stringify(document));
    assert.equal(document.facts.storage, "ready");
    return document;
  }
  async function verifyWeb(root, logFile, seconds = 20) {
    const origin = await awaitStarted(logFile, seconds, true);
    write(path.join(root, "origin"), origin);
    const described = await describe(root, seconds);
    write(path.join(root, "actual-describe.json"), described);
    // A call bound to another instance of the service is refused; nothing but the socket directory authorizes a caller.
    const stranger = await control(root, "GET", "/v1/view", { instance: `${described.instance_id}-other` });
    assert.ok(stranger.status >= 400, "a call bound to another instance was served");
    const gateway = async (body) => {
      const response = await fetch(`${origin}/xgc2/storage`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const keys = [{ family: "layouts", key: layoutKey }, { family: "profile", key: "user" }];
    const before = await gateway({ operation: "snapshot", keys });
    const state = load(root); const layout = structuredClone(state.expected[documentKeys[0]]);
    layout.working = { data: structuredClone(layout.baseline.data) }; layout.working.data.configById["3D!installed"].cameraState.distance = 37;
    const requestId = randomUUID();
    const receipt = await gateway({ operation: "batch", expected: before.token, requestId, changes: keys.map((key) => ({ ...key, expectedVersion: before.records.find((record) => record.family === key.family && record.key === key.key).version, value: key.family === "layouts" ? layout : state.expected["profile:user"] })) });
    assert.equal(receipt.durability, "sqlite-full"); assert.equal(receipt.requestId, requestId); assert.equal(receipt.versions.length, 2);
    const reconciled = await gateway({ operation: "receipt", requestId }); assert.deepEqual(reconciled, receipt);
    const after = await gateway({ operation: "snapshot", keys });
    assert.deepEqual(after.records.find((record) => record.family === "layouts").value, layout);
    assert.deepEqual(after.records.find((record) => record.family === "profile").value, state.expected["profile:user"]);
    state.expected[documentKeys[0]] = layout;
    // The desired view: stated over the control socket, read by a page over the same-origin gateway.
    const view = { layoutId: "installed-camera", followRobot: "uav1", perspective: true, visibleSurfaces: ["3d-tools"] };
    const stated = await control(root, "PUT", "/v1/view", { instance: described.instance_id, body: { view } });
    assert.equal(stated.status, 200, JSON.stringify(stated.json));
    const page = await fetch(`${origin}/xgc2/view`, { headers: { Origin: origin }, signal: AbortSignal.timeout(3000) });
    assert.equal(page.status, 200);
    assert.deepEqual(await page.json(), { revision: stated.json.revision, view });
    state.expectedView = view;
    save(root, state);
  }
  async function verifyDesktop(root, logFile, seconds = 25) {
    await awaitStarted(logFile, seconds, false);
    const deadline = Date.now() + seconds * 1000;
    let page;
    while (Date.now() < deadline) {
      const devtools = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/[^\s]+)/.exec(fs.readFileSync(logFile, "utf8"))?.[1];
      if (devtools) {
        const origin = new URL(devtools); origin.protocol = "http:"; origin.pathname = "/json/list";
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 200);
        page = (await response.json()).find((target) => target.type === "page" && target.url.startsWith("file:"));
        if (page) break;
      }
      await delay(100);
    }
    assert.ok(page?.webSocketDebuggerUrl, "installed renderer did not publish a CDP page");
    const socket = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 2000 }); let sequence = 0; const pending = new Map(); const errors = [];
    socket.on("message", (bytes) => { const message = JSON.parse(bytes); if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails); const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result); } });
    const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP ${method} timed out`)); }, 2000); pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } }); socket.send(JSON.stringify({ id, method, params })); });
    try {
      await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      await call("Runtime.enable");
      while (Date.now() < deadline) {
        assert.deepEqual(errors, [], "installed renderer threw an exception");
        const result = await call("Runtime.evaluate", { returnByValue: true, expression: `JSON.stringify({text:document.body?.innerText??"",alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.innerText),canvas:[...document.querySelectorAll('[data-testid*="panel-mouseenter-container"][data-testid*="3D!installed"] canvas')].some(e=>e.width>0&&e.height>0&&e.getBoundingClientRect().width>0)})` });
        assert.deepEqual(errors, [], "installed renderer threw an exception");
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        const ui = JSON.parse(result.result.value);
        assert.ok(!ui.alerts.some((text) => /failed|error|unavailable|unable/i.test(text)), JSON.stringify(ui));
        assert.ok(!/something went wrong|failed to initialize|persistence unavailable/i.test(ui.text), JSON.stringify(ui));
        if (ui.canvas) { write(path.join(root, "renderer-proof.json"), ui); return; }
        await delay(100);
      }
      throw Error("installed renderer did not restore the seeded managed 3D layout");
    } finally { socket.terminate(); }
  }
  async function verifyRestart(root) {
    const state = load(root); const previous = state.storageRef.instance_id;
    await stopStorage(root); await startStorage(root, state, false);
    assert.notEqual(state.storageRef.instance_id, previous, "storage restart reused the former instance");
    assert.deepEqual(snapshotValues(await storageSnapshot(state)), state.expected, "SQLite FULL records did not survive formal provider restart");
    if (state.expectedView) assert.deepEqual(snapshotValues(await viewSnapshot(state))[viewKey], state.expectedView, "the desired view did not survive formal provider restart");
  }
  async function verifyClosed(root) {
    if (fs.existsSync(path.join(root, "origin"))) {
      // The launcher owned its socket: it is gone with the process and nothing listens any more.
      assert.ok(!fs.existsSync(path.join(root, CONTROL_SOCKET)), "the control socket remained after SIGTERM");
      await assert.rejects(new Promise((resolve, reject) => { const socket = net.connect(path.join(root, CONTROL_SOCKET)); socket.once("connect", () => { socket.destroy(); resolve(); }); socket.once("error", reject); }), "the control service accepted a connection after SIGTERM");
    }
    if (fs.existsSync(path.join(root, "renderer-proof.json"))) {
      // Opening the 3D panel persists its normalized working configuration.
      // After the renderer exits, check its saved semantics, then retain that
      // exact acknowledged snapshot as the provider-restart oracle.
      const state = load(root);
      const saved = snapshotValues(await storageSnapshot(state));
      const expected = state.expected[documentKeys[0]];
      const layout = saved[documentKeys[0]];
      assert.deepEqual(Object.keys(saved).sort(), documentKeys.slice().sort());
      for (const key of ["id", "name", "permission", "baseline"]) assert.deepEqual(layout[key], expected[key], `renderer changed saved layout ${key}`);
      assert.deepEqual(saved["profile:user"], state.expected["profile:user"]);
      assert.equal(saved["configuration:language"], state.expected["configuration:language"]);
      if (layout.working) {
        const original = expected.baseline.data;
        const working = layout.working.data;
        for (const key of ["layout", "globalVariables", "userNodes", "playbackConfig"]) assert.deepEqual(working[key], original[key]);
        const camera = working.configById["3D!installed"].cameraState;
        for (const [key, value] of Object.entries(original.configById["3D!installed"].cameraState)) assert.deepEqual(camera[key], value, `renderer changed camera ${key}`);
      }
      state.expected = saved;
      save(root, state);
    }
    await verifyRestart(root);
  }
  return { prepare, verifyWeb, verifyDesktop, verifyClosed, verifyRestart, stopStorage, storageSnapshot, snapshotValues, load };
}

async function main() {
  const [command, root, log, seconds] = process.argv.slice(2);
  assert.ok(root && path.isAbsolute(root), "absolute private fixture root required");
  if (seconds !== undefined) assert.ok(Number.isFinite(Number(seconds)) && Number(seconds) > 0 && Number(seconds) <= 120, "readiness timeout must be 1..120 seconds");
  const fixture = createFixture();
  if (command === "prepare") await fixture.prepare(root);
  else if (command === "verify-web") await fixture.verifyWeb(root, log, seconds === undefined ? undefined : Number(seconds));
  else if (command === "verify-desktop") await fixture.verifyDesktop(root, log, seconds === undefined ? undefined : Number(seconds));
  else if (command === "verify-closed") await fixture.verifyClosed(root);
  else if (command === "stop") await fixture.stopStorage(root);
  else throw Error(`unknown installed fixture command: ${command}`);
}
if (require.main === module) main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
module.exports = { createFixture, processIdentity };
