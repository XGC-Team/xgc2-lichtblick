// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import path from "path";

import {
  ConfigParams,
  devServerConfig,
  mainConfig,
} from "@lichtblick/suite-web/src/webpackConfigs";

import packageJson from "../package.json";

const params: ConfigParams = {
  // A dev server (CleanWebpackPlugin) wipes this directory on startup. The
  // station's embedded viewer serves the static bundle from .webpack, so
  // previews must override the output dir instead of sharing it.
  outputPath: path.resolve(__dirname, process.env.LICHTBLICK_WEB_OUTPUT_DIR ?? ".webpack"),
  contextPath: path.resolve(__dirname, "src"),
  entrypoint: "./entrypoint.tsx",
  prodSourceMap: "source-map",
  version: packageJson.version,
};

// foxglove-depcheck-used: webpack-dev-server
export default [devServerConfig(params), mainConfig(params)];
