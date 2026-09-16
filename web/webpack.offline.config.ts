// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import path from "path";
import { mainConfig } from "@lichtblick/suite-web/src/webpackConfigs";
import packageJson from "../package.json";

// Separate build/entrypoint: never imported by the live web or desktop application.
export default mainConfig({
  outputPath: path.resolve(__dirname, ".webpack-offline"),
  contextPath: path.resolve(__dirname, "src"),
  entrypoint: "./offline/index.ts",
  prodSourceMap: false,
  version: packageJson.version,
});
