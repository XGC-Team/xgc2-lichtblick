// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

const { createRPCHost, newInstanceId } = require("@xgc2/xrpc");

const { ViewError } = require("./view-state.cjs");

const SERVICE = "xgc2.lichtblick.v1";
const API_VERSION = "1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CALL_TIMEOUT_MS = 15000;
const SHUTDOWN_MS = 16000;
// Calls held by wait_ready_ms are bounded; a held call answers shortly before its own deadline.
const MAX_DESCRIBE_WAITERS = 16;
const DESCRIBE_MARGIN_MS = 100;

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}
async function body(request, limit) {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    throw new ViewError("resource_exhausted", "domain body exceeds limit", 413);
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      throw new ViewError("resource_exhausted", "domain body exceeds limit", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}
// `wait_ready_ms=<0..30000>` is the only describe query.
function describeWait(search) {
  if (search === "") {
    return 0;
  }
  const match = /^\?wait_ready_ms=(0|[1-9][0-9]{0,4})$/.exec(search);
  if (!match || Number(match[1]) > 30000) {
    throw new ViewError("invalid_argument", "describe takes only wait_ready_ms=<0..30000>", 400);
  }
  return Number(match[1]);
}

/**
 * The web launcher's domain service on its private Unix socket: describe,
 * health and the desired view. It listens during startup so Core can hold an
 * unbound readiness call until the page listener is up. Nothing but the socket
 * directory authorizes callers; the XRPC host owns the instance fence and drain.
 */
function createControlService({
  socketPath,
  viewStore,
  diagnostics,
  shutdownMs = SHUTDOWN_MS,
  facts = () => ({}),
}) {
  const instanceId = newInstanceId();
  const waiters = new Set();
  let launcherReady = false;
  let reason = "starting";
  const document = () => ({
    service: SERVICE,
    api_version: API_VERSION,
    instance_id: instanceId,
    ready: launcherReady,
    facts: {
      capabilities: ["view.v1", "viewpoint.v1"],
      view_revision: viewStore.state.revision,
      ...facts(),
      ...(launcherReady ? {} : { reason }),
    },
  });
  const release = () => {
    for (const wake of [...waiters]) {
      wake();
    }
  };
  const requireReady = () => {
    if (!launcherReady) {
      throw new ViewError("unavailable", `the launcher is ${reason}`, 503);
    }
  };
  const waitReady = (milliseconds, context) =>
    new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        waiters.delete(finish);
        context.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(
        finish,
        Math.max(0, Math.min(milliseconds, context.deadline - Date.now() - DESCRIBE_MARGIN_MS)),
      );
      waiters.add(finish);
      context.signal.addEventListener("abort", finish, { once: true });
    });

  const host = createRPCHost(
    async (request, response, context) => {
      try {
        const url = new URL(request.url, "http://localhost");
        const route = `${request.method} ${url.pathname}`;
        if (route === "GET /v1/describe") {
          const wait = describeWait(url.search);
          if (wait > 0 && !launcherReady) {
            if (waiters.size >= MAX_DESCRIBE_WAITERS) {
              throw new ViewError("resource_exhausted", "describe waiter limit reached", 503);
            }
            await waitReady(wait, context);
          }
          if (!response.destroyed) {
            json(response, 200, document());
          }
        } else if (route === "GET /v1/health") {
          requireReady();
          json(response, 200, { status: "ok" });
        } else if (route === "GET /v1/viewpoints") {
          requireReady();
          json(response, 200, { items: viewStore.viewpoints });
        } else if (route === "GET /v1/view") {
          requireReady();
          json(response, 200, viewStore.state);
        } else if (route === "PUT /v1/view") {
          requireReady();
          if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
            throw new ViewError("invalid_argument", "JSON domain body required", 400);
          }
          const input = JSON.parse((await body(request, 8192)).toString("utf8"));
          if (
            input == null ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => key !== "view" && key !== "expectedRevision") ||
            !Object.hasOwn(input, "view")
          ) {
            throw new ViewError(
              "invalid_argument",
              "view update requires {view, expectedRevision?}",
              400,
            );
          }
          json(
            response,
            200,
            await viewStore.set(input.view, { expectedRevision: input.expectedRevision }),
          );
        } else {
          throw new ViewError("not_found", "undeclared Lichtblick domain operation", 404);
        }
      } catch (error) {
        if (!response.destroyed && !response.headersSent) {
          json(response, error.status ?? (error instanceof SyntaxError ? 400 : 503), {
            code: error.code ?? "invalid_argument",
            message:
              error instanceof ViewError
                ? error.message
                : error instanceof SyntaxError
                  ? "invalid JSON body"
                  : "Lichtblick domain operation failed",
          });
        }
      }
    },
    {
      instanceId,
      unixPath: socketPath,
      discoveryPaths: ["/v1/describe"],
      diagnostics,
      maxConnections: 32,
      maxInFlight: 32,
      maxBodyBytes: MAX_BODY_BYTES,
      maxResponseBytes: MAX_BODY_BYTES,
      callTimeoutMs: CALL_TIMEOUT_MS,
      shutdownMs,
    },
  );

  return {
    instanceId,
    // eslint-disable-next-line no-restricted-syntax -- Read-only property is part of the native control interface.
    get ready() {
      return launcherReady;
    },
    async start() {
      await host.listen();
    },
    markReady() {
      launcherReady = true;
      release();
    },
    markNotReady(why) {
      launcherReady = false;
      reason = why;
      release();
    },
    describe: document,
    async close() {
      this.markNotReady("stopping");
      await host.close();
    },
  };
}

module.exports = { SERVICE, API_VERSION, MAX_BODY_BYTES, SHUTDOWN_MS, createControlService };
