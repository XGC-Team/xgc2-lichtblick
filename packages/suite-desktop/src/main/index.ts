// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { loadBootstrapInput, derivePolicy, Diagnostics } from "@xgc2/xrpc";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session } from "electron";

import Logger from "@lichtblick/log";
import { AppSetting } from "@lichtblick/suite-base/src/AppSetting";
import { initI18n, sharedI18nObject as i18n } from "@lichtblick/suite-base/src/i18n";

import StudioAppUpdater from "./StudioAppUpdater";
import StudioWindow from "./StudioWindow";
import { createNewWindow } from "./createNewWindow";
import { isFileToOpen } from "./fileUtils";
import getDevModeIcon from "./getDevModeIcon";
import { getFilesToOpen } from "./getFilesToOpen";
import injectFilesToOpen from "./injectFilesToOpen";
import { registerManagedPersistenceIPC } from "./managedPersistence";
import { parseCLIFlags } from "./parseCLIFlags";
import { parseDesktopArguments } from "./parseDesktopArguments";
import {
  registerRosPackageProtocolHandlers,
  registerRosPackageProtocolSchemes,
} from "./rosPackageResources";
import { getAppSetting, initializeAppSettings } from "./settings";
import {
  createManagedDomainRPC,
  ManagedDomainRPC,
} from "../../../../xgc2/launcher/managed-rpc.cjs";
import {
  createManagedDomainClientFromBootstrap,
  createManagedPolicy,
  ManagedDomainClient,
} from "../../../../xgc2/launcher/managed-storage.cjs";
import {
  LICHTBLICK_PRODUCT_HOMEPAGE,
  LICHTBLICK_PRODUCT_NAME,
  LICHTBLICK_PRODUCT_VERSION,
} from "../common/webpackDefines";

const log = Logger.getLogger(__filename);

function updateNativeColorScheme() {
  const colorScheme = getAppSetting<string>(AppSetting.COLOR_SCHEME) ?? "system";
  nativeTheme.themeSource =
    colorScheme === "dark" ? "dark" : colorScheme === "light" ? "light" : "system";
}

async function updateLanguage() {
  const language = getAppSetting<unknown>(AppSetting.LANGUAGE);
  if (language != undefined && typeof language !== "string") {
    throw new Error("Managed language setting must be a string");
  }
  log.info(`Loaded language from settings: ${language}`);
  await i18n.changeLanguage(language ?? undefined);
  log.info(`Set language: ${i18n.language}`);
}

export async function main(options: {
  bootstrapInput: string;
  argv?: readonly string[];
}): Promise<void> {
  const publicArguments = parseDesktopArguments(options.argv ?? process.argv).argv;
  // Allow integration tests to override the userData directory
  const userDataOverride = publicArguments.find((arg) => arg.startsWith("--user-data-dir="));
  if (userDataOverride != undefined) {
    app.setPath("userData", userDataOverride.split("=")[1]!);
  }

  // https://github.com/electron/electron/issues/28422#issuecomment-987504138
  app.commandLine.appendSwitch("enable-experimental-web-platform-features");

  // https://github.com/electron/electron/issues/46538#issuecomment-2808806722
  app.commandLine.appendSwitch("gtk-version", "3");

  const start = Date.now();
  log.info(`${LICHTBLICK_PRODUCT_NAME} ${LICHTBLICK_PRODUCT_VERSION}`);

  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction && (app as Partial<typeof app>).dock != undefined) {
    const devIcon = getDevModeIcon();
    if (app.dock && devIcon) {
      app.dock.setIcon(devIcon);
    }
  }

  // Suppress Electron Security Warning in development
  // See the comment for the webSecurity setting on browser window
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = isProduction ? "false" : "true";

  // Handle creating/removing shortcuts on Windows when installing/uninstalling.

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (require("electron-squirrel-startup") as boolean) {
    app.quit();
    return;
  }

  // Check if --force-multiple-windows` is set
  const forceMultipleWindows = publicArguments.some((arg) => arg === "--force-multiple-windows");

  // If another instance of the app is already open, this call triggers the "second-instance" event
  // in the original instance and returns false.
  // In case of forcing multiple instances, we will open a new window and inject the files and deep links manually.
  if (!app.requestSingleInstanceLock()) {
    if (forceMultipleWindows) {
      log.info(
        `An instance of ${LICHTBLICK_PRODUCT_NAME} is already running. Forcing a new window to run in this instance.`,
      );
    } else {
      log.info(`Another instance of ${LICHTBLICK_PRODUCT_NAME} is already running. Quitting.`);
      app.quit();
    }
    return;
  }

  // Forward urls/files opened in a second instance to our default handlers so it's as if we opened them with this instance.
  // In case of forcing multiple instances, we will open a new window and inject the files and deep links manually.
  let desktopInitialized = false;
  const pendingSecondInstances: string[][] = [];
  const handleSecondInstance = (receivedArguments: string[]) => {
    let argv: string[];
    try {
      argv = parseDesktopArguments(receivedArguments).argv;
    } catch {
      log.warn("Rejected invalid second-instance bootstrap arguments");
      return;
    }
    log.debug("Received public arguments from second app instance:", argv);

    if (forceMultipleWindows) {
      log.debug("second-instance: Forcing a new window to run in this instance.");
      createNewWindow(argv);
      return;
    }

    // Bring the app to the front
    const someWindow = BrowserWindow.getAllWindows()[0];
    someWindow?.restore();
    someWindow?.focus();

    const deepLinks = argv.slice(1).filter((arg) => arg.startsWith("lichtblick://"));
    for (const link of deepLinks) {
      app.emit("open-url", { preventDefault() {} }, link);
    }

    const files = argv
      .slice(1)
      .filter((arg) => !arg.startsWith("--")) // Filter out flags
      .filter((arg) => isFileToOpen(arg));
    for (const file of files) {
      app.emit("open-file", { preventDefault() {} }, file);
    }

    // When being asked to open a second instance with no files or deep links then open a blank new
    // window.
    if (files.length === 0 && deepLinks.length === 0) {
      log.debug("second-instance: No files or deeplinks. Opening a new window.");
      void new StudioWindow().load().catch(() => undefined);
    }
  };
  app.on("second-instance", (_ev, argv) => {
    if (!desktopInitialized) {
      if (pendingSecondInstances.length < 8) {
        pendingSecondInstances.push(argv);
      } else {
        log.warn("Desktop startup input queue is full");
      }
      return;
    }
    handleSecondInstance(argv);
  });

  if (!app.isDefaultProtocolClient("foxglove")) {
    if (!app.setAsDefaultProtocolClient("foxglove")) {
      log.warn("Could not set app as handler for lichtblick://");
    }
  }

  const filesToOpen = getFilesToOpen(publicArguments);

  // indicates the preloader has setup the file input used to inject which files to open
  let preloaderFileInputIsReady = false;

  // This handles user dropping files on the dock icon or double clicking a file when the app
  // is already open.
  //
  // The open-file handler registered earlier will handle adding the file to filesToOpen
  app.on("open-file", async (_ev, filePath) => {
    log.debug("open-file handler", filePath);
    filesToOpen.push(filePath);

    if (preloaderFileInputIsReady) {
      const focusedWindow = BrowserWindow.getFocusedWindow();
      if (focusedWindow) {
        await injectFilesToOpen(focusedWindow.webContents.debugger, filesToOpen);
      } else {
        // On MacOS the user may have closed all the windows so we need to open a new window
        void new StudioWindow().load().catch(() => undefined);
      }
    }
  });

  // preload will tell us when it is ready to process the pending open file requests
  // It is important this handler is registered before any windows open because preload will call
  // this handler to get the files we were told to open on startup
  ipcMain.handle("load-pending-files", async (ev) => {
    log.debug("load-pending-files");
    const debug = ev.sender.debugger;
    await injectFilesToOpen(debug, filesToOpen);
    preloaderFileInputIsReady = true;
  });

  ipcMain.handle("setRepresentedFilename", (ev, filePath: string | undefined) => {
    const browserWindow = BrowserWindow.fromId(ev.sender.id);
    browserWindow?.setRepresentedFilename(filePath ?? "");
  });

  const openUrls: string[] = [];

  // works on osx - even when app is closed
  // tho it is a bit strange since it isn't clear when this runs...
  app.on("open-url", (ev, url) => {
    log.debug("open-url handler", url);
    if (!url.startsWith("lichtblick://")) {
      return;
    }

    ev.preventDefault();

    if (url.startsWith("lichtblick://signin-complete")) {
      // When completing sign in from Console, the browser can launch this URL to re-focus the app.
      app.focus({ steal: true });
    } else if (desktopInitialized) {
      void new StudioWindow([url]).load().catch(() => undefined);
    } else {
      openUrls.push(url);
    }
  });

  // Get the command line flags passed to the app when it was launched
  const parsedCLIFlags = parseCLIFlags(publicArguments);

  ipcMain.handle("getDeepLinks", (event) => {
    if (
      event.senderFrame !== event.sender.mainFrame ||
      !StudioWindow.isRendererURL(event.senderFrame.url)
    ) {
      throw new Error("Deep links are restricted to the desktop renderer");
    }
    const studioWindow = StudioWindow.fromWebContentsId(event.sender.id);
    if (!studioWindow) {
      throw new Error("Unknown desktop window");
    }
    return studioWindow.getDeepLinks();
  });

  ipcMain.handle("getCLIFlags", () => parsedCLIFlags);

  // Must be called before app.ready event
  registerRosPackageProtocolSchemes();

  ipcMain.handle("updateNativeColorScheme", () => {
    updateNativeColorScheme();
  });

  ipcMain.handle("updateLanguage", () => {
    void updateLanguage();
  });

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  const domainOptions = loadBootstrapInput(options.bootstrapInput, { role: "server" });
  const diagnostics = new Diagnostics({
    sink: { kind: "supervisor_stderr", rotationOwner: "supervisor" },
  });
  const policy = createManagedPolicy(process.env, diagnostics);
  const runtime: { rpc?: ManagedDomainRPC; client?: ManagedDomainClient } = {};
  let closing = false;
  let drained = false;
  app.on("before-quit", (event) => {
    if (drained) {
      return;
    }
    event.preventDefault();
    if (!closing) {
      closing = true;
      runtime.client?.beginDrain();
      void (async () => {
        await runtime.rpc?.close();
        await runtime.client?.close();
        await diagnostics.close({ timeoutMs: Number(policy.fields.SHUTDOWN_TIMEOUT_MS?.value) });
      })()
        .then(() => {
          drained = true;
          app.quit();
        })
        .catch((error: unknown) => {
          closing = false;
          log.error("Managed persistence drain incomplete; owner retains resources", error);
        });
    }
  });
  const managedClient = createManagedDomainClientFromBootstrap(
    domainOptions,
    derivePolicy(policy, {
      role: "lichtblick-storage",
      ceilings: { MAX_REQUEST_BYTES: 4 * 1024 * 1024, MAX_RESPONSE_BYTES: 4 * 1024 * 1024 },
    }),
  );
  runtime.client = managedClient;
  registerManagedPersistenceIPC(managedClient);
  // whenReady also handles readiness reached while loading the managed snapshot.
  await Promise.all([app.whenReady(), managedClient.ready]);
  runtime.rpc = createManagedDomainRPC(managedClient, {
    ...domainOptions,
    policy: derivePolicy(policy, {
      role: "lichtblick-private",
      ceilings: { MAX_REQUEST_BYTES: 8 * 1024 * 1024, MAX_RESPONSE_BYTES: 8 * 1024 * 1024 },
    }),
  });
  const serviceRef = await runtime.rpc.start();
  await initializeAppSettings(async (request) => await managedClient.request(request));
  await initI18n({ context: "electron-main" });
  await updateLanguage();
  {
    updateNativeColorScheme();
    const deepLinks = publicArguments.filter((arg) => arg.startsWith("lichtblick://"));

    // create the initial window now to display to the user immediately
    // loading the app url happens at the end of ready to ensure we've setup all the handlers, settings, etc
    log.debug(`Elapsed (ms) until new StudioWindow: ${Date.now() - start}`);
    const initialWindow = new StudioWindow([...deepLinks, ...openUrls]);

    registerRosPackageProtocolHandlers();

    // Only production builds check for automatic updates
    if (process.env.NODE_ENV !== "production") {
      log.info("Automatic updates disabled (development environment)");
    } else if (/-(dev|nightly)/.test(LICHTBLICK_PRODUCT_VERSION)) {
      log.info("Automatic updates disabled (development version)");
    }

    StudioAppUpdater.Instance().start();

    app.setAboutPanelOptions({
      applicationName: LICHTBLICK_PRODUCT_NAME,
      applicationVersion: LICHTBLICK_PRODUCT_VERSION,
      version: process.platform,
      copyright: undefined,
      website: LICHTBLICK_PRODUCT_HOMEPAGE,
      iconPath: undefined,
    });

    // Content Security Policy
    // See: https://www.electronjs.org/docs/tutorial/security
    const contentSecurityPolicy: Record<string, string> = {
      "default-src": "'self'",
      "script-src": `'self' 'unsafe-inline' 'unsafe-eval'`,
      "worker-src": `'self' blob:`,
      "style-src": "'self' 'unsafe-inline'",
      "connect-src": "'self' ws: wss: http: https: package: blob: data: file:",
      "font-src": "'self' data:",
      // Include http in the CSP to allow loading images (i.e. map tiles) from http endpoints like localhost
      "img-src": "'self' data: https: package: x-foxglove-converted-tiff: http:",
      "media-src": "'self' data: https: http: blob: file:",
    };
    const cspHeader = Object.entries(contentSecurityPolicy)
      .map(([key, val]) => `${key} ${val}`)
      .join("; ");

    // Set default http headers
    session
      .fromPartition("lichtblick-runtime")
      .webRequest.onHeadersReceived((details, callback) => {
        const url = new URL(details.url);
        const responseHeaders = { ...details.responseHeaders };

        // don't set CSP for internal URLs
        if (!["chrome-extension:", "devtools:", "data:"].includes(url.protocol)) {
          responseHeaders["Content-Security-Policy"] = [cspHeader];
        }

        callback({ responseHeaders });
      });

    // When we change the focused window we switch the app menu so actions go to the correct window
    app.on("browser-window-focus", (_ev, browserWindow) => {
      const studioWindow = StudioWindow.fromWebContentsId(browserWindow.webContents.id);
      if (studioWindow) {
        Menu.setApplicationMenu(studioWindow.getMenu());
      }
    });

    // This event handler must be added after the "ready" event fires
    // (see https://github.com/electron/electron-quick-start/pull/382)
    app.on("activate", () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) {
        void new StudioWindow().load().catch(() => undefined);
      }
    });

    desktopInitialized = true;
    await initialWindow.load();
    for (const pendingArguments of pendingSecondInstances) {
      handleSecondInstance(pendingArguments);
    }
    pendingSecondInstances.length = 0;
    Menu.setApplicationMenu(initialWindow.getMenu()); // When the app is launching for the first time we don't receive the browser-window-focus event.
  }
  process.stdout.write(`${JSON.stringify({ type: "service_ref", service_ref: serviceRef })}\n`);

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
