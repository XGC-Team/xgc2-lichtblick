// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { ViewStore } from "./view-state.cjs";

export interface ViewGateway {
  readonly streamCount: number;
  /** Answers with the current `{revision, view}`. */
  state(response: ServerResponse, headers?: OutgoingHttpHeaders): void;
  /** Opens an event stream: the current state, then every change; throws a PersistenceError (503) past the stream limit. */
  events(request: IncomingMessage, response: ServerResponse, headers?: OutgoingHttpHeaders): void;
  close(): void;
}
export function createViewGateway(viewStore: ViewStore, options?: { heartbeatMs?: number; maxStreams?: number }): ViewGateway;
