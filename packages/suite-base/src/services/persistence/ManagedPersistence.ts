// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CoreUiDocumentAssets } from "./CoreUiDocumentAssets";
import { CoreUiDocumentStore } from "./CoreUiDocumentStore";
import type { ManagedAssetTransport } from "./ManagedAsset";
import type { ManagedDocumentStore, ManagedTransport } from "./ManagedDocumentStore";
import type { ManagedDocumentStorage } from "./ManagedDocumentStore.types";
import type { UserProfile } from "../../context/UserProfileStorageContext";

export type { ManagedAssetReference, ManagedAssetTransport } from "./ManagedAsset";

let documentStore: ManagedDocumentStorage | undefined;
let assetTransport: ManagedAssetTransport | undefined;

export function initializeManagedPersistence(): Promise<CoreUiDocumentStore>;
/** Desktop keeps its existing IPC transport, document protocol and asset grants. */
export function initializeManagedPersistence(
  transport: ManagedTransport,
  assets: ManagedAssetTransport,
): Promise<ManagedDocumentStore>;
export async function initializeManagedPersistence(
  transport?: ManagedTransport,
  assets?: ManagedAssetTransport,
): Promise<CoreUiDocumentStore | ManagedDocumentStore> {
  // Only the desktop's explicit transport loads the snapshot/receipt store.
  const store = transport
    ? new (await import("./ManagedDocumentStore")).ManagedDocumentStore(transport)
    : new CoreUiDocumentStore();
  await store.bootstrap();
  const profile = store.get<UserProfile>("profile", "user") ?? {};
  if (!profile.firstSeenTime) {
    await store.commit([
      {
        family: "profile",
        key: "user",
        value: {
          ...profile,
          firstSeenTime: new Date().toISOString(),
          firstSeenTimeIsFirstLoad: profile.currentLayoutId == undefined,
        },
      },
    ]);
  }
  documentStore = store;
  assetTransport = assets ?? new CoreUiDocumentAssets();
  return store;
}

export function getManagedDocumentStore(): ManagedDocumentStorage {
  if (!documentStore) {
    throw new Error("Managed persistence must load before the application starts");
  }
  return documentStore;
}

export function getManagedAssetTransport(): ManagedAssetTransport {
  if (!assetTransport) {
    throw new Error("Managed extension transport is not initialized");
  }
  return assetTransport;
}

export function reloadManagedApplication(): void {
  window.location.reload();
}
