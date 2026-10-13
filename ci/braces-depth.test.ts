// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { createRequire } from "module";

import { describe, expect, it } from "@jest/globals";

const require = createRequire(__filename);
const braces = require("braces") as (input: string, options?: { expand?: boolean }) => string[];
const installed = require("braces/package.json") as { version: string };

describe("vendored braces", () => {
  it("resolves outside the GHSA-vfj7-8cjw-p6xm range and still expands shallow patterns", () => {
    expect(installed.version).toBe("3.0.4");
    expect(braces("{a,b}", { expand: true })).toEqual(["a", "b"]);
    expect(braces("file.{ts,tsx}", { expand: true })).toEqual(["file.ts", "file.tsx"]);
    expect(braces("{1..3}", { expand: true })).toEqual(["1", "2", "3"]);
  });

  it("rejects brace nesting past the depth limit instead of overflowing the stack", () => {
    const nested = `${"{".repeat(33)}a${"}".repeat(33)}`;
    expect(() => braces(nested)).toThrow(SyntaxError);
  });
});
