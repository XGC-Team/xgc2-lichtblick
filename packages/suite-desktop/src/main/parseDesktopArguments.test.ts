// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { parseDesktopArguments } from "./parseDesktopArguments";

it("removes the granted startup input file from arguments used to open user files", () => {
  const argumentsWithGrant = [
    "electron",
    ".webpack",
    "--startup-input",
    "/private/desktop-input.json",
    "/data/run.mcap",
    "--source=/data/second.mcap",
    "lichtblick://view",
  ];
  expect(parseDesktopArguments(argumentsWithGrant)).toEqual({
    startupInput: "/private/desktop-input.json",
    argv: [
      "electron",
      ".webpack",
      "/data/run.mcap",
      "--source=/data/second.mcap",
      "lichtblick://view",
    ],
  });
  expect(argumentsWithGrant).toContain("/private/desktop-input.json");
});

it("allows a second instance to forward public arguments without a startup input", () => {
  expect(parseDesktopArguments(["electron", "/data/run.mcap"])).toEqual({
    startupInput: undefined,
    argv: ["electron", "/data/run.mcap"],
  });
});

it.each([
  ["--startup-input"],
  ["--startup-input", ""],
  ["--startup-input", "--source=/data/run.mcap"],
  ["--startup-input=/private/desktop-input.json"],
  ["--startup-input", "/private/a.json", "--startup-input", "/private/b.json"],
])("rejects ambiguous startup arguments without exposing their values: %j", (...argv) => {
  expect(() => parseDesktopArguments(argv)).toThrow(/startup-input/);
  expect(() => parseDesktopArguments(argv)).not.toThrow(/\/private\//);
});
