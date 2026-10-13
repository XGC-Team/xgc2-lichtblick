// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only desktop installed-package fixture. Never imported by a launcher.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const INSTALLED_SDK = "/usr/lib/xgc2/node_modules/@xgc2/xrpc";
const INSTALLED_STORAGE = "/usr/bin/xgc2-storage";
const layoutKey = JSON.stringify(["local", "installed-camera"]);
const documentKeys = [`layouts:${layoutKey}`, "profile:user", "configuration:language"];
function write(file, value) {
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), {
    mode: 0o600,
  });
}
function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function processIdentity(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return fields[0] === "Z" ? undefined : fields[19];
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
function createFixture({ sdkPath = INSTALLED_SDK, storageBinary = INSTALLED_STORAGE } = {}) {
  // Absolute paths deliberately prevent a checkout or ambient Node from masking
  // an absent installed SDK/provider. Explicit overrides exist only for unit tests.
  assert.ok(path.isAbsolute(sdkPath) && path.isAbsolute(storageBinary));
  const { HTTPClient } = require(sdkPath);
  const websocketModule = require.resolve("ws", { paths: [sdkPath] });
  const dependencyRoot = sdkPath === INSTALLED_SDK ? "/usr/lib/xgc2/node_modules" : sdkPath;
  assert.ok(
    fs.realpathSync(websocketModule).startsWith(`${fs.realpathSync(dependencyRoot)}/`),
    "ws must be owned by the explicit SDK installation",
  );
  const WebSocket = require(websocketModule);
  fs.accessSync(storageBinary, fs.constants.X_OK);
  const stateFile = (root) => path.join(root, "fixture.json");
  const save = (root, state) => write(stateFile(root), state);
  const load = (root) => read(stateFile(root));
  function privateRoot(root) {
    assert.equal(fs.realpathSync(root), root, "fixture root must be canonical");
    const stat = fs.statSync(root);
    assert.ok(
      stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
      "fixture root must be private and owned",
    );
  }
  async function stopStorage(root) {
    if (!fs.existsSync(stateFile(root))) {
      return;
    }
    const state = load(root);
    if (!state.pid || !state.pidIdentity || processIdentity(state.pid) !== state.pidIdentity) {
      return;
    }
    process.kill(state.pid, "SIGTERM");
    for (let i = 0; i < 100; i++) {
      if (processIdentity(state.pid) !== state.pidIdentity) {
        return;
      }
      await delay(50);
    }
    process.kill(state.pid, "SIGKILL");
    throw Error("formal storage provider did not drain after SIGTERM");
  }
  async function startStorage(root, state, create) {
    const refs = path.join(root, "refs.json");
    fs.rmSync(refs, { force: true });
    const log = fs.openSync(path.join(root, "storage.log"), "a", 0o600);
    const child = spawn(
      storageBinary,
      [
        "--db",
        path.join(root, "storage.db"),
        "--manifest",
        path.join(root, "manifest.json"),
        "--grants",
        path.join(root, "grants.json"),
        "--http-socket",
        path.join(root, "rpc.sock"),
        "--target-id",
        "fixture",
        "--ref-out",
        refs,
        ...(create ? ["--create"] : []),
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
    fs.closeSync(log);
    let failure;
    child.once("error", (error) => {
      failure = error;
    });
    state.pid = child.pid;
    state.pidIdentity = processIdentity(child.pid);
    save(root, state);
    child.unref();
    for (let i = 0; i < 150; i++) {
      if (failure) {
        throw failure;
      }
      assert.equal(
        child.exitCode,
        null,
        `formal storage failed: ${fs.readFileSync(path.join(root, "storage.log"), "utf8")}`,
      );
      if (fs.existsSync(refs)) {
        const references = read(refs);
        assert.equal(references.length, 1);
        state.storageRef = references[0];
        save(root, state);
        return;
      }
      await delay(20);
    }
    throw Error("formal storage did not publish an actual ServiceRef");
  }
  async function storage(state, route, body, requestId) {
    const client = new HTTPClient({ localTarget: "fixture" });
    try {
      const response = await client.call(state.storageRef, route, {
        timeoutMs: 3000,
        method: "POST",
        json: body,
        ...(requestId ? { requestId } : {}),
        headers: { Authorization: `Bearer ${state.storageToken}` },
      });
      const result = JSON.parse(response.body);
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    } finally {
      client.close();
    }
  }
  function storageSnapshot(state) {
    return storage(state, "/v1/snapshot", {
      scope: state.scope,
      queries: [{ collection: "documents", keys: Object.keys(state.expected) }],
    });
  }
  function snapshotValues(snapshot) {
    assert.equal(snapshot.results.length, 1);
    return Object.fromEntries(
      snapshot.results[0].records.map((record) => [record.key, record.data?.value]),
    );
  }
  async function prepare(root) {
    privateRoot(root);
    assert.ok(!fs.existsSync(stateFile(root)), "fixture already initialized");
    const state = {
      scope: { namespace: "lichtblick", user: "installed-smoke", workspace: "isolated" },
      storageToken: randomUUID(),
    };
    try {
      fs.copyFileSync(
        path.resolve(__dirname, "../contracts/storage-manifest.json"),
        path.join(root, "manifest.json"),
      );
      fs.chmodSync(path.join(root, "manifest.json"), 0o600);
      write(path.join(root, "grants.json"), [{ ...state.scope, token: state.storageToken }]);
      await startStorage(root, state, true);
      const camera = {
        distance: 20,
        perspective: true,
        phi: 60,
        target: [0, 0, 0],
        targetOffset: [0, 0, 0],
        targetOrientation: [0, 0, 0, 1],
        thetaOffset: 45,
        fovy: 45,
        near: 0.5,
        far: 5000,
      };
      const data = {
        configById: { "3D!installed": { cameraState: camera } },
        globalVariables: {},
        userNodes: {},
        playbackConfig: { speed: 1 },
        layout: "3D!installed",
      };
      state.expected = {
        [documentKeys[0]]: {
          id: "installed-camera",
          name: "Installed Managed Camera",
          permission: "CREATOR_WRITE",
          baseline: { data, savedAt: new Date().toISOString() },
        },
        "profile:user": {
          currentLayoutId: "installed-camera",
          firstSeenTime: new Date().toISOString(),
        },
        "configuration:language": "en",
      };
      const snapshot = await storageSnapshot(state);
      const requestId = randomUUID();
      const receipt = await storage(
        state,
        "/v1/batch",
        {
          scope: state.scope,
          expected: snapshot.token,
          request_id: requestId,
          mutations: documentKeys.map((key) => {
            const family = key.slice(0, key.indexOf(":"));
            return {
              collection: "documents",
              key,
              expected_version: "0",
              data: { family, key: key.slice(family.length + 1), value: state.expected[key] },
            };
          }),
        },
        requestId,
      );
      assert.equal(receipt.durability, "sqlite-full");
      assert.equal(receipt.request_id, requestId);
      assert.equal(receipt.versions.length, 3);
      write(path.join(root, "storage-token"), state.storageToken);
      fs.mkdirSync(path.join(root, "assets"), { mode: 0o700 });
      write(path.join(root, "startup-input.json"), {
        schema_version: 1,
        operator_time_zone: "Etc/UTC",
        storage: {
          reference: state.storageRef,
          scope: state.scope,
          token_file: path.join(root, "storage-token"),
        },
        assets: { root: path.join(root, "assets"), access: "read-write" },
      });
      save(root, state);
    } catch (error) {
      await stopStorage(root);
      throw error;
    }
  }
  const failurePattern =
    /Desktop initialization failed|Error occurred in the main process|renderer process.*(crash|gone)/i;
  /** Waits for the line an application prints when it is up: the ready line of the desktop. */
  async function awaitStarted(logFile, seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const log = fs.readFileSync(logFile, "utf8");
      assert.ok(!failurePattern.test(log), log);
      if (log.split("\n").some((line) => line === '{"type":"ready"}')) {
        return;
      }
      await delay(100);
    }
    throw Error(`application readiness timed out: ${fs.readFileSync(logFile, "utf8")}`);
  }
  async function verifyDesktop(root, logFile, seconds = 25) {
    await awaitStarted(logFile, seconds);
    const deadline = Date.now() + seconds * 1000;
    let page;
    while (Date.now() < deadline) {
      const devtools = /DevTools listening on (ws:\/\/127\.0\.0\.1:[0-9]+\/[^\s]+)/.exec(
        fs.readFileSync(logFile, "utf8"),
      )?.[1];
      if (devtools) {
        const origin = new URL(devtools);
        origin.protocol = "http:";
        origin.pathname = "/json/list";
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 200);
        page = (await response.json()).find(
          (target) => target.type === "page" && target.url.startsWith("file:"),
        );
        if (page) {
          break;
        }
      }
      await delay(100);
    }
    assert.ok(page?.webSocketDebuggerUrl, "installed renderer did not publish a CDP page");
    const socket = new WebSocket(page.webSocketDebuggerUrl, { handshakeTimeout: 2000 });
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    socket.on("message", (bytes) => {
      const message = JSON.parse(bytes);
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params.exceptionDetails);
      }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        if (message.error) {
          request.reject(Error(JSON.stringify(message.error)));
        } else {
          request.resolve(message.result);
        }
      }
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`CDP ${method} timed out`));
        }, 2000);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    try {
      await new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await call("Runtime.enable");
      while (Date.now() < deadline) {
        assert.deepEqual(errors, [], "installed renderer threw an exception");
        const result = await call("Runtime.evaluate", {
          returnByValue: true,
          expression: `JSON.stringify({text:document.body?.innerText??"",alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.innerText),canvas:[...document.querySelectorAll('[data-testid*="panel-mouseenter-container"][data-testid*="3D!installed"] canvas')].some(e=>e.width>0&&e.height>0&&e.getBoundingClientRect().width>0)})`,
        });
        assert.deepEqual(errors, [], "installed renderer threw an exception");
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        const ui = JSON.parse(result.result.value);
        assert.ok(
          !ui.alerts.some((text) => /failed|error|unavailable|unable/i.test(text)),
          JSON.stringify(ui),
        );
        assert.ok(
          !/something went wrong|failed to initialize|persistence unavailable/i.test(ui.text),
          JSON.stringify(ui),
        );
        if (ui.canvas) {
          write(path.join(root, "renderer-proof.json"), ui);
          return;
        }
        await delay(100);
      }
      throw Error("installed renderer did not restore the seeded managed 3D layout");
    } finally {
      socket.terminate();
    }
  }
  async function verifyRestart(root) {
    const state = load(root);
    const previous = state.storageRef.instance_id;
    await stopStorage(root);
    await startStorage(root, state, false);
    assert.notEqual(
      state.storageRef.instance_id,
      previous,
      "storage restart reused the former instance",
    );
    assert.deepEqual(
      snapshotValues(await storageSnapshot(state)),
      state.expected,
      "SQLite FULL records did not survive formal provider restart",
    );
  }
  async function verifyClosed(root) {
    if (fs.existsSync(path.join(root, "renderer-proof.json"))) {
      // Opening the 3D panel persists its normalized working configuration.
      // After the renderer exits, check its saved semantics, then retain that
      // exact acknowledged snapshot as the provider-restart oracle.
      const state = load(root);
      const saved = snapshotValues(await storageSnapshot(state));
      const expected = state.expected[documentKeys[0]];
      const layout = saved[documentKeys[0]];
      assert.deepEqual(Object.keys(saved).sort(), documentKeys.slice().sort());
      for (const key of ["id", "name", "permission", "baseline"]) {
        assert.deepEqual(layout[key], expected[key], `renderer changed saved layout ${key}`);
      }
      assert.deepEqual(saved["profile:user"], state.expected["profile:user"]);
      assert.equal(saved["configuration:language"], state.expected["configuration:language"]);
      if (layout.working) {
        const original = expected.baseline.data;
        const working = layout.working.data;
        for (const key of ["layout", "globalVariables", "userNodes", "playbackConfig"]) {
          assert.deepEqual(working[key], original[key]);
        }
        const camera = working.configById["3D!installed"].cameraState;
        for (const [key, value] of Object.entries(
          original.configById["3D!installed"].cameraState,
        )) {
          assert.deepEqual(camera[key], value, `renderer changed camera ${key}`);
        }
      }
      state.expected = saved;
      save(root, state);
    }
    await verifyRestart(root);
  }
  return {
    prepare,
    verifyDesktop,
    verifyClosed,
    verifyRestart,
    stopStorage,
    storageSnapshot,
    snapshotValues,
    load,
  };
}

async function main() {
  const [command, root, log, seconds] = process.argv.slice(2);
  assert.ok(root && path.isAbsolute(root), "absolute private fixture root required");
  if (!Object.is(seconds, undefined)) {
    assert.ok(
      Number.isFinite(Number(seconds)) && Number(seconds) > 0 && Number(seconds) <= 120,
      "readiness timeout must be 1..120 seconds",
    );
  }
  const fixture = createFixture();
  if (command === "prepare") {
    await fixture.prepare(root);
  } else if (command === "verify-desktop") {
    await fixture.verifyDesktop(
      root,
      log,
      Object.is(seconds, undefined) ? undefined : Number(seconds),
    );
  } else if (command === "verify-closed") {
    await fixture.verifyClosed(root);
  } else if (command === "stop") {
    await fixture.stopStorage(root);
  } else {
    throw Error(`unknown installed fixture command: ${command}`);
  }
}
if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}
module.exports = { createFixture, processIdentity };
