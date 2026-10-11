// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: the control service over the fake storage, and a minimal caller of it.
const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createControlService } = require("../launcher/control-service.cjs");
const { ViewStore } = require("../launcher/view-state.cjs");
const { startStorage } = require("./storage_fixture.cjs");

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

/** The check a launcher uses: the smallest read of the pages' scope, so a replaced or stopped storage rejects it. */
function storageCheck(client) {
  return async () => { await client.request({ operation: "snapshot", keys: [{ family: "profile", key: "user" }] }, { timeoutMs: 1000 }); };
}

async function startControl(t, { ready = true, access, monitor } = {}) {
  const base = await startStorage(t, { access });
  const viewStore = new ViewStore(base.client);
  await viewStore.load();
  const socketPath = path.join(base.root, "control.sock");
  const changes = [];
  const dependency = monitor ? { check: storageCheck(base.client), intervalMs: monitor, onChange: (change) => changes.push(change) } : undefined;
  const control = createControlService(base.client, { socketPath, viewStore, dependency, facts: () => ({ http_port: 18081 }) });
  await control.start();
  t.after(() => control.close());
  if (ready) control.markReady();
  return { ...base, viewStore, control, socketPath, changes, call: (method, target, options = {}) => rawCall(socketPath, method, target, { instance: control.instanceId, ...options }) };
}

module.exports = { rawCall, startControl };
