// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: the actual launcher process with one high-level view input.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { rawCall } = require("./control_fixture.cjs");

const LAUNCHER = path.resolve(__dirname, "../launcher/xgc2-lichtblick-web.js");
const ORIGIN = "http://studio.test";

function writeWebRoot(root) {
  const web = path.join(root, "web");
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(
    path.join(web, "index.html"),
    "<!doctype html><html><head></head><body>fixture</body></html>",
  );
  const buildInfo = path.join(root, "build-info.json");
  fs.writeFileSync(
    buildInfo,
    JSON.stringify({
      schema: "xgc2.lichtblick-web.build.v1",
      package: "xgc2-lichtblick-web",
      version: "1.27.0-1~test",
      upstreamSha: "1".repeat(40),
    }),
  );
  return { web, buildInfo };
}

/**
 * Starts the launcher with a fresh private directory and a control socket.
 * `prepare({web, root})` may add files to the web root first; `stdin` is written to the
 * launcher as the high-level view input; `arguments` replaces the whole command
 * line, either as a list or as a function of the `{root, socketPath}` the fixture allocated.
 */
async function startLauncher(
  t,
  {
    runtimeDirectory,
    arguments: extra,
    environment,
    controlPlane = "ws://127.0.0.1:9",
    allowedOrigins = [ORIGIN],
    frameAncestors = "'self'",
    stdin = JSON.stringify(require("../launcher/testdata/frozen-layouts.json")[0].input),
    prepare,
  } = {},
) {
  const root = runtimeDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "lichtblick-launcher-"));
  const { web, buildInfo } = writeWebRoot(root);
  prepare?.({ web, root });
  const socketPath = path.join(root, "control.sock");
  const args = (typeof extra === "function" ? extra({ root, socketPath }) : extra) ?? [
    "--control-socket",
    socketPath,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--control-plane-url",
    controlPlane,
    "--frame-ancestors",
    frameAncestors,
    ...allowedOrigins.flatMap((origin) => ["--allowed-origin", origin]),
    "--view-input-stdin",
  ];
  const child = spawn(process.execPath, [LAUNCHER, ...args], {
    env: {
      ...process.env,
      XGC2_LICHTBLICK_WEB_STATIC_ROOT: web,
      XGC2_LICHTBLICK_WEB_BUILD_INFO: buildInfo,
      XGC2_LICHTBLICK_WEB_ENV_FILE: path.join(root, "absent.env"),
      ALLOWED_ORIGINS: "",
      FRAME_ANCESTORS: "",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(stdin);
  const launcher = { child, output: "", errors: "", socketPath, port: undefined, base: undefined };
  child.stdout.on("data", (chunk) => {
    launcher.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    launcher.errors += chunk;
  });
  launcher.exited = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    if (Object.is(child.exitCode, null) && Object.is(child.signalCode, null)) {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await launcher.exited;
    } finally {
      clearTimeout(timer);
      if (Object.is(runtimeDirectory, undefined)) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
  launcher.waitForPort = async (milliseconds = 8000) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const match = /serving Lichtblick web bundle on http:\/\/127\.0\.0\.1:(\d+)/.exec(
        launcher.output,
      );
      if (match) {
        launcher.port = Number(match[1]);
        launcher.base = `http://127.0.0.1:${launcher.port}`;
        return launcher.port;
      }
      if (!Object.is(child.exitCode, null)) {
        throw new Error(
          `launcher exited ${child.exitCode}\n${launcher.output}\n${launcher.errors}`,
        );
      }
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
        return {
          instance,
          described: described.json,
          call: (method, target, options = {}) =>
            rawCall(socketPath, method, target, { instance, ...options }),
        };
      } catch (error) {
        if (Date.now() > deadline || !Object.is(child.exitCode, null)) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  };
  launcher.stop = async (signal = "SIGTERM") => {
    child.kill(signal);
    return await launcher.exited;
  };
  return { root, launcher, web, buildInfo, socketPath };
}

module.exports = { LAUNCHER, ORIGIN, startLauncher, writeWebRoot };
