// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import {
  CoreUiDocumentClient,
  decodeCoreUiKey,
  encodeCoreUiKey,
  readManagedResponse,
} from "./CoreUiDocumentClient";
import { CoreUiDocumentServer } from "./test/CoreUiDocumentServer";

it.each([
  "",
  "user",
  "timezone",
  '["local","Layout-A_1"]',
  '["local","Tests.extension"]',
  '["Tests.extension","1.2.3+build"]',
  "../a/b",
  "a_b",
  "a..b",
  "con.txt",
  "constructor",
  "é/🙂",
  "\0",
])("round-trips a key without collisions: %j", (key) => {
  const encoded = encodeCoreUiKey(key);
  expect(encoded).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
  expect(encoded).not.toContain("..");
  expect(decodeCoreUiKey(encoded)).toBe(key);
});

it("distinguishes escapes, case, punctuation and normalized Unicode", () => {
  const keys = ["A", "a", "_41", ".", "_2e", "é", "e\u0301"];
  expect(new Set(keys.map(encodeCoreUiKey)).size).toBe(keys.length);
  expect(() => encodeCoreUiKey("\ud800")).toThrow("Unicode");
  expect(encodeCoreUiKey("a".repeat(126))).toHaveLength(128);
  expect(() => encodeCoreUiKey("a".repeat(127))).toThrow("128");
  for (const invalid of ["../one", "k-_", "k-_gg", "k-_61", "k-..", "k-_ff"]) {
    expect(() => decodeCoreUiKey(invalid)).toThrow();
  }
});

it("uses absolute session-authorized requests for create, read, update and idempotent delete", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  const first = await client.put("configuration", "language", "en", "0");
  expect(first.revision).toBe("1");
  expect(await client.get("configuration", "language")).toMatchObject({
    body: { key: "language", value: "en" },
    revision: "1",
  });
  await expect(client.put("configuration", "language", "de", "0")).rejects.toMatchObject({
    code: "conflict",
  });
  await client.put("configuration", "language", "de", first.revision);
  await expect(client.delete("configuration", "language", first.revision)).rejects.toMatchObject({
    code: "conflict",
  });
  await client.delete("configuration", "language", "2");
  await client.delete("configuration", "language", "2");
  expect(await client.get("configuration", "language")).toBeUndefined();
  expect(
    server.requests.every(
      ({ url, options }) =>
        url.pathname.startsWith("/api/ui-documents/lichtblick/") &&
        options?.credentials === "same-origin",
    ),
  ).toBe(true);
  expect(server.requests[0]?.options).toMatchObject({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: '{"key":"language","value":"en"}',
  });
});

it("preserves Core's full integer revision without changing numbers in document values", async () => {
  const client = new CoreUiDocumentClient(
    async () =>
      new Response(
        '{"id":"k-user","kind":"profile","revision":9007199254740993,"updatedAt":"2026-10-11T00:00:00Z","size":45,"body":{"key":"user","value":{"revision":7}}}',
      ),
  );
  expect(await client.get("profile", "user")).toMatchObject({
    revision: "9007199254740993",
    body: { value: { revision: 7 } },
  });
});

it.each([
  [400, "invalid_input"],
  [403, "forbidden"],
  [413, "too_large"],
  [415, "unsupported_media_type"],
  [429, "quota_exceeded"],
  [503, "unavailable"],
])("preserves Core's error envelope for HTTP %i", async (status, code) => {
  const server = new CoreUiDocumentServer();
  server.rejectNextWrite = { status, code };
  await expect(
    new CoreUiDocumentClient(server.fetch).put("profile", "user", {}, "0"),
  ).rejects.toMatchObject({ code, message: `Core UI documents: ${code}` });
});

it("enforces Core's document size and app quotas", async () => {
  const server = new CoreUiDocumentServer();
  const client = new CoreUiDocumentClient(server.fetch);
  await expect(
    client.put("layouts", "large", { data: "a".repeat(1024 * 1024) }, "0"),
  ).rejects.toMatchObject({ code: "too_large" });
  server.maxDocuments = 1;
  await client.put("profile", "user", {}, "0");
  await expect(client.put("workspace", "ui", {}, "0")).rejects.toMatchObject({
    code: "quota_exceeded",
  });
  server.maxBytes = 1;
  await expect(client.put("profile", "user", { data: "large" }, "1")).rejects.toMatchObject({
    code: "quota_exceeded",
  });
});

it("the request deadline cancels a stalled body after headers have arrived", async () => {
  jest.useFakeTimers();
  const cancelled = jest.fn();
  let signal: AbortSignal | undefined;
  const client = new CoreUiDocumentClient(async (_input, options) => {
    signal = options?.signal ?? undefined;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel: cancelled,
      }),
    );
  });
  try {
    const failure = client.list("layouts").catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(failure).resolves.toMatchObject({
      code: "unavailable",
      message: "Managed response deadline exceeded",
    });
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

it("streamed response bounds cancel the body before collecting excess bytes", async () => {
  const cancelled = jest.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(9));
      },
      cancel: cancelled,
    }),
  );
  await expect(readManagedResponse(response, 8)).rejects.toThrow("size limit");
  expect(cancelled).toHaveBeenCalledTimes(1);
});
