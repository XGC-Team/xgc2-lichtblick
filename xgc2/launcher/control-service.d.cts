// SPDX-License-Identifier: MPL-2.0
import type { Diagnostics } from "@xgc2/xrpc";
import type { ManagedDomainClient } from "./managed-storage.cjs";
import type { ViewStore } from "./view-state.cjs";

export const SERVICE: "xgc2.lichtblick.v1";
export const API_VERSION: "1";
export interface ControlService {
  readonly instanceId: string;
  readonly ready: boolean;
  /** Binds the private Unix socket and starts asking the dependency; rejects with EADDRINUSE if a live owner holds the socket. */
  start(): Promise<void>;
  markReady(): void;
  markNotReady(reason: string): void;
  describe(): { service: typeof SERVICE; api_version: typeof API_VERSION; instance_id: string; ready: boolean; facts: Record<string, unknown> };
  close(): Promise<void>;
}
export interface ControlDependency {
  /** Rejects when the storage the launcher is bound to cannot be used. */
  check(): Promise<void>;
  /** Default 5000. */
  intervalMs?: number;
  /** Called when the dependency becomes unusable or usable again. */
  onChange?(state: { ready: boolean; reason: string }): void;
}
export function createControlService(
  client: ManagedDomainClient,
  options: { socketPath: string; viewStore: ViewStore; diagnostics?: Diagnostics; shutdownMs?: number; facts?: () => Record<string, unknown>; dependency?: ControlDependency },
): ControlService;
