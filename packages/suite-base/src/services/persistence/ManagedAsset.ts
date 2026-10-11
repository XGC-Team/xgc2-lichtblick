// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

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

export async function managedAssetSha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Shared by the browser's Core transport and the desktop extension loader. */
export async function verifyManagedAsset(
  bytes: Uint8Array,
  asset: ManagedAssetReference,
): Promise<void> {
  if (
    (asset as { owner: string }).owner !== "lichtblick" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(asset.asset_id) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > 8 * 1024 * 1024 ||
    bytes.length !== asset.bytes
  ) {
    throw new Error("Invalid extension asset reference");
  }
  if ((await managedAssetSha256(bytes)) !== asset.sha256) {
    throw new Error("Extension asset integrity check failed");
  }
}
