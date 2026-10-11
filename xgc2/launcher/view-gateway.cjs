// SPDX-License-Identifier: MPL-2.0
"use strict";

const { PersistenceError } = require("./managed-storage.cjs");

// A stream whose peer stops reading is dropped rather than buffered without bound.
const MAX_STREAM_BACKLOG_BYTES = 64 * 1024;

/**
 * What the pages of the browser gateway see of the desired view: the current
 * state on request and a server-sent event stream of every change. Pages only read;
 * the view is stated through the control service. A page that opens later, or
 * reconnects, receives the current state first, so it never depends on having been
 * open when the view changed.
 */
function createViewGateway(viewStore, { heartbeatMs = 15000, maxStreams = 16 } = {}) {
  const streams = new Map();
  const frame = (state) => `id: ${state.revision}\nevent: view\ndata: ${JSON.stringify(state)}\n\n`;
  function send(response, chunk) {
    if (response.destroyed) return;
    if (response.writableLength > MAX_STREAM_BACKLOG_BYTES) response.destroy();
    else response.write(chunk);
  }
  const unsubscribe = viewStore.subscribe((state) => {
    const chunk = frame(state);
    for (const response of streams.keys()) send(response, chunk);
  });
  return {
    get streamCount() { return streams.size; },
    state(response, headers) {
      const body = Buffer.from(JSON.stringify(viewStore.state));
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", ...headers });
      response.end(body);
    },
    events(request, response, headers) {
      if (streams.size >= maxStreams) throw new PersistenceError("resource_exhausted", "too many view streams", 503);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...headers });
      const state = viewStore.state;
      // EventSource reconnects with the last id it saw; an up-to-date page needs no repeat.
      send(response, request.headers["last-event-id"] === state.revision ? ": connected\n\n" : frame(state));
      const timer = setInterval(() => send(response, ": hb\n\n"), heartbeatMs);
      streams.set(response, timer);
      response.once("close", () => { clearInterval(timer); streams.delete(response); });
    },
    /** Ends every stream; pages reconnect to the next launcher and read the state again. */
    close() {
      unsubscribe();
      for (const [response, timer] of streams) {
        clearInterval(timer);
        if (!response.destroyed) response.end("event: closing\ndata: {}\n\n");
      }
      streams.clear();
    },
  };
}

module.exports = { createViewGateway };
