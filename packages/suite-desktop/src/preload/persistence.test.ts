// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ManagedRequestError } from "@lichtblick/suite-base/src/services/persistence/ManagedDocumentStore";

import { createPersistenceBridge } from "./persistence";
import { unwrapManagedIPC } from "../common/managedIPC";

it("preserves code, status and uncertain request identity through a plain IPC reply", async () => {
  const invoke = jest.fn(async () =>
    JSON.parse(
      JSON.stringify({
        ok: false,
        error: {
          code: "deadline",
          message: "Reply lost",
          status: 504,
          outcome: "outcome_unknown",
          requestId: "write-7",
        },
      }),
    ),
  );
  const reply = await createPersistenceBridge(invoke).domainRequest({
    operation: "receipt",
    requestId: "write-7",
  });
  expect(() => unwrapManagedIPC(reply)).toThrow(ManagedRequestError);
  let failure: unknown;
  try {
    unwrapManagedIPC(reply);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "deadline",
    status: 504,
    outcome: "outcome_unknown",
    requestId: "write-7",
  });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects oversized documents before IPC copies the payload", async () => {
  const invoke = jest.fn();
  const reply = await createPersistenceBridge(invoke).domainRequest({
    operation: "snapshot",
    keys: [{ family: "layouts", key: "x".repeat(4 * 1024 * 1024) }],
  });
  expect(reply).toMatchObject({
    ok: false,
    error: { code: "invalid_request", outcome: "not_sent" },
  });
  expect(invoke).not.toHaveBeenCalled();
});

it("treats an IPC disconnect without disposition as uncertain", async () => {
  const invoke = jest.fn(async () => {
    throw new Error("Main process disconnected");
  });
  const reply = await createPersistenceBridge(invoke).domainRequest({
    operation: "receipt",
    requestId: "write-7",
  });
  expect(reply).toMatchObject({
    ok: false,
    error: { outcome: "outcome_unknown" },
  });
});

it("rejects oversized archives and filesystem-shaped asset references", async () => {
  const invoke = jest.fn();
  const bridge = createPersistenceBridge(invoke);
  expect(
    await bridge.publish(new Uint8Array(8 * 1024 * 1024 + 1), {
      id: "example.extension",
      version: "1.0.0",
    }),
  ).toMatchObject({ ok: false });
  expect(
    await bridge.load({
      owner: "lichtblick",
      asset_id: "../../private",
      sha256: "a".repeat(64),
      bytes: 1,
    }),
  ).toMatchObject({ ok: false });
  expect(invoke).not.toHaveBeenCalled();
});

it("exposes only product document operations and immutable archive calls", async () => {
  const invoke = jest.fn(async () => ({
    ok: true,
    value: new Uint8Array([1, 2]),
  }));
  const bridge = createPersistenceBridge(invoke);
  expect(Object.keys(bridge).sort()).toEqual([
    "domainRequest",
    "load",
    "publish",
  ]);
  const bytes = new Uint8Array([1, 2]);
  const info = { id: "example.extension", version: "1.0.0" };
  await bridge.publish(bytes, info);
  expect(invoke).toHaveBeenCalledWith("managed-extension-publish", bytes, info);
});
