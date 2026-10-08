// SPDX-License-Identifier: MPL-2.0
import type { GrantResolver, BootstrapBinding, Diagnostics, Policy, PolicyView } from "@xgc2/xrpc";

export type ManagedAsset = { owner: "lichtblick"; asset_id: string; sha256: string; bytes: number };
export interface ManagedDomainClient {
  readonly ready: Promise<void>;
  request(
    request: unknown,
    context?: { requestId?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  publish(bytes: Uint8Array, info: { id: string; version: string }): Promise<ManagedAsset>;
  load(asset: ManagedAsset): Promise<Uint8Array>;
  beginDrain(): void;
  close(): Promise<void>;
}
export function createManagedPolicy(environment?: NodeJS.ProcessEnv, diagnostics?: Diagnostics): Policy;
export function createManagedDomainClientFromBootstrap(
  input: { binding: BootstrapBinding; resolveGrant: GrantResolver; application: unknown },
  policy: PolicyView,
): ManagedDomainClient;
