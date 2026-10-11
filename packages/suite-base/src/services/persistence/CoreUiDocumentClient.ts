// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/**
 * Core's browser session API has an absolute, same-origin base path. Keys use one
 * reversible encoding: prefix "k-", then UTF-8 bytes, copying lowercase ASCII,
 * digits, hyphens and single dots; every other byte is "_" plus two lowercase hex
 * digits. A dot after a literal dot is escaped too. Underscores are always escaped.
 * This is injective, avoids Core's reserved names and "..", and rejects malformed
 * Unicode or results longer than Core's 128-character bound rather than truncating
 * or hashing keys. Documents retain {key, value}, so lists need no decoding.
 */

import { ManagedRequestError } from "./ManagedDocumentStore.types";

export const CORE_UI_DOCUMENTS_BASE_PATH = "/api/ui-documents/lichtblick";
export const CORE_UI_DOCUMENT_BYTES = 1024 * 1024;
export type CoreUiMetadata = {
  kind: string;
  id: string;
  revision: string;
  updatedAt: string;
  size: number;
};
export type CoreUiDocument = CoreUiMetadata & { body: { key: string; value: unknown } };

export function encodeCoreUiKey(key: string): string {
  const bytes = new TextEncoder().encode(key);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== key) {
    throw new Error("Invalid UI document key Unicode");
  }
  let encoded = "k-";
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    encoded +=
      /[a-z0-9-]/.test(character) || (character === "." && !encoded.endsWith("."))
        ? character
        : `_${byte.toString(16).padStart(2, "0")}`;
  }
  if (encoded.length > 128) {
    throw new Error("Encoded UI document key exceeds 128 characters");
  }
  return encoded;
}

export function decodeCoreUiKey(encoded: string): string {
  if (!/^k-[a-z0-9._-]*$/.test(encoded) || encoded.length > 128) {
    throw new Error("Invalid encoded UI document key");
  }
  const bytes: number[] = [];
  for (let index = 2; index < encoded.length; index++) {
    if (encoded[index] === "_") {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[a-f0-9]{2}$/.test(hex)) {
        throw new Error("Invalid encoded UI document key escape");
      }
      bytes.push(parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index));
    }
  }
  const key = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  if (encodeCoreUiKey(key) !== encoded) {
    throw new Error("Noncanonical encoded UI document key");
  }
  return key;
}

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

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined && !Array.isArray(value);
}

function parseResponse(bytes: Uint8Array): unknown {
  // Preserve the integer spelling for CAS, without changing numbers in document
  // values. Engines without JSON source context can safely use ordinary revisions;
  // unsafe numbers are refused instead of sending a rounded expectedRevision.
  const revisions = new WeakMap<object, string>();
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    function (this: object, key: string, value: unknown, context?: { source: string }): unknown {
      if (key === "revision" && typeof value === "number") {
        revisions.set(this, context?.source ?? (Number.isSafeInteger(value) ? String(value) : ""));
      }
      return value;
    },
  );
  const metadata = object(parsed) && Array.isArray(parsed.items) ? parsed.items : [parsed];
  for (const item of metadata) {
    if (object(item) && revisions.has(item)) {
      item.revision = revisions.get(item);
    }
  }
  return parsed;
}

function metadata(value: unknown, kind: string, id?: string): CoreUiMetadata {
  if (
    !object(value) ||
    value.kind !== kind ||
    typeof value.id !== "string" ||
    (id != undefined && value.id !== id) ||
    typeof value.revision !== "string" ||
    !/^[1-9][0-9]*$/.test(value.revision) ||
    BigInt(value.revision) > 9223372036854775807n ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0
  ) {
    throw new Error("Invalid Core UI document metadata");
  }
  return value as CoreUiMetadata;
}

function document(value: unknown, kind: string, id?: string): CoreUiDocument {
  const result = metadata(value, kind, id);
  const body = (value as { body?: unknown }).body;
  if (!object(body) || typeof body.key !== "string" || body.key === "" || !("value" in body)) {
    throw new Error("Invalid Core UI document body");
  }
  if (encodeCoreUiKey(body.key) !== result.id || result.size > CORE_UI_DOCUMENT_BYTES) {
    throw new Error("Core UI document identity or size mismatch");
  }
  return value as CoreUiDocument;
}

export class CoreUiDocumentClient {
  public constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async #request(
    path: string,
    options?: RequestInit,
    limit = 4 * 1024 * 1024,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 15000);
    try {
      const response = await this.fetcher(`${CORE_UI_DOCUMENTS_BASE_PATH}${path}`, {
        ...options,
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (response.status === 204) {
        return new Uint8Array();
      }
      const bytes = await readManagedResponse(
        response,
        response.ok ? limit : 64 * 1024,
        controller.signal,
      );
      if (!response.ok) {
        const body = parseResponse(bytes);
        const error = object(body) && object(body.error) ? body.error : undefined;
        throw new ManagedRequestError(
          typeof error?.message === "string"
            ? error.message
            : `Core UI documents HTTP ${response.status}`,
          typeof error?.code === "string" ? error.code : "unavailable",
        );
      }
      return bytes;
    } catch (error) {
      if (error instanceof ManagedRequestError) {
        throw error;
      }
      throw new ManagedRequestError(
        error instanceof Error || error instanceof DOMException ? error.message : String(error),
        "unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  public async list(kind: string, after = ""): Promise<{ items: CoreUiDocument[]; next: string }> {
    const query = new URLSearchParams({ include: "body", limit: "100", after });
    const result = parseResponse(await this.#request(`/${kind}?${query}`));
    if (
      !object(result) ||
      !Array.isArray(result.items) ||
      result.items.length > 100 ||
      typeof result.next !== "string"
    ) {
      throw new Error("Invalid Core UI document page");
    }
    return { items: result.items.map((item: unknown) => document(item, kind)), next: result.next };
  }

  public async get(kind: string, key: string): Promise<CoreUiDocument | undefined> {
    const id = encodeCoreUiKey(key);
    try {
      return document(parseResponse(await this.#request(`/${kind}/${id}`)), kind, id);
    } catch (error) {
      if (error instanceof ManagedRequestError && error.code === "not_found") {
        return undefined;
      }
      throw error;
    }
  }

  public async put(
    kind: string,
    key: string,
    value: unknown,
    expectedRevision: string,
  ): Promise<CoreUiMetadata> {
    const id = encodeCoreUiKey(key);
    const result = await this.#request(`/${kind}/${id}?expectedRevision=${expectedRevision}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    return metadata(parseResponse(result), kind, id);
  }

  public async delete(kind: string, key: string, expectedRevision: string): Promise<void> {
    await this.#request(`/${kind}/${encodeCoreUiKey(key)}?expectedRevision=${expectedRevision}`, {
      method: "DELETE",
    });
  }

  public async publishAsset(name: string, bytes: Uint8Array): Promise<CoreUiMetadata> {
    const result = await this.#request(`/assets/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Blob([new Uint8Array(bytes)]),
    });
    return metadata(parseResponse(result), "assets", name);
  }

  public async loadAsset(name: string): Promise<Uint8Array> {
    return await this.#request(`/assets/${name}`, undefined, 8 * 1024 * 1024);
  }
}
