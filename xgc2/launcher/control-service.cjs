// SPDX-License-Identifier: MPL-2.0
"use strict";

const { createRPCHost, newInstanceId } = require("@xgc2/xrpc");
const { MAX_WIRE_BYTES, MAX_ASSET_BYTES, CALL_TIMEOUT_MS, SHUTDOWN_MS, PersistenceError } = require("./managed-storage.cjs");

const SERVICE = "xgc2.lichtblick.v1";
const API_VERSION = "1";
// Calls held by wait_ready_ms are bounded; a held call answers shortly before its own deadline.
const MAX_DESCRIBE_WAITERS = 16;
const DESCRIBE_MARGIN_MS = 100;

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
// `wait_ready_ms=<0..30000>` is the only describe query.
function describeWait(search) {
  if (search === "") return 0;
  const match = /^\?wait_ready_ms=(0|[1-9][0-9]{0,4})$/.exec(search);
  if (!match || Number(match[1]) > 30000) throw new PersistenceError("invalid_argument", "describe takes only wait_ready_ms=<0..30000>", 400);
  return Number(match[1]);
}

/**
 * The domain service of the launcher, `xgc2.lichtblick.v1`, on a private Unix
 * socket: describe with readiness, the document persistence and extension asset
 * operations of the managed client, and the desired view. Its lifecycle belongs to
 * launcher main: `start` binds the socket while the launcher is still starting,
 * `markReady` says the launcher serves its pages, `close` drains admitted work.
 * Nothing but the socket's directory authorizes a caller.
 */
function createControlService(client, { socketPath, viewStore, diagnostics, shutdownMs = SHUTDOWN_MS, facts = () => ({}) }) {
  const instanceId = newInstanceId();
  const waiters = new Set();
  let ready = false;
  let reason = "starting";
  const document = () => ({
    service: SERVICE, api_version: API_VERSION, instance_id: instanceId, ready,
    facts: { capabilities: ["persistence.v1", "extensions.assets.v1", "view.v1"], view_revision: viewStore.state.revision, ...facts(), ...(ready ? {} : { reason }) },
  });
  const release = () => { for (const wake of [...waiters]) wake(); };
  const requireReady = () => {
    if (!ready) throw new PersistenceError("unavailable", `the launcher is ${reason}`, 503);
  };
  const waitReady = (milliseconds, context) => new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); waiters.delete(finish); context.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, Math.max(0, Math.min(milliseconds, context.deadline - Date.now() - DESCRIBE_MARGIN_MS)));
    waiters.add(finish);
    context.signal.addEventListener("abort", finish, { once: true });
  });

  const host = createRPCHost(async (request, response, context) => {
    let input;
    try {
      const url = new URL(request.url, "http://localhost");
      const route = `${request.method} ${url.pathname}`;
      if (route === "GET /v1/describe") {
        const wait = describeWait(url.search);
        if (wait > 0 && !ready) {
          if (waiters.size >= MAX_DESCRIBE_WAITERS) throw new PersistenceError("resource_exhausted", "describe waiter limit reached", 503);
          await waitReady(wait, context);
        }
        if (!response.destroyed) json(response, 200, document());
      } else if (route === "POST /v1/persistence") {
        requireReady();
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new PersistenceError("invalid_argument", "JSON domain body required", 400);
        input = JSON.parse((await body(request, MAX_WIRE_BYTES)).toString("utf8"));
        if (input.operation === "batch" && input.requestId !== context.requestId) throw new PersistenceError("conflict", "domain and transport request identities differ", 409);
        json(response, 200, await client.request(input, { requestId: context.requestId, timeoutMs: Math.max(1, context.deadline - Date.now()), signal: context.signal }));
      } else if (route === "POST /v1/extensions/assets") {
        requireReady();
        if (request.headers["content-type"] !== "application/octet-stream") throw new PersistenceError("invalid_argument", "binary archive required", 400);
        json(response, 200, await client.publish(await body(request, MAX_ASSET_BYTES), { id: url.searchParams.get("name"), version: url.searchParams.get("version") }));
      } else if (route === "POST /v1/extensions/load") {
        requireReady();
        input = JSON.parse((await body(request, 2048)).toString("utf8"));
        const bytes = await client.load(input);
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength, "Cache-Control": "no-store" });
        response.end(bytes);
      } else if (route === "GET /v1/view") {
        requireReady();
        json(response, 200, viewStore.state);
      } else if (route === "PUT /v1/view") {
        requireReady();
        if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new PersistenceError("invalid_argument", "JSON domain body required", 400);
        input = JSON.parse((await body(request, 8192)).toString("utf8"));
        if (input == null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "view" && key !== "expectedRevision") || !Object.hasOwn(input, "view")) {
          throw new PersistenceError("invalid_argument", "view update requires {view, expectedRevision?}", 400);
        }
        json(response, 200, await viewStore.set(input.view, { expectedRevision: input.expectedRevision }));
      } else throw new PersistenceError("not_found", "undeclared Lichtblick domain operation", 404);
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        json(response, error.status ?? (error instanceof SyntaxError ? 400 : 503), {
          code: error.code ?? "invalid_argument",
          message: error instanceof PersistenceError ? error.message : error instanceof SyntaxError ? "invalid JSON body" : "Lichtblick domain operation failed",
          ...(error.outcome ? { outcome: error.outcome } : {}),
          ...(input?.requestId ? { requestId: input.requestId } : {}),
        });
      }
    }
  }, {
    instanceId, unixPath: socketPath, discoveryPaths: ["/v1/describe"], diagnostics,
    maxConnections: 32, maxInFlight: 32, maxBodyBytes: MAX_ASSET_BYTES, maxResponseBytes: MAX_ASSET_BYTES,
    callTimeoutMs: CALL_TIMEOUT_MS, shutdownMs,
  });

  return {
    instanceId,
    get ready() { return ready; },
    /** Binds the socket. Calls to describe are answered from now on; everything else waits for markReady. */
    async start() { await host.listen(); },
    markReady() { ready = true; release(); },
    /** The launcher no longer serves its pages; describe says why and held calls are answered. */
    markNotReady(why) { ready = false; reason = why; release(); },
    describe: document,
    async close() { this.markNotReady("stopping"); await host.close(); },
  };
}

module.exports = { SERVICE, API_VERSION, createControlService };
