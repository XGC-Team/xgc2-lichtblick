// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "../..");
exports.load = function load(file, blob) {
  const filename = path.join(root, file);
  let source = blob
    ? execFileSync("git", ["cat-file", "blob", blob], { cwd: root, encoding: "utf8" })
    : readFileSync(filename, "utf8");
  // The legacy aggregation file also defined an unused moize factory. Do not reinstall a
  // removed runtime dependency just to load that dead declaration; merge functions are unchanged.
  if (blob === "c874733d6436db3581334257aa47457b7de4aa14") {
    source = source
      .replace('import moize from "moize";\n', "")
      .replace(/export function makeSubscriptionMemoizer\(\):[^]*?\n}\n/, "");
  }
  const mod = new Module(filename, module);
  mod.filename = filename;
  // eslint-disable-next-line no-underscore-dangle -- Node CommonJS internals are isolated to this benchmark loader.
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = mod.require.bind(mod);
  mod.require = (specifier) =>
    specifier.startsWith("@lichtblick/suite-base/")
      ? exports.load(
          "packages/suite-base/src/" + specifier.slice("@lichtblick/suite-base/".length) + ".ts",
        )
      : nativeRequire(specifier);
  // eslint-disable-next-line no-underscore-dangle -- Compile the selected git snapshot, not a second implementation.
  mod._compile(
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    filename,
  );
  return mod.exports;
};
exports.queuePath = "packages/suite-base/src/players/FoxgloveWebSocketPlayer/liveMessageQueue.ts";
exports.queueBlob = "a7fa8172641ce2e7f0af9c920c7d57135e385206";
