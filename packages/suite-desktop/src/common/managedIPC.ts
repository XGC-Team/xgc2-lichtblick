// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ManagedRequestError } from "../../../suite-base/src/services/persistence/ManagedDocumentStore";

import type { ManagedIPCReply } from "./types";

/** Electron preserves plain return values, but drops custom Error properties. */
export function managedIPCFailure(error: unknown): ManagedIPCReply<never> {
  const fields = error as
    | {
        message?: unknown;
        code?: unknown;
        outcome?: unknown;
        requestId?: unknown;
        status?: unknown;
      }
    | undefined;
  return {
    ok: false,
    error: {
      message:
        typeof fields?.message === "string"
          ? fields.message
          : "Managed persistence failed",
      code: typeof fields?.code === "string" ? fields.code : "unavailable",
      outcome:
        typeof fields?.outcome === "string"
          ? fields.outcome
          : "outcome_unknown",
      ...(typeof fields?.requestId === "string"
        ? { requestId: fields.requestId }
        : {}),
      ...(typeof fields?.status === "number" ? { status: fields.status } : {}),
    },
  };
}

export function unwrapManagedIPC<T>(reply: ManagedIPCReply<T>): T {
  if (!reply.ok) {
    const { message, code, outcome, requestId, status } = reply.error;
    const error = new ManagedRequestError(message, code, outcome, requestId);
    if (status != undefined) {
      Object.assign(error, { status });
    }
    throw error;
  }
  return reply.value;
}
