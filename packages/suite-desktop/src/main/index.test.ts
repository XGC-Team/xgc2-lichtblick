// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { loadBootstrapInput, derivePolicy, Diagnostics } from "@xgc2/xrpc";
import { app } from "electron";

import StudioWindow from "./StudioWindow";
import { createNewWindow } from "./createNewWindow";
import { getFilesToOpen } from "./getFilesToOpen";
import { main } from "./index";
import { initializeAppSettings } from "./settings";
import { createManagedDomainRPC } from "../../../../xgc2/launcher/managed-rpc.cjs";
import {
  createManagedDomainClientFromBootstrap,
  createManagedPolicy,
} from "../../../../xgc2/launcher/managed-storage.cjs";

jest.mock("electron", () => ({
  app: {
    on: jest.fn(),
    whenReady: jest.fn(async () => undefined),
    quit: jest.fn(),
    commandLine: { appendSwitch: jest.fn() },
    requestSingleInstanceLock: jest.fn(() => true),
    isDefaultProtocolClient: jest.fn(() => true),
    setAboutPanelOptions: jest.fn(),
  },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
  ipcMain: { handle: jest.fn() },
  Menu: { setApplicationMenu: jest.fn() },
  nativeTheme: {},
  session: {
    fromPartition: jest.fn(() => ({
      webRequest: { onHeadersReceived: jest.fn() },
    })),
  },
}));
jest.mock("electron-squirrel-startup", () => false);
jest.mock("@xgc2/xrpc", () => ({
  loadBootstrapInput: jest.fn(),
  derivePolicy: jest.fn((parent) => parent),
  Diagnostics: jest.fn(),
}));
jest.mock("@lichtblick/log", () => ({
  __esModule: true,
  default: {
    getLogger: () => ({
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));
jest.mock("../../../suite-base/src/i18n", () => ({
  initI18n: jest.fn(async () => undefined),
  sharedI18nObject: { changeLanguage: jest.fn(async () => undefined) },
}));
jest.mock("./StudioWindow", () => ({
  __esModule: true,
  default: jest.fn(() => ({ load: jest.fn(async () => undefined), getMenu: jest.fn() })),
}));
jest.mock("./StudioAppUpdater", () => ({
  __esModule: true,
  default: { Instance: () => ({ start: jest.fn() }) },
}));
jest.mock("./createNewWindow", () => ({ createNewWindow: jest.fn() }));
jest.mock("./fileUtils", () => ({ isFileToOpen: jest.fn(() => false) }));
jest.mock("./getDevModeIcon", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("./getFilesToOpen", () => ({ getFilesToOpen: jest.fn(() => []) }));
jest.mock("./injectFilesToOpen", () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock("./managedPersistence", () => ({
  registerManagedPersistenceIPC: jest.fn(),
}));
jest.mock("./rosPackageResources", () => ({
  registerRosPackageProtocolHandlers: jest.fn(),
  registerRosPackageProtocolSchemes: jest.fn(),
}));
jest.mock("./settings", () => ({
  initializeAppSettings: jest.fn(async () => undefined),
  getAppSetting: jest.fn(),
}));
jest.mock("../common/webpackDefines", () => ({
  LICHTBLICK_PRODUCT_NAME: "Lichtblick",
  LICHTBLICK_PRODUCT_VERSION: "1.0.0",
  LICHTBLICK_PRODUCT_HOMEPAGE: "https://example.test",
}));
jest.mock("../../../../xgc2/launcher/managed-rpc.cjs", () => ({
  createManagedDomainRPC: jest.fn(),
}));
jest.mock("../../../../xgc2/launcher/managed-storage.cjs", () => ({
  createManagedDomainClientFromBootstrap: jest.fn(),
  createManagedPolicy: jest.fn(),
}));

const policy = { fields: { SHUTDOWN_TIMEOUT_MS: { value: 16000 } } };
const diagnostics = { close: jest.fn(async () => undefined) };
const serviceRef = {
  instance_id: "actual-fixture-instance",
  endpoint: { kind: "https", address: "https://127.0.0.1:31234" },
};
const domainOptions = {} as ReturnType<typeof loadBootstrapInput>;
const startupOptions = {
  bootstrapInput: "/private/desktop-input.json",
  argv: ["electron", ".webpack"],
};

const client = {
  ready: Promise.resolve(),
  request: jest.fn(),
  beginDrain: jest.fn(),
  close: jest.fn(async () => undefined),
};
const rpc = {
  start: jest.fn(async () => ({})),
  close: jest.fn(async () => undefined),
};
beforeEach(() => {
  jest.clearAllMocks();
  rpc.start.mockResolvedValue(serviceRef);
  (createManagedPolicy as jest.Mock).mockReturnValue(policy);
  (Diagnostics as unknown as jest.Mock).mockImplementation(() => diagnostics);
  diagnostics.close.mockResolvedValue(undefined);
  rpc.close.mockResolvedValue(undefined);
  client.close.mockResolvedValue(undefined);
  (initializeAppSettings as jest.Mock).mockResolvedValue(undefined);
  (createManagedDomainClientFromBootstrap as jest.Mock).mockReturnValue(client);
  (createManagedDomainRPC as jest.Mock).mockReturnValue(rpc);
  (loadBootstrapInput as jest.Mock).mockReturnValue(domainOptions);
});

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return {
    promise: new Promise((resolve) => {
      release = resolve;
    }),
    release: () => {
      release();
    },
  };
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) {
    await Promise.resolve();
  }
}
function quit(): jest.Mock {
  const beforeQuit = (app.on as jest.Mock).mock.calls.find(
    ([name]) => name === "before-quit",
  )![1] as (event: { preventDefault: () => void }) => void;
  const preventDefault = jest.fn();
  beforeQuit({ preventDefault });
  return preventDefault;
}

it("starts the owned RPC and loads managed settings before constructing a window", async () => {
  const starting = deferred();
  const loading = deferred();
  const rendererLoading = deferred();
  (StudioWindow as unknown as jest.Mock).mockImplementationOnce(() => ({
    load: jest.fn(async () => {
      await rendererLoading.promise;
    }),
    getMenu: jest.fn(),
  }));
  rpc.start.mockImplementationOnce(async () => {
    await starting.promise;
    return serviceRef;
  });
  (initializeAppSettings as jest.Mock).mockImplementationOnce(async () => {
    await loading.promise;
  });
  const output = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  const initialized = main(startupOptions);
  await flush();
  expect(rpc.start).toHaveBeenCalledTimes(1);
  expect(loadBootstrapInput).toHaveBeenCalledWith(startupOptions.bootstrapInput, {
    role: "server",
  });
  expect(createManagedDomainRPC).toHaveBeenCalledWith(client, { ...domainOptions, policy });
  expect(createManagedDomainClientFromBootstrap).toHaveBeenCalledWith(domainOptions, policy);
  expect(createManagedPolicy).toHaveBeenCalledTimes(1);
  expect(createManagedPolicy).toHaveBeenCalledWith(process.env, diagnostics);
  expect(Diagnostics).toHaveBeenCalledTimes(1);
  expect(derivePolicy).toHaveBeenCalledTimes(2);
  expect(derivePolicy).toHaveBeenCalledWith(policy, {
    role: "lichtblick-storage",
    ceilings: { MAX_REQUEST_BYTES: 4194304, MAX_RESPONSE_BYTES: 4194304 },
  });
  expect(derivePolicy).toHaveBeenCalledWith(policy, {
    role: "lichtblick-private",
    ceilings: { MAX_REQUEST_BYTES: 8388608, MAX_RESPONSE_BYTES: 8388608 },
  });
  expect(initializeAppSettings).not.toHaveBeenCalled();
  expect(StudioWindow).not.toHaveBeenCalled();
  starting.release();
  await flush();
  expect(initializeAppSettings).toHaveBeenCalledTimes(1);
  expect(StudioWindow).not.toHaveBeenCalled();
  expect(output).not.toHaveBeenCalled();
  loading.release();
  await flush();
  expect(output).not.toHaveBeenCalled();
  rendererLoading.release();
  await initialized;
  expect(StudioWindow).toHaveBeenCalledTimes(1);
  expect(output).toHaveBeenCalledWith(
    `${JSON.stringify({ type: "service_ref", service_ref: serviceRef })}\n`,
  );
  output.mockRestore();
});

it("closes RPC before storage and exits after both have drained", async () => {
  await main(startupOptions);
  const draining = deferred();
  rpc.close.mockImplementationOnce(async () => {
    await draining.promise;
  });
  expect(quit()).toHaveBeenCalledTimes(1);
  expect(rpc.close).toHaveBeenCalledTimes(1);
  expect(client.close).not.toHaveBeenCalled();
  expect(diagnostics.close).not.toHaveBeenCalled();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(0);
  expect(quit()).toHaveBeenCalledTimes(1);
  expect(rpc.close).toHaveBeenCalledTimes(1);
  draining.release();
  await flush();
  expect(client.close).toHaveBeenCalledTimes(1);
  expect(diagnostics.close).toHaveBeenCalledWith({ timeoutMs: 16000 });
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(1);
});

it("fails without a window when the RPC cannot start and still releases its client", async () => {
  rpc.start.mockRejectedValueOnce(new Error("RPC grant unavailable"));
  await expect(main(startupOptions)).rejects.toThrow("RPC grant unavailable");
  expect(StudioWindow).not.toHaveBeenCalled();
  quit();
  await flush();
  expect(rpc.close).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(1);
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(1);
});

it("does not forward bootstrap grant paths to file handling or a second-instance window", async () => {
  await main({
    ...startupOptions,
    argv: [
      ...startupOptions.argv,
      "--bootstrap-input",
      startupOptions.bootstrapInput,
      "--force-multiple-windows",
      "/data/run.mcap",
    ],
  });
  expect(getFilesToOpen).toHaveBeenCalledWith([
    ...startupOptions.argv,
    "--force-multiple-windows",
    "/data/run.mcap",
  ]);
  const secondInstance = (app.on as jest.Mock).mock.calls.find(
    ([name]) => name === "second-instance",
  )![1] as (event: unknown, argv: string[]) => void;
  secondInstance({}, [
    ...startupOptions.argv,
    "--bootstrap-input",
    "/private/second-input.json",
    "/data/second.mcap",
  ]);
  expect(createNewWindow).toHaveBeenCalledWith([...startupOptions.argv, "/data/second.mcap"]);
});

it("rejects an invalid shared bootstrap grant before opening a client or window", async () => {
  (loadBootstrapInput as jest.Mock).mockImplementationOnce(() => {
    throw new Error("Bootstrap grant unavailable");
  });
  await expect(main(startupOptions)).rejects.toThrow("Bootstrap grant unavailable");
  expect(createManagedDomainClientFromBootstrap).not.toHaveBeenCalled();
  expect(StudioWindow).not.toHaveBeenCalled();
});

it("does not publish readiness when the initial renderer fails to load", async () => {
  const output = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  (StudioWindow as unknown as jest.Mock).mockImplementationOnce(() => ({
    load: jest.fn(async () => {
      throw new Error("renderer unavailable");
    }),
    getMenu: jest.fn(),
  }));
  await expect(main(startupOptions)).rejects.toThrow("renderer unavailable");
  expect(output).not.toHaveBeenCalled();
  output.mockRestore();
  quit();
  await flush();
  expect(rpc.close).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(1);
});

it("retains the domain and permits a later owner drain when RPC work outlives the close budget", async () => {
  await main(startupOptions);
  rpc.close.mockRejectedValueOnce(new Error("actual work remains"));
  quit();
  await flush();
  expect(client.beginDrain).toHaveBeenCalledTimes(1);
  expect(client.close).not.toHaveBeenCalled();
  expect(diagnostics.close).not.toHaveBeenCalled();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(0);
  quit();
  await flush();
  expect(client.close).toHaveBeenCalledTimes(1);
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(1);
});

it("retains the diagnostic owner until its actual writer drains", async () => {
  await main(startupOptions);
  const draining = deferred();
  diagnostics.close.mockRejectedValueOnce(new Error("writer remains"));
  quit();
  await flush();
  expect(client.close).toHaveBeenCalledTimes(1);
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(0);
  diagnostics.close.mockImplementationOnce(async () => { await draining.promise; });
  quit();
  await flush();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(0);
  draining.release();
  await flush();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(1);
});

it("drains diagnostics when domain construction fails before an owned client exists", async () => {
  (createManagedDomainClientFromBootstrap as jest.Mock).mockImplementationOnce(() => {
    throw new Error("invalid domain grant");
  });
  const draining = deferred();
  diagnostics.close.mockImplementationOnce(async () => { await draining.promise; });
  await expect(main(startupOptions)).rejects.toThrow("invalid domain grant");
  expect(quit()).toHaveBeenCalledTimes(1);
  await flush();
  expect(diagnostics.close).toHaveBeenCalledTimes(1);
  expect(client.close).not.toHaveBeenCalled();
  expect(rpc.close).not.toHaveBeenCalled();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(0);
  draining.release();
  await flush();
  expect((app.quit as jest.Mock).mock.calls).toHaveLength(1);
});
