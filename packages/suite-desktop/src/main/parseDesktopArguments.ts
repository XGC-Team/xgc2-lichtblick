// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export function parseDesktopArguments(argv: readonly string[]): {
  startupInput: string | undefined;
  argv: string[];
} {
  const publicArguments: string[] = [];
  let startupInput: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith("--startup-input=")) {
      throw new Error("Use --startup-input followed by its granted file path");
    }
    if (argument !== "--startup-input") {
      publicArguments.push(argument);
      continue;
    }
    if (startupInput != undefined) {
      throw new Error("Only one --startup-input is allowed");
    }
    const value = argv[++index];
    if (value == undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error("--startup-input requires a granted file path");
    }
    startupInput = value;
  }
  return { startupInput, argv: publicArguments };
}
