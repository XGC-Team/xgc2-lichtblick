// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: one HTTP call to a private Unix socket. It depends on Node only, so the installed-package
// smoke can use it without the source tree's modules.
const { randomUUID } = require("node:crypto");
const http = require("node:http");

/** One HTTP call to a Unix socket; `instance` adds the fence header, `timeoutMs` the call budget. */
function rawCall(
  socketPath,
  method,
  target,
  { instance, body, headers = {}, timeoutMs = 3000 } = {},
) {
  return new Promise((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : typeof body === "string" || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body);
    const request = http.request(
      {
        socketPath,
        method,
        path: target,
        headers: {
          "X-Request-ID": randomUUID(),
          "X-Xrpc-Timeout-Ms": String(timeoutMs),
          ...(instance ? { "X-Xrpc-Instance-ID": instance } : {}),
          ...(payload === undefined
            ? {}
            : {
                "Content-Type":
                  typeof body === "object" && !Buffer.isBuffer(body)
                    ? "application/json"
                    : "application/octet-stream",
                "Content-Length": Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks);
          let json;
          if (response.headers["content-type"]?.startsWith("application/json"))
            {json = JSON.parse(raw.toString("utf8"));}
          resolve({ status: response.statusCode, headers: response.headers, raw, json });
        });
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

module.exports = { rawCall };
