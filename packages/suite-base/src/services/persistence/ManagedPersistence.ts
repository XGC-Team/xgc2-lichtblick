// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  ManagedDocumentStore,
  ManagedRequestError,
  ManagedTransport,
} from "./ManagedDocumentStore";
import type { UserProfile } from "../../context/UserProfileStorageContext";

export type ManagedAssetReference = {
  owner: "lichtblick";
  asset_id: string;
  sha256: string;
  bytes: number;
};
export type ManagedAssetTransport = {
  publish: (
    bytes: Uint8Array,
    info: { id: string; version: string },
  ) => Promise<ManagedAssetReference>;
  load: (asset: ManagedAssetReference) => Promise<Uint8Array>;
};
let documentStore: ManagedDocumentStore | undefined;
let assetTransport: ManagedAssetTransport | undefined;

export async function readManagedResponse(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Managed response has no body");
  }
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted === true) {
    cancel();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const assertActive = () => {
    if (signal?.aborted === true) {
      throw new DOMException("Managed response deadline exceeded", "AbortError");
    }
  };
  try {
    for (;;) {
      assertActive();
      const part = await reader.read();
      assertActive();
      if (part.done) {
        break;
      }
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Managed response size limit exceeded");
      }
      chunks.push(part.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function request(
  url: URL,
  options: RequestInit | undefined,
  limit: number,
): Promise<{ response: Response; bytes: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 15000);
  try {
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      signal: controller.signal,
    });
    const bytes = await readManagedResponse(response, limit, controller.signal);
    return { response, bytes };
  } finally {
    clearTimeout(timer);
  }
}
export const browserManagedTransport: ManagedTransport = async (value) => {
  const { response, bytes } = await request(
    new URL("xgc2/storage", document.baseURI),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    },
    4 * 1024 * 1024,
  );
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!response.ok) {
    const error = body as { message?: string; code?: string; outcome?: string; requestId?: string };
    throw new ManagedRequestError(
      error.message ?? `Managed storage HTTP ${response.status}`,
      error.code ?? "unavailable",
      error.outcome,
      error.requestId,
    );
  }
  return body;
};
export const browserManagedAssets: ManagedAssetTransport = {
  async publish(bytes, info) {
    if (bytes.length > 8 * 1024 * 1024) {
      throw new Error("Extension archive exceeds 8 MiB");
    }
    const url = new URL("xgc2/extensions/assets", document.baseURI);
    url.searchParams.set("name", info.id);
    url.searchParams.set("version", info.version);
    const { response, bytes: resultBytes } = await request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([new Uint8Array(bytes)]),
      },
      64 * 1024,
    );
    const result: unknown = JSON.parse(new TextDecoder().decode(resultBytes));
    if (!response.ok) {
      throw new Error(`Extension publication failed: HTTP ${response.status}`);
    }
    return result as ManagedAssetReference;
  },
  async load(asset) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.asset_id)) {
      throw new Error("Invalid extension asset identity");
    }
    const url = new URL(
      `xgc2/extensions/assets/${encodeURIComponent(asset.asset_id)}`,
      document.baseURI,
    );
    url.searchParams.set("bytes", String(asset.bytes));
    url.searchParams.set("sha256", asset.sha256);
    const { response, bytes } = await request(url, undefined, 8 * 1024 * 1024);
    if (!response.ok) {
      throw new Error(`Extension load failed: HTTP ${response.status}`);
    }
    return bytes;
  },
};
export async function initializeManagedPersistence(
  transport: ManagedTransport = browserManagedTransport,
  assets: ManagedAssetTransport = browserManagedAssets,
): Promise<ManagedDocumentStore> {
  const store = new ManagedDocumentStore(transport);
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
  assetTransport = assets;
  return store;
}
export function getManagedDocumentStore(): ManagedDocumentStore {
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
