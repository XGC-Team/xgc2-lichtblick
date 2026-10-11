// SPDX-License-Identifier: MPL-2.0
import type { Diagnostics } from "@xgc2/xrpc";
import type { StartupInput } from "./startup-input.cjs";

export type ManagedAsset = { owner: "lichtblick"; asset_id: string; sha256: string; bytes: number };
export interface ManagedDomainClient {
  readonly ready: Promise<void>;
  /** The scope of the pages' documents (every family but the desired view). */
  readonly scope: { readonly namespace: "lichtblick"; readonly user: string; readonly workspace: string };
  /** The scope that holds only the desired view; undefined when none was granted. */
  readonly viewScope: { readonly namespace: "lichtblick"; readonly user: string; readonly workspace: string } | undefined;
  /** Document operations in the document scope; a request that names the view family is refused (403). */
  request(
    request: unknown,
    context?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /** The same operations in the view scope, for the view family only; 503 without a view scope. */
  requestView(
    request: unknown,
    context?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  publish(bytes: Uint8Array, info: { id: string; version: string }): Promise<ManagedAsset>;
  load(asset: ManagedAsset): Promise<Uint8Array>;
  beginDrain(): void;
  close(): Promise<void>;
}
export const MAX_WIRE_BYTES: number;
export const MAX_ASSET_BYTES: number;
/** Longest storage call, in milliseconds. */
export const CALL_TIMEOUT_MS: number;
/** Longest wait for admitted work when an owner drains, in milliseconds. */
export const SHUTDOWN_MS: number;
export class PersistenceError extends Error {
  constructor(code: string, message: string, status?: number);
  code: string;
  status: number;
  outcome?: string;
  requestId?: string;
}
export function createManagedDomainClient(options: {
  call: (route: string, body: unknown, context?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;
  close?: () => void | Promise<void>;
  scope: { namespace: "lichtblick"; user: string; workspace: string };
  viewScope?: { namespace: "lichtblick"; user: string; workspace: string };
  assetRoot: string;
  timeZone?: string;
  assetAccess?: "read-only" | "read-write";
}): ManagedDomainClient;
export function createManagedDomainClientFromInput(input: StartupInput, options?: { diagnostics?: Diagnostics }): ManagedDomainClient;
