// SPDX-License-Identifier: MPL-2.0
import type { Diagnostics } from "@xgc2/xrpc";
import type { ViewStore } from "./view-state.cjs";

export const SERVICE: "xgc2.lichtblick.v1";
export const API_VERSION: "1";
export const MAX_BODY_BYTES: number;
export const SHUTDOWN_MS: number;
export interface ControlService {
  readonly instanceId: string;
  readonly ready: boolean;
  /** Binds the private Unix socket; rejects with EADDRINUSE if a live owner holds the socket. */
  start(): Promise<void>;
  markReady(): void;
  markNotReady(reason: string): void;
  describe(): { service: typeof SERVICE; api_version: typeof API_VERSION; instance_id: string; ready: boolean; facts: Record<string, unknown> };
  close(): Promise<void>;
}
export function createControlService(
  options: { socketPath: string; viewStore: ViewStore; diagnostics?: Diagnostics; shutdownMs?: number; facts?: () => Record<string, unknown> },
): ControlService;
