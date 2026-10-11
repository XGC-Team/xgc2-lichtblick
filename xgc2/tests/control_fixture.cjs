// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: the control service and a minimal caller of its private socket.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createControlService } = require("../launcher/control-service.cjs");
const { ViewStore } = require("../launcher/view-state.cjs");

/** One HTTP call to a Unix socket; `instance` adds the fence header, `timeoutMs` the call budget. */
function rawCall(socketPath, method, target, { instance, body, headers = {}, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const request = http.request({
      socketPath, method, path: target,
      headers: {
        "X-Request-ID": randomUUID(), "X-Xrpc-Timeout-Ms": String(timeoutMs), ...(instance ? { "X-Xrpc-Instance-ID": instance } : {}),
        ...(payload === undefined ? {} : { "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json" : "application/octet-stream", "Content-Length": Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json;
        if (response.headers["content-type"]?.startsWith("application/json")) json = JSON.parse(raw.toString("utf8"));
        resolve({ status: response.statusCode, headers: response.headers, raw, json });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function startControl(t, { ready = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lichtblick-control-"));
  const viewStore = new ViewStore();
  const socketPath = path.join(root, "control.sock");
  const control = createControlService({ socketPath, viewStore, facts: () => ({ http_port: 18081 }) });
  t.after(async () => { await control.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await control.start();
  if (ready) control.markReady();
  return { root, viewStore, control, socketPath, call: (method, target, options = {}) => rawCall(socketPath, method, target, { instance: method === "GET" && target.split("?", 1)[0] === "/v1/describe" ? undefined : control.instanceId, ...options }) };
}

module.exports = { rawCall, startControl };
