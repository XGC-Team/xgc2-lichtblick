// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lichtblick-offline-contract-"));
let command = "tsc",
  prefix = [];
try {
  prefix = [require.resolve("typescript/bin/tsc")];
  command = process.execPath;
} catch {
  /* standalone tsc */
}
function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { stdio: "inherit", env });
  if (result.error) {
    console.error(result.error);
  }
  return result.status ?? 1;
}
try {
  // Compiled fixtures live outside the workspace but use its declared dependencies.
  fs.symlinkSync(path.resolve(root, "../node_modules"), path.join(temp, "node_modules"), "dir");
  let status = 0;
  for (const [directory, module] of [
    ["cjs", "commonjs"],
    ["esm", "ES2022"],
  ]) {
    status ||= run(command, [
      ...prefix,
      "--ignoreConfig",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      module,
      "--lib",
      "ES2022,DOM",
      "--outDir",
      path.join(temp, directory),
      path.join(root, "src/offline/state.ts"),
      path.join(root, "src/offline/capture.ts"),
      path.join(root, "src/offline/history.ts"),
      path.join(root, "src/offline/interactive.ts"),
    ]);
  }
  process.exitCode =
    status ||
    run(
      process.execPath,
      [
        "--test",
        path.join(__dirname, "contract.test.cjs"),
        path.join(__dirname, "model-edits.test.cjs"),
      ],
      {
        ...process.env,
        XGC2_OFFLINE_TEST_BUILD: temp,
      },
    );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
