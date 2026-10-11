// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CoreUiDocumentClient, decodeCoreUiKey, encodeCoreUiKey } from "./CoreUiDocumentClient";
import { managedAssetSha256, verifyManagedAsset } from "./ManagedAsset";
import type { ManagedAssetReference, ManagedAssetTransport } from "./ManagedAsset";

/** Asset names encode the JSON tuple [extension id, version] using the document key encoding. */
export class CoreUiDocumentAssets implements ManagedAssetTransport {
  public constructor(private client = new CoreUiDocumentClient()) {}

  public async publish(
    bytes: Uint8Array,
    info: { id: string; version: string },
  ): Promise<ManagedAssetReference> {
    if (bytes.length < 1 || bytes.length > 8 * 1024 * 1024) {
      throw new Error("Extension archive must contain 1 byte to 8 MiB");
    }
    const asset_id = encodeCoreUiKey(JSON.stringify([info.id, info.version])!);
    const content = new Uint8Array(bytes);
    const sha256 = await managedAssetSha256(content);
    const result = await this.client.publishAsset(asset_id, content);
    if (result.size !== content.length) {
      throw new Error("Extension publication size mismatch");
    }
    return { owner: "lichtblick", asset_id, sha256, bytes: content.length };
  }

  public async load(asset: ManagedAssetReference): Promise<Uint8Array> {
    decodeCoreUiKey(asset.asset_id);
    const bytes = await this.client.loadAsset(asset.asset_id);
    await verifyManagedAsset(bytes, asset);
    return bytes;
  }
}
