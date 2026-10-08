// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { parseDesktopArguments } from "./parseDesktopArguments";

it("removes the granted bootstrap file from arguments used to open user files", () => {
  const argumentsWithGrant = [
    "electron",
    ".webpack",
    "--bootstrap-input",
    "/private/desktop-input.json",
    "/data/run.mcap",
    "--source=/data/second.mcap",
    "lichtblick://view",
  ];
  expect(parseDesktopArguments(argumentsWithGrant)).toEqual({
    bootstrapInput: "/private/desktop-input.json",
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

it("allows a second instance to forward public arguments without a bootstrap input", () => {
  expect(parseDesktopArguments(["electron", "/data/run.mcap"])).toEqual({
    bootstrapInput: undefined,
    argv: ["electron", "/data/run.mcap"],
  });
});

it.each([
  ["--bootstrap-input"],
  ["--bootstrap-input", ""],
  ["--bootstrap-input", "--source=/data/run.mcap"],
  ["--bootstrap-input=/private/desktop-input.json"],
  ["--bootstrap-input", "/private/a.json", "--bootstrap-input", "/private/b.json"],
])("rejects ambiguous bootstrap arguments without exposing their values: %j", (...argv) => {
  expect(() => parseDesktopArguments(argv)).toThrow(/bootstrap-input/);
  expect(() => parseDesktopArguments(argv)).not.toThrow(/\/private\//);
});
