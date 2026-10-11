// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { CORE_UI_DOCUMENTS_BASE_PATH, CORE_UI_DOCUMENT_BYTES } from "../CoreUiDocumentClient";

type Metadata = { kind: string; id: string; revision: number; updatedAt: string; size: number };
type Document = Metadata & { body: Record<string, unknown> };
type Asset = Metadata & { bytes: Uint8Array };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(status: number, code: string): Response {
  return json({ error: { code, message: `Core UI documents: ${code}` } }, status);
}

/** In-memory fetch server with Core's per-document CAS, pagination and quotas. */
export class CoreUiDocumentServer {
  public documents = new Map<string, Document>();
  public assets = new Map<string, Asset>();
  public requests: { url: URL; options?: RequestInit }[] = [];
  public pageLimit = 2;
  public maxDocuments = 1024;
  public maxBytes = 64 * 1024 * 1024;
  public unavailable = false;
  public rejectNextWrite: { status: number; code: string } | undefined;
  public loseNextWriteResponse = false;
  #revision = 0;

  public fetch: typeof fetch = async (input, options) => {
    if (typeof input !== "string") {
      throw new Error("The fake Core server expects a string path");
    }
    const url = new URL(input, "https://core.test");
    this.requests.push({ url, options });
    if (options?.credentials !== "same-origin") {
      return error(403, "forbidden");
    }
    if (this.unavailable) {
      return error(503, "unavailable");
    }
    const [kind, id] = url.pathname.slice(CORE_UI_DOCUMENTS_BASE_PATH.length + 1).split("/");
    const validName = (name: string) =>
      /^[a-z0-9][a-z0-9._-]*$/.test(name) &&
      name.length <= 128 &&
      !name.includes("..") &&
      !["assets", "constructor", "prototype"].includes(name) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/.test(name);
    if (
      !url.pathname.startsWith(`${CORE_UI_DOCUMENTS_BASE_PATH}/`) ||
      !kind ||
      (kind !== "assets" && !validName(kind)) ||
      (id != undefined && !validName(id))
    ) {
      return error(400, "invalid_input");
    }
    const method = options.method ?? "GET";
    if (id == undefined) {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const after = url.searchParams.get("after") ?? "";
      if (
        method !== "GET" ||
        kind === "assets" ||
        limit < 1 ||
        limit > 100 ||
        (after !== "" && !validName(after))
      ) {
        return error(400, "invalid_input");
      }
      const records = [...this.documents.values()]
        .filter((item) => item.kind === kind && item.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const items = records.slice(0, Math.min(limit, this.pageLimit));
      return json({
        items: items.map(({ body, ...metadata }) => ({
          ...metadata,
          ...(url.searchParams.get("include") === "body" ? { body } : {}),
        })),
        next: records.length > items.length ? items.at(-1)!.id : "",
      });
    }
    const identity = `${kind}/${id}`;
    const prior = kind === "assets" ? this.assets.get(id) : this.documents.get(identity);
    if (method === "GET") {
      if (!prior) {
        return error(404, "not_found");
      }
      return kind === "assets" ? new Response(new Uint8Array((prior as Asset).bytes)) : json(prior);
    }
    if (this.rejectNextWrite) {
      const rejection = this.rejectNextWrite;
      this.rejectNextWrite = undefined;
      return error(rejection.status, rejection.code);
    }
    const expected = url.searchParams.get("expectedRevision");
    if (expected != undefined && !/^(0|[1-9][0-9]*)$/.test(expected)) {
      return error(400, "invalid_input");
    }
    if (method === "DELETE" && !prior) {
      return new Response(undefined, { status: 204 });
    }
    if (expected != undefined && Number(expected) !== (prior?.revision ?? 0)) {
      return error(409, "conflict");
    }
    if (method === "DELETE") {
      if (kind === "assets") {
        this.assets.delete(id);
      } else {
        this.documents.delete(identity);
      }
      this.#revision++;
      return new Response(undefined, { status: 204 });
    }
    if (method !== "PUT") {
      return error(400, "invalid_input");
    }
    const media = new Headers(options.headers).get("Content-Type");
    if (media !== (kind === "assets" ? "application/octet-stream" : "application/json")) {
      return error(415, "unsupported_media_type");
    }
    const body = options.body;
    if (!(body instanceof Blob) && typeof body !== "string") {
      return error(400, "invalid_input");
    }
    const bytes =
      body instanceof Blob
        ? new Uint8Array(await body.arrayBuffer())
        : new TextEncoder().encode(body);
    if (bytes.length > (kind === "assets" ? 16 * 1024 * 1024 : CORE_UI_DOCUMENT_BYTES)) {
      return error(413, "too_large");
    }
    const usage = [...this.documents.values(), ...this.assets.values()].reduce(
      (sum, item) => sum + item.size,
      0,
    );
    if (
      usage + bytes.length - (prior?.size ?? 0) > this.maxBytes ||
      (!prior &&
        (kind === "assets" ? this.assets.size >= 64 : this.documents.size >= this.maxDocuments))
    ) {
      return error(429, "quota_exceeded");
    }
    let parsed: unknown;
    if (kind !== "assets") {
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return error(400, "invalid_input");
      }
      if (parsed == undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
        return error(400, "invalid_input");
      }
    }
    const metadata: Metadata = {
      kind,
      id,
      revision: ++this.#revision,
      updatedAt: new Date().toISOString(),
      size: bytes.length,
    };
    if (kind === "assets") {
      this.assets.set(id, { ...metadata, bytes });
    } else {
      this.documents.set(identity, { ...metadata, body: parsed as Record<string, unknown> });
    }
    if (this.loseNextWriteResponse) {
      this.loseNextWriteResponse = false;
      throw new TypeError("Connection lost after write");
    }
    return json(metadata);
  };
}
