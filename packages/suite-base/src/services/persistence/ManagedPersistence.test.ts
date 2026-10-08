// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { browserManagedTransport, readManagedResponse } from "./ManagedPersistence";

it("the request deadline cancels a stalled body after headers have arrived", async () => {
  jest.useFakeTimers();
  Object.defineProperty(globalThis, "document", {
    value: { baseURI: "https://example.com/view/" },
    configurable: true,
  });
  const cancelled = jest.fn();
  let signal: AbortSignal | undefined;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
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
    const pending = browserManagedTransport({ operation: "snapshot", families: ["layouts"] });
    let failure: unknown;
    const rejected = pending.catch((error: unknown) => {
      failure = error;
    });
    await jest.advanceTimersByTimeAsync(14999);
    expect(signal?.aborted).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as Error).message).toContain("deadline exceeded");
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledTimes(1);
  } finally {
    delete (globalThis as { document?: unknown }).document;
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
