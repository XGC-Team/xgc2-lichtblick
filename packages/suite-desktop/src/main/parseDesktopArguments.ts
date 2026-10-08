// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

export function parseDesktopArguments(argv: readonly string[]): {
  bootstrapInput: string | undefined;
  argv: string[];
} {
  const publicArguments: string[] = [];
  let bootstrapInput: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument.startsWith("--bootstrap-input=")) {
      throw new Error("Use --bootstrap-input followed by its granted file path");
    }
    if (argument !== "--bootstrap-input") {
      publicArguments.push(argument);
      continue;
    }
    if (bootstrapInput != undefined) {
      throw new Error("Only one --bootstrap-input is allowed");
    }
    const value = argv[++index];
    if (value == undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error("--bootstrap-input requires a granted file path");
    }
    bootstrapInput = value;
  }
  return { bootstrapInput, argv: publicArguments };
}
