// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { app } from "electron";

import { main } from "../../packages/suite-desktop/src/main";
import { parseDesktopArguments } from "../../packages/suite-desktop/src/main/parseDesktopArguments";

void (async () => {
  const parsed = parseDesktopArguments(process.argv);
  if (parsed.startupInput == undefined) {
    throw new Error("Desktop startup requires --startup-input <granted file>");
  }
  await main({ startupInput: parsed.startupInput, argv: parsed.argv });
})().catch((error: unknown) => {
  console.error(
    "Desktop initialization failed",
    error instanceof Error ? error.message : "Managed persistence unavailable",
  );
  // Startup must fail explicitly; never create a window backed by another store.
  process.exitCode = 1;
  app.quit();
});
