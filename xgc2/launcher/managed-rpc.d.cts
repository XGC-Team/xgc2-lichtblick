import type { ManagedDomainClient } from "./managed-storage.cjs";
import type { BootstrapBinding, GrantResolver, ServiceRef, PolicyView } from "@xgc2/xrpc";
export interface ManagedDomainRPC {
  start(): Promise<ServiceRef>;
  close(): Promise<void>;
  readonly reference: ServiceRef | undefined;
}
export function createManagedDomainRPC(
  client: ManagedDomainClient,
  options: { binding: BootstrapBinding; resolveGrant: GrantResolver; policy: PolicyView },
): ManagedDomainRPC;
