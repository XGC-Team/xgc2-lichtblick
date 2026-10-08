// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import JSZip from "jszip";

import { ManagedDocumentStore } from "./ManagedDocumentStore";
import {
  getManagedAssetTransport,
  getManagedDocumentStore,
  ManagedAssetReference,
  ManagedAssetTransport,
} from "./ManagedPersistence";
import { Namespace } from "../../types";
import { ExtensionInfo } from "../../types/Extensions";
import {
  IExtensionLoader,
  InstallExtensionProps,
  LoadedExtension,
} from "../extension/IExtensionLoader";
import validatePackageInfo from "../extension/utils/validatePackageInfo";

export type ManagedExtension = { info: ExtensionInfo; asset: ManagedAssetReference };
const ARCHIVE_LIMIT = 8 * 1024 * 1024;
const EXPANDED_LIMIT = 64 * 1024 * 1024;
const METADATA_LIMIT = 256 * 1024;
type ZipStream = {
  on(event: "data", callback: (chunk: Uint8Array) => void): ZipStream;
  on(event: "error", callback: (error: Error) => void): ZipStream;
  on(event: "end", callback: () => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};
function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith("/") &&
    !name.includes("\\") &&
    !name.includes("\0") &&
    !name.split("/").includes("..")
  );
}
function checkDirectory(bytes: Uint8Array): void {
  if (bytes.length > ARCHIVE_LIMIT || bytes.length < 22) {
    throw new Error("Invalid or oversized extension archive");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && data.getUint32(end, true) !== 0x06054b50) {
    end--;
  }
  if (end < 0 || data.getUint32(end, true) !== 0x06054b50) {
    throw new Error("Missing ZIP directory");
  }
  const count = data.getUint16(end + 10, true);
  const directorySize = data.getUint32(end + 12, true);
  let offset = data.getUint32(end + 16, true);
  if (
    data.getUint16(end + 4, true) !== 0 ||
    data.getUint16(end + 6, true) !== 0 ||
    data.getUint16(end + 8, true) !== count ||
    count > 256 ||
    offset === 0xffffffff ||
    directorySize === 0xffffffff ||
    offset + directorySize > end
  ) {
    throw new Error("Unsupported or oversized ZIP directory");
  }
  let expanded = 0;
  for (let entry = 0; entry < count; entry++) {
    if (offset + 46 > end || data.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP entry");
    }
    const flags = data.getUint16(offset + 8, true);
    const method = data.getUint16(offset + 10, true);
    const size = data.getUint32(offset + 24, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      size === 0xffffffff ||
      !safeName(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)))
    ) {
      throw new Error("Unsupported ZIP entry");
    }
    expanded += size;
    if (expanded > EXPANDED_LIMIT) {
      throw new Error("Extension expanded size exceeds 64 MiB");
    }
    offset = next;
  }
}
/** Streaming inflation stops before a dishonest directory can allocate an unbounded result. */
export async function unpackManagedExtension(bytes: Uint8Array): Promise<Record<string, string>> {
  checkDirectory(bytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
  const entries = Object.values(zip.files);
  if (entries.length > 256) {
    throw new Error("Extension ZIP entry limit exceeded");
  }
  const budget = { expanded: 0 };
  const files: Record<string, string> = {};
  for (const file of entries) {
    if (!safeName(file.name)) {
      throw new Error("Invalid extension entry name");
    }
    if (file.dir) {
      continue;
    }
    const keep = ["package.json", "README.md", "CHANGELOG.md", "dist/extension.js"].includes(
      file.name,
    );
    const chunks: Uint8Array[] = [];
    let length = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (
        file as unknown as { internalStream(type: "uint8array"): ZipStream }
      ).internalStream("uint8array");
      stream.on("data", (chunk: Uint8Array) => {
        budget.expanded += chunk.length;
        length += chunk.length;
        const limit = file.name === "dist/extension.js" ? EXPANDED_LIMIT : METADATA_LIMIT;
        if (budget.expanded > EXPANDED_LIMIT || (keep && length > limit)) {
          stream.pause();
          reject(new Error("Extension expanded size limit exceeded"));
          return;
        }
        if (keep) {
          chunks.push(chunk);
        }
      });
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.resume();
    });
    if (keep) {
      const content = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      files[file.name] = new TextDecoder("utf-8", { fatal: true }).decode(content);
    }
  }
  if (!files["package.json"] || !files["dist/extension.js"]) {
    throw new Error("Extension requires package.json and dist/extension.js");
  }
  return files;
}
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
    asset.bytes > ARCHIVE_LIMIT ||
    bytes.length !== asset.bytes
  ) {
    throw new Error("Invalid extension asset reference");
  }
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== asset.sha256) {
    throw new Error("Extension asset integrity check failed");
  }
}
export class ManagedExtensionLoader implements IExtensionLoader {
  public readonly type = "browser" as const;
  public constructor(
    public readonly namespace: Namespace,
    private store: ManagedDocumentStore = getManagedDocumentStore(),
    private assets: ManagedAssetTransport = getManagedAssetTransport(),
  ) {}
  #key(id: string): string {
    return JSON.stringify([this.namespace, id])!;
  }
  public async getExtension(id: string): Promise<ExtensionInfo | undefined> {
    return this.store.get<ManagedExtension>("extensions", this.#key(id))?.info;
  }
  public async getExtensions(): Promise<ExtensionInfo[]> {
    return this.store
      .records<ManagedExtension>("extensions")
      .map(({ value }) => value)
      .filter(({ info }) => info.namespace === this.namespace)
      .map(({ info }) => info);
  }
  public async loadExtension(id: string): Promise<LoadedExtension> {
    const record = this.store.get<ManagedExtension>("extensions", this.#key(id));
    if (!record) {
      throw new Error("Extension not found");
    }
    const bytes = await this.assets.load(record.asset);
    await verifyManagedAsset(bytes, record.asset);
    const files = await unpackManagedExtension(bytes);
    return { raw: files["dist/extension.js"]! };
  }
  public async installExtension({
    foxeFileData,
    externalId,
  }: InstallExtensionProps): Promise<ExtensionInfo> {
    const files = await unpackManagedExtension(foxeFileData);
    const parsed = JSON.parse(files["package.json"]!) as Partial<ExtensionInfo>;
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(parsed.version) ||
      (parsed.publisher != undefined && typeof parsed.publisher !== "string")
    ) {
      throw new Error("Invalid extension package identity");
    }
    const info = validatePackageInfo(parsed);
    const publisher = info.publisher.replace(/[^A-Za-z0-9_\s]+/g, "");
    const id = `${publisher}.${info.name}`;
    if (!publisher || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      throw new Error("Invalid extension identity");
    }
    const installed: ExtensionInfo = {
      ...info,
      id,
      namespace: this.namespace,
      qualifiedName: info.displayName || info.name,
      readme: files["README.md"] ?? "",
      changelog: files["CHANGELOG.md"] ?? "",
      externalId,
      size: foxeFileData.length,
    };
    if (new TextEncoder().encode(JSON.stringify(installed)).length > METADATA_LIMIT - 512) {
      throw new Error("Extension metadata size limit exceeded");
    }
    if (`${id}-${parsed.version}`.length > 96) {
      throw new Error("Extension asset identity exceeds 96 characters");
    }
    const asset = await this.assets.publish(foxeFileData, { id, version: parsed.version });
    await verifyManagedAsset(foxeFileData, asset);
    await this.store.commit([
      { family: "extensions", key: this.#key(id), value: { info: installed, asset } },
    ]);
    return installed;
  }
  public async uninstallExtension(id: string): Promise<void> {
    await this.store.commit([{ family: "extensions", key: this.#key(id), delete: true }]);
  }
}
