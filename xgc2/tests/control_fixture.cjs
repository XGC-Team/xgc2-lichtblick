// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-License-Identifier: MPL-2.0
"use strict";

// Test-only: the control service and a minimal caller of its private socket.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { rawCall } = require("./raw_call.cjs");
const { createControlService } = require("../launcher/control-service.cjs");
const { ViewStore } = require("../launcher/view-state.cjs");

async function startControl(t, { ready = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lichtblick-control-"));
  const viewStore = new ViewStore();
  const socketPath = path.join(root, "control.sock");
  const control = createControlService({
    socketPath,
    viewStore,
    facts: () => ({ http_port: 18081 }),
  });
  t.after(async () => {
    await control.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await control.start();
  if (ready) {control.markReady();}
  return {
    root,
    viewStore,
    control,
    socketPath,
    call: (method, target, options = {}) =>
      rawCall(socketPath, method, target, {
        instance:
          method === "GET" && target.split("?", 1)[0] === "/v1/describe"
            ? undefined
            : control.instanceId,
        ...options,
      }),
  };
}

module.exports = { rawCall, startControl };
