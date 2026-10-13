// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "@jest/globals";
import { createRequire } from "module";

const require = createRequire(__filename);
const braces = require("braces") as (input: string, options?: { expand?: boolean }) => string[];
const api = require("braces") as { compile:(input:unknown)=>unknown; expand:(input:unknown)=>unknown; stringify:(input:unknown)=>unknown };
const installed = require("braces/package.json") as { version: string; name: string };

describe("vendored braces", () => {
  it("uses the reviewed fork and expands ordinary patterns", () => {
    expect(installed.version).toBe("3.0.3-xgc.1");
    expect(installed.name).toBe("@xgc2/braces");
    expect(braces("{a,b}", { expand: true })).toEqual(["a", "b"]);
    expect(braces("file.{ts,tsx}", { expand: true })).toEqual(["file.ts", "file.tsx"]);
    expect(braces("{1..3}", { expand: true })).toEqual(["1", "2", "3"]);
  });

  it("rejects brace nesting past the depth limit instead of overflowing the stack", () => {
    const nested = `${"{".repeat(33)}a${"}".repeat(33)}`;
    expect(() => braces(nested)).toThrow(SyntaxError);
  });
  it("guards parentheses and caller-provided ASTs at every public walker", () => {
    const parentheses = `${"(".repeat(512)}a${")".repeat(512)}`;
    expect(() => braces(parentheses)).toThrow(SyntaxError);
    const ast: {type:string; nodes:unknown[]} = {type:"root",nodes:[]};
    ast.nodes.push(ast);
    for (const walk of [api.compile,api.expand,api.stringify]) {expect(()=>walk(ast)).toThrow(SyntaxError);}
  });
});
