// SPDX-License-Identifier: MPL-2.0
"use strict";

const { randomUUID } = require("node:crypto");
const { BootstrapBinding, createBoundHTTPHost } = require("@xgc2/xrpc");
const { MAX_WIRE_BYTES, MAX_ASSET_BYTES, PersistenceError } = require("./managed-storage.cjs");

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length, "Cache-Control": "no-store" });
  response.end(body);
}
async function body(request, limit) {
  if (Number(request.headers["content-length"] ?? 0) > limit) throw new PersistenceError("resource_exhausted", "domain body exceeds limit", 413);
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new PersistenceError("resource_exhausted", "domain body exceeds limit", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
/** Thin native HTTPS adapter. Its lifecycle belongs to launcher/app main. */
function createManagedDomainRPC(client, { binding, resolveGrant, policy }) {
  if (!(binding instanceof BootstrapBinding) || binding.service !== "xgc2.lichtblick.v1.Lichtblick" || binding.api_version !== "1" || binding.profile !== "http.v1" || binding.endpoint.kind !== "https") throw new PersistenceError("invalid_argument", "current Lichtblick HTTPS BootstrapBinding required");
  const origin = new URL(binding.endpoint.address);
  const instanceId = randomUUID();
  let reference;
  if (!policy || typeof policy.effective !== "function") throw new PersistenceError("invalid_argument", "composition-owned resolved runtime policy required");
  const host = createBoundHTTPHost(async (request, response, context) => {
    let input;
    try {
      const url = new URL(request.url, origin);
      if (request.method === "GET" && url.pathname === "/v1/describe") {
        json(response, 200, { service_ref: reference, capabilities: ["persistence.v1", "extensions.assets.v1"] });
      } else if (request.method === "POST" && url.pathname === "/v1/persistence") {
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new PersistenceError("invalid_argument", "JSON domain body required");
        input = JSON.parse((await body(request, MAX_WIRE_BYTES)).toString("utf8"));
        if (input.operation === "batch" && input.requestId !== context.requestId) throw new PersistenceError("conflict", "domain and transport request identities differ", 409);
        json(response, 200, await client.request(input, { requestId: context.requestId, timeoutMs: Math.max(1, context.deadline - Date.now()), signal: context.signal }));
      } else if (request.method === "POST" && url.pathname === "/v1/extensions/assets") {
        if (request.headers["content-type"] !== "application/octet-stream") throw new PersistenceError("invalid_argument", "binary archive required");
        json(response, 200, await client.publish(await body(request, MAX_ASSET_BYTES), { id: url.searchParams.get("name"), version: url.searchParams.get("version") }));
      } else if (request.method === "POST" && url.pathname === "/v1/extensions/load") {
        input = JSON.parse((await body(request, 2048)).toString("utf8"));
        const bytes = await client.load(input);
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength, "Cache-Control": "no-store" }); response.end(bytes);
      } else throw new PersistenceError("not_found", "undeclared Lichtblick domain operation", 404);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) json(response, error.status ?? (error instanceof SyntaxError ? 400 : 503), { code: error.code ?? "invalid_argument", message: error instanceof PersistenceError ? error.message : "Lichtblick domain operation failed", ...(error.outcome ? { outcome: error.outcome } : {}), ...(input?.requestId ? { requestId: input.requestId } : {}) });
    }
  }, { binding, resolveGrant, instanceId, discoveryPaths: ["/v1/describe"], policy });
  let state = "new";
  return {
    async start() {
      if (state !== "new") throw new Error("Lichtblick RPC owner cannot restart");
      await client.ready;
      state = "starting";
      await new Promise((resolve, reject) => {
        host.server.once("error", reject);
        host.server.listen(Number(origin.port || 443), origin.hostname, () => { host.server.removeListener("error", reject); resolve(); });
      });
      const bound = host.server.address();
      origin.port = String(bound.port);
      reference = { ...binding.serviceRef(instanceId), endpoint: { kind: "https", address: origin.origin } };
      state = "running";
      return reference;
    },
    async close() { await host.close(); state = "closed"; },
    get reference() { return reference; },
  };
}
module.exports = { createManagedDomainRPC };
