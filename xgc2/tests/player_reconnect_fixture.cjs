// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
"use strict";

// Exercise the production player and browser worker in Node without installing
// the UI monorepo. Only the logger and JSON schema codec are test doubles.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const vm = require("node:vm");
const { Worker: NodeWorker } = require("node:worker_threads");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "../..");
const PLAYER = path.join(ROOT, "packages/suite-base/src/players/FoxgloveWebSocketPlayer");

function playerHarness({ url, workers = true, jitter = () => 0.5, logger = console } = {}) {
  const stats = { attempts: 0, activeWorkers: 0, maximumWorkers: 0, latest: undefined };
  const instances = new Set();
  const exits = [];
  const compiledWorker = ts.transpileModule(
    fs.readFileSync(path.join(PLAYER, "worker.ts"), "utf8"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  const compiledConstants = ts.transpileModule(
    fs.readFileSync(path.join(PLAYER, "constants.ts"), "utf8"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  // An eval worker resolves modules from the working directory, not from this file:
  // load the compiled constants with the worker's own require, then run the actual
  // compiled worker with a local require for its one relative import.
  const workerCode = `const { parentPort } = require("node:worker_threads");
    const NativeWebSocket = require(${JSON.stringify(require.resolve("ws"))});
    class WebSocket extends NativeWebSocket {
      constructor(url, protocols) { super(url, protocols, { origin: new URL(url).origin.replace(/^ws/, "http") }); }
    }
    const self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    parentPort.on("message", (data) => self.onmessage({ data }));
    const constantsModule = { exports: {} };
    (function(require, module, exports) { ${compiledConstants} })(require, constantsModule, constantsModule.exports);
    const workerModule = { exports: {} };
    (function(require, module, exports) { ${compiledWorker} })((name) => name === "./constants" ? constantsModule.exports : require(name), workerModule, workerModule.exports);`;
  class BrowserWorker {
    constructor() {
      stats.attempts++;
      stats.activeWorkers++;
      stats.maximumWorkers = Math.max(stats.maximumWorkers, stats.activeWorkers);
      this.worker = new NodeWorker(workerCode, { eval: true });
      instances.add(this);
      exits.push(
        new Promise((resolve) =>
          this.worker.once("exit", () => {
            stats.activeWorkers--;
            instances.delete(this);
            resolve();
          }),
        ),
      );
      this.worker.on("message", (data) => this.onmessage?.({ data }));
      this.worker.on("error", (error) => this.onerror?.(error));
    }
    postMessage(message) {
      this.worker.postMessage(message);
    }
    terminate() {
      void this.worker.terminate();
    }
  }
  const NativeWebSocket = require("ws");
  class RecordedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols, { origin: new URL(url).origin.replace(/^ws/, "http") });
      stats.attempts++;
      exits.push(new Promise((resolve) => this.once("close", resolve)));
    }
  }
  const math = Object.create(Math);
  math.random = jitter;
  const context = vm.createContext({
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    Map,
    Set,
    Uint8Array,
    ArrayBuffer,
    DataView,
    BigInt,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: logger,
    Math: math,
    WebSocket: RecordedWebSocket,
    Worker: workers ? BrowserWorker : undefined,
  });
  const cache = new Map();
  const doubles = {
    "@lichtblick/log": { __esModule: true, default: { getLogger: () => logger } },
    "@lichtblick/mcap-support": {
      parseChannel: ({ schema }) => ({
        datatypes: new Map([[schema.name, { name: schema.name, definitions: [] }]]),
        deserialize: (data) =>
          JSON.parse(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString()),
      }),
    },
  };
  function load(filename) {
    if (cache.has(filename)) {
      return cache.get(filename).exports;
    }
    const module = { exports: {} };
    cache.set(filename, module);
    const source = fs
      .readFileSync(filename, "utf8")
      .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href));
    const { outputText, diagnostics } = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
      reportDiagnostics: true,
      fileName: filename,
    });
    if (diagnostics.length) {
      throw new Error(
        ts.formatDiagnostics(diagnostics, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => ROOT,
          getNewLine: () => "\n",
        }),
      );
    }
    const localRequire = (name) => {
      if (Object.hasOwn(doubles, name)) {
        return doubles[name];
      }
      if (name === "@lichtblick/den/async") {
        return {
          debouncePromise: load(path.join(ROOT, "packages/den/async/debouncePromise.ts")).default,
        };
      }
      if (name.startsWith("@lichtblick/suite-base/")) {
        return load(
          path.join(
            ROOT,
            "packages/suite-base/src",
            name.slice("@lichtblick/suite-base/".length) + ".ts",
          ),
        );
      }
      if (name.startsWith(".")) {
        return load(path.resolve(path.dirname(filename), name + ".ts"));
      }
      return require(name);
    };
    new vm.Script(
      `(function(require, module, exports, __dirname, __filename) {\n${outputText}\n})`,
      { filename },
    ).runInContext(context)(localRequire, module, module.exports, path.dirname(filename), filename);
    return module.exports;
  }
  const Player = load(path.join(PLAYER, "index.ts")).default;
  const player = new Player({
    url,
    sourceId: "foxglove-websocket",
    metricsCollector: { playerConstructed() {}, setProperty() {} },
  });
  player.setListener(async (state) => {
    stats.latest = state;
  });
  return {
    player,
    stats,
    load,
    context,
    async stop() {
      player.close();
      for (const worker of instances) {
        worker.terminate();
      }
      await Promise.all(exits);
    },
  };
}

// The long test owns this child, including every worker, socket and timer.
if (require.main === module) {
  const harness = playerHarness({ url: process.argv[2] });
  harness.player.setSubscriptions([{ topic: "/first" }]);
  harness.player.setPublishers([{ topic: "/publish-first", schemaName: "test.Value" }]);
  process.on("message", async (message) => {
    if (message === "snapshot") {
      process.send(harness.stats);
    }
    if (message === "latest") {
      harness.player.setSubscriptions([{ topic: "/latest" }]);
      harness.player.setPublishers([{ topic: "/publish-latest", schemaName: "test.Value" }]);
      process.send({ updated: true });
    }
    if (message === "stop") {
      await harness.stop();
      process.disconnect();
    }
  });
  process.send({ started: true });
}

module.exports = { PLAYER, playerHarness };
