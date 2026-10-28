// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { IWebSocket } from "@foxglove/ws-protocol";

import { ToWorkerMessage, FromWorkerMessage } from "./types";

export default class WorkerSocketAdapter implements IWebSocket {
  #worker: Worker;
  #connectionClosed: boolean = false;
  #closing: boolean = false;
  public binaryType: string = "";
  public protocol: string = "";
  public onerror: ((event: unknown) => void) | undefined = undefined;
  public onopen: ((event: unknown) => void) | undefined = undefined;
  public onclose: ((event: unknown) => void) | undefined = undefined;
  public onmessage: ((event: unknown) => void) | undefined = undefined;

  public constructor(wsUrl: string, protocols?: string[] | string) {
    // foxglove-depcheck-used: babel-plugin-transform-import-meta
    this.#worker = new Worker(new URL("./worker", import.meta.url));
    this.#sendToWorker({ type: "open", data: { wsUrl, protocols } });

    this.#worker.onerror = (ev) => {
      if (this.#connectionClosed) {
        return;
      }
      this.#connectionClosed = true;
      this.#closing = true;
      this.#worker.terminate();
      try {
        this.onerror?.(ev);
      } finally {
        this.onclose?.({ code: 1006 });
      }
    };

    this.#worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
      if (this.#connectionClosed) {
        return;
      }
      switch (event.data.type) {
        case "open":
          if (this.#closing) {
            return;
          }
          if (this.onopen) {
            this.protocol = event.data.protocol;
            this.onopen(event.data);
          }
          break;
        case "close":
          // websocket connection got closed, we can terminate the worker
          this.#connectionClosed = true;
          this.#closing = true;
          this.#worker.terminate();

          if (this.onclose) {
            this.onclose(event.data);
          }
          break;
        case "error":
          if (!this.#closing && this.onerror) {
            this.onerror(event.data);
          }
          break;
        case "messages": {
          if (this.#closing) {
            return;
          }
          let count = 0;
          try {
            for (const data of event.data.messages) {
              if (this.#isClosed()) {
                break;
              }
              this.onmessage?.({ data });
              count++;
            }
          } finally {
            // Confirm the synchronous consumer prefix, never a later render.
            // A short prefix explicitly fails this connection in the worker.
            if (!this.#isClosed()) {
              this.#sendToWorker({ type: "consumed", data: { id: event.data.id, count } });
            }
          }
          break;
        }
      }
    };
  }

  public close(): void {
    if (!this.#connectionClosed && !this.#closing) {
      this.#sendToWorker({
        type: "close",
        data: undefined,
      });
      this.#closing = true;
    }
  }

  /** Release a parked view immediately, including queued worker deliveries. */
  public terminate(): void {
    if (this.#connectionClosed) {
      return;
    }
    this.#connectionClosed = true;
    this.#closing = true;
    this.#worker.terminate();
  }

  public send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.#sendToWorker({ type: "data", data });
  }

  #sendToWorker(msg: ToWorkerMessage): void {
    if (this.#connectionClosed || this.#closing) {
      throw Error("Can't send message over closed websocket connection");
    }
    this.#worker.postMessage(msg);
  }

  #isClosed(): boolean {
    return this.#connectionClosed || this.#closing;
  }
}
