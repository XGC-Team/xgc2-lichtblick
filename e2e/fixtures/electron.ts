// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0
import { test as base, _electron as electron, ElectronApplication, Page } from "@playwright/test";
import electronPath from "electron";
import fs from "fs";
import { mkdtemp } from "fs/promises";
import { createRequire } from "module";
import * as os from "os";
import path from "path";

const require = createRequire(__filename);
const { createFakeStorage } = require("../../xgc2/desktop/tests/fake_storage.cjs") as {
  createFakeStorage: (options: {
    socketPath: string;
    scope: { namespace: string; user: string; workspace: string };
    viewScope: { namespace: string; user: string; workspace: string };
  }) => {
    token: string;
    reference: unknown;
    start: () => Promise<void>;
    close: () => Promise<void>;
  };
};
const { writeStartupInput } = require("../../xgc2/desktop/tests/input_fixture.cjs") as {
  writeStartupInput: (
    root: string,
    options: {
      reference: unknown;
      scope: { namespace: string; user: string; workspace: string };
      viewScope: { namespace: string; user: string; workspace: string };
      assets: string;
      token: string;
    },
  ) => string;
};

const STORAGE_SCOPE = { namespace: "lichtblick", user: "alice", workspace: "lab" };
const VIEW_SCOPE = { namespace: "lichtblick", user: "alice", workspace: "lab.view" };

export type ElectronFixtures = {
  electronApp: ElectronApplication;
  mainWindow: Page;
  preInstalledExtensions?: string[];
};

const WEBPACK_PATH = path.resolve(__dirname, "../../desktop/.webpack");

export const test = base.extend<ElectronFixtures & { electronArgs: string[] }>({
  electronArgs: [],
  preInstalledExtensions: [],

  electronApp: async ({ electronArgs, preInstalledExtensions }, use) => {
    checkBuild(WEBPACK_PATH);

    const userDataDir = await mkdtemp(path.join(os.tmpdir(), "e2e-test-"));
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "home-e2e-test-"));
    const grantRoot = await mkdtemp(path.join(os.tmpdir(), "e2e-startup-"));
    fs.chmodSync(grantRoot, 0o700);
    const assets = path.join(grantRoot, "assets");
    fs.mkdirSync(assets, { mode: 0o700 });
    fs.chmodSync(assets, 0o700);
    const storage = createFakeStorage({
      socketPath: path.join(grantRoot, "storage.sock"),
      scope: STORAGE_SCOPE,
      viewScope: VIEW_SCOPE,
    });
    await storage.start();
    const startupInput = writeStartupInput(grantRoot, {
      reference: storage.reference,
      scope: STORAGE_SCOPE,
      viewScope: VIEW_SCOPE,
      assets,
      token: storage.token,
    });
    fs.chmodSync(startupInput, 0o600);
    fs.chmodSync(path.join(grantRoot, "storage-token"), 0o600);

    for (const filename of preInstalledExtensions ?? []) {
      preInstallExtensionInUserFolder(homeDir, filename);
    }

    const app = await electron.launch({
      args: [
        WEBPACK_PATH,
        "--startup-input",
        startupInput,
        `--user-data-dir=${userDataDir}`,
        `--home-dir=${homeDir}`,
        // Force ANGLE's SwiftShader backend so GPU-heavy panels (3D/WebGL, Image)
        // render reliably under headless CI. Newer Chromium (Electron 42) changed
        // its SwiftShader fallback, which slowed panel initialization past the
        // Playwright per-test timeout.
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        ...electronArgs,
      ],
      executablePath: electronPath as unknown as string,
    });
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture `use`, not React hook
      await use(app);
    } finally {
      await app.close();
      await storage.close();
      fs.rmSync(grantRoot, { recursive: true, force: true });
    }
  },

  mainWindow: async ({ electronApp }, use) => {
    const mainAppWindow = await electronApp.firstWindow();
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture `use`, not React hook
    await use(mainAppWindow);
  },
});

function checkBuild(webpackPath: string): void {
  if (!fs.existsSync(webpackPath)) {
    throw new Error(`Webpack path does not exist: ${webpackPath}`);
  }
  const files = fs.readdirSync(webpackPath);
  if (files.length === 0) {
    throw new Error(`Webpack path is empty: ${webpackPath}`);
  }
}

function preInstallExtensionInUserFolder(homeDir: string, filename: string): void {
  const source = path.join(process.cwd(), "e2e", "fixtures", "assets", filename);

  if (!fs.existsSync(source)) {
    throw new Error(`Extension asset not found: ${source}`);
  }

  const extensionsDir = path.join(homeDir, ".lichtblick-suite", "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });

  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    const destDir = path.join(extensionsDir, filename);
    fs.cpSync(source, destDir, { recursive: true });
  } else {
    fs.copyFileSync(source, path.join(extensionsDir, filename));
  }
}

export { expect } from "@playwright/test";
