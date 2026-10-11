// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: the actual launcher process over the fake storage.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { rawCall } = require("./control_fixture.cjs");
const { startStorage } = require("./storage_fixture.cjs");
const { writeStartupInput } = require("./input_fixture.cjs");

const LAUNCHER = path.resolve(__dirname, "../launcher/xgc2-lichtblick-web.js");
const ORIGIN = "http://studio.test";

function writeWebRoot(root) {
  const web = path.join(root, "web");
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<!doctype html><html><head></head><body>fixture</body></html>");
  const buildInfo = path.join(root, "build-info.json");
  fs.writeFileSync(buildInfo, JSON.stringify({ schema: "xgc2.lichtblick-web.build.v1", package: "xgc2-lichtblick-web", version: "1.27.0-1~test", upstreamSha: "1".repeat(40) }));
  return { web, buildInfo };
}

/**
 * Starts the launcher with a fresh private directory, a fake storage and a control socket.
 * `prepare({web, root})` may add files to the web root first; `stdin` is written to the
 * launcher (with `layoutStdin` it is the prepared layout); `arguments` replaces the whole command
 * line, either as a list or as a function of the `{root, input, socketPath}` the fixture allocated.
 */
async function startLauncher(t, { storage: storageOptions, arguments: extra, environment, controlPlane = "ws://127.0.0.1:9", allowedOrigins = [ORIGIN],
  frameAncestors = "'self'", stdin, layoutStdin = false, prepare } = {}) {
  const base = await startStorage(t, { ...storageOptions, client: false });
  const { root, assets, storage, scope, viewScope } = base;
  const { web, buildInfo } = writeWebRoot(root);
  prepare?.({ web, root });
  const socketPath = path.join(root, "control.sock");
  const input = writeStartupInput(root, { reference: storage.reference, scope, viewScope, assets });
  const args = (typeof extra === "function" ? extra({ root, input, socketPath }) : extra) ?? ["--startup-input", input, "--control-socket", socketPath, "--host", "127.0.0.1", "--port", "0",
    "--control-plane-url", controlPlane, "--frame-ancestors", frameAncestors, ...allowedOrigins.flatMap((origin) => ["--allowed-origin", origin]),
    ...(layoutStdin ? ["--layout-stdin"] : [])];
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    env: { ...process.env, XGC2_LICHTBLICK_WEB_STATIC_ROOT: web, XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfo, XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(root, "absent.env"), ALLOWED_ORIGINS: "", FRAME_ANCESTORS: "", ...environment },
    stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (stdin !== undefined) child.stdin.end(stdin);
  const launcher = { child, output: "", errors: "", socketPath, input, port: undefined, base: undefined };
  child.stdout.on("data", (chunk) => { launcher.output += chunk; });
  child.stderr.on("data", (chunk) => { launcher.errors += chunk; });
  launcher.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await launcher.exited; }
  });
  launcher.waitForPort = async (milliseconds = 8000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const match = /serving Lichtblick web bundle on http:\/\/127\.0\.0\.1:(\d+)/.exec(launcher.output);
      if (match) { launcher.port = Number(match[1]); launcher.base = `http://127.0.0.1:${launcher.port}`; return launcher.port; }
      if (child.exitCode !== null) throw new Error(`launcher exited ${child.exitCode}\n${launcher.output}\n${launcher.errors}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`launcher did not listen\n${launcher.output}\n${launcher.errors}`);
  };
  /** The control service as Core calls it: discovery first, then calls bound to the instance it reported. */
  launcher.control = async () => {
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        const described = await rawCall(socketPath, "GET", "/v1/describe");
        const instance = described.json.instance_id;
        return { instance, described: described.json, call: (method, target, options = {}) => rawCall(socketPath, method, target, { instance, ...options }) };
      } catch (error) {
        if (Date.now() > deadline || child.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  launcher.stop = async (signal = "SIGTERM") => { child.kill(signal); return await launcher.exited; };
  return { ...base, launcher, web, buildInfo, socketPath, input };
}

module.exports = { LAUNCHER, ORIGIN, startLauncher, writeWebRoot };
