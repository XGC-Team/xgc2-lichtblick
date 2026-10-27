// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  FromWorkerMessage,
  ToWorkerMessage,
  WebSocketMessage,
} from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";

import {
  WORKER_BATCH_MAXIMUM_MESSAGES,
  WORKER_BATCH_TARGET_SIZE_BYTES,
  WORKER_BUFFER_MAXIMUM_MESSAGES,
  WORKER_BUFFER_MAXIMUM_SIZE_BYTES,
} from "./constants";

type PendingFrame = { data: WebSocketMessage; size: number; next?: PendingFrame };
type Connection = {
  socket: WebSocket;
  closed: boolean;
  closeReported: boolean;
  head?: PendingFrame;
  tail?: PendingFrame;
  bytes: number;
  count: number;
  inFlight?: { id: number; count: number; bytes: number };
};

let connection: Connection | undefined;
let nextBatchId = 0;

const send: (message: FromWorkerMessage) => void = self.postMessage;
const sendWithTransfer: (message: FromWorkerMessage, transfer: Transferable[]) => void =
  self.postMessage;

function clear(current: Connection): void {
  current.head = undefined;
  current.tail = undefined;
  current.inFlight = undefined;
  current.bytes = 0;
  current.count = 0;
}

function closed(current: Connection, data: unknown): void {
  if (connection !== current || current.closeReported) {
    return;
  }
  current.closed = true;
  current.closeReported = true;
  clear(current);
  send({ type: "close", data });
}

function fail(current: Connection, reason: string): void {
  if (connection !== current || current.closed) {
    return;
  }
  send({ type: "error", error: new Error(reason) });
  // Client WebSocket.close accepts application codes 3000..4999. Report the
  // failure now instead of waiting for a possibly stalled close handshake.
  closed(current, { code: 4009, reason });
  current.socket.close(4009, reason);
}

function deliver(current: Connection): void {
  if (current.closed || current.inFlight || !current.head) {
    return;
  }
  const messages: WebSocketMessage[] = [];
  const transfer: ArrayBuffer[] = [];
  let bytes = 0;
  while (current.head && messages.length < WORKER_BATCH_MAXIMUM_MESSAGES) {
    const next: PendingFrame = current.head;
    if (messages.length > 0 && bytes + next.size > WORKER_BATCH_TARGET_SIZE_BYTES) {
      break;
    }
    current.head = next.next;
    if (!current.head) {
      current.tail = undefined;
    }
    messages.push(next.data);
    bytes += next.size;
    if (next.data instanceof ArrayBuffer) {
      transfer.push(next.data);
    }
    // A legal large frame is transferred whole and alone, never truncated.
    if (bytes >= WORKER_BATCH_TARGET_SIZE_BYTES) {
      break;
    }
  }
  const id = ++nextBatchId;
  current.inFlight = { id, count: messages.length, bytes };
  sendWithTransfer({ type: "messages", id, messages }, transfer);
}

function enqueue(current: Connection, data: unknown): void {
  if (connection !== current || current.closed) {
    return;
  }
  if (typeof data !== "string" && !(data instanceof ArrayBuffer)) {
    fail(current, "Unsupported WebSocket payload");
    return;
  }
  const size = typeof data === "string" ? data.length * 2 : data.byteLength;
  if (
    current.count >= WORKER_BUFFER_MAXIMUM_MESSAGES ||
    size > WORKER_BUFFER_MAXIMUM_SIZE_BYTES - current.bytes
  ) {
    fail(current, "WebSocket worker delivery capacity exceeded");
    return;
  }
  const frame: PendingFrame = { data, size };
  if (current.tail) {
    current.tail.next = frame;
  } else {
    current.head = frame;
  }
  current.tail = frame;
  current.bytes += size;
  current.count++;
  deliver(current);
}

self.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const { type, data } = event.data;
  switch (type) {
    case "open":
      try {
        if (connection) {
          connection.closed = true;
          connection.closeReported = true;
          clear(connection);
          connection.socket.close();
        }
        connection = undefined;
        const socket = new WebSocket(data.wsUrl, data.protocols);
        const current: Connection = {
          socket,
          closed: false,
          closeReported: false,
          bytes: 0,
          count: 0,
        };
        connection = current;
        socket.binaryType = "arraybuffer";
        socket.onerror = (wsEvent) => {
          if (connection !== current || current.closed) {
            return;
          }
          send({
            type: "error",
            error: (wsEvent as unknown as { error: Error }).error,
          });
        };
        socket.onopen = (_event) => {
          if (connection !== current || current.closed) {
            return;
          }
          send({
            type: "open",
            protocol: socket.protocol,
          });
        };
        socket.onclose = (wsEvent) => {
          closed(current, JSON.parse(JSON.stringify(wsEvent) ?? "{}"));
        };
        socket.onmessage = (wsEvent: MessageEvent<unknown>) => {
          enqueue(current, wsEvent.data);
        };
      } catch (err: unknown) {
        // try-catch is needed to catch `Mixed Content` errors in Chrome, where the client
        // attempts to load `ws://` from `https://`. (Safari would catch these in `ws.onerror`
        // but with `undefined` as an error.)
        send({
          type: "error",
          error: err ?? { message: "Insecure WebSocket connection" },
        });
        send({ type: "close", data: { code: 1006 } });
      }
      break;
    case "close":
      if (connection?.closed === false) {
        connection.closed = true;
        clear(connection);
        connection.socket.close();
      }
      break;
    case "consumed": {
      const current = connection;
      const batch = current?.inFlight;
      if (current?.closed !== false || batch?.id !== data.id) {
        break;
      }
      if (data.count !== batch.count) {
        fail(current, "WebSocket message consumer did not consume the complete batch");
        break;
      }
      current.inFlight = undefined;
      current.bytes -= batch.bytes;
      current.count -= batch.count;
      deliver(current);
      break;
    }
    case "data":
      if (connection?.closed === false) {
        connection.socket.send(data as string | BufferSource);
      }
      break;
  }
};
