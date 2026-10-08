// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type {
  ManagedRequest,
  ManagedTransport,
} from "@lichtblick/suite-base/src/services/persistence/ManagedDocumentStore";

import type { ManagedAsset } from "../../../../xgc2/launcher/managed-storage.cjs";

export type ManagedIPCReply<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        message: string;
        code: string;
        outcome?: string;
        requestId?: string;
        status?: number;
      };
    };

/** Product operations only. Storage scope, paths and credentials stay in main. */
export interface PersistenceBridge {
  domainRequest(
    request: ManagedRequest,
  ): Promise<ManagedIPCReply<Awaited<ReturnType<ManagedTransport>>>>;
  publish(
    bytes: Uint8Array,
    info: { id: string; version: string },
  ): Promise<ManagedIPCReply<ManagedAsset>>;
  load(asset: ManagedAsset): Promise<ManagedIPCReply<Uint8Array>>;
}

// Events that are forwarded from the main process
export type ForwardedMenuEvent =
  | "open"
  | "open-file"
  | "open-connection"
  | "open-demo"
  | "open-help-about"
  | "open-help-docs"
  | "open-help-general";

export type ForwardedWindowEvent =
  "enter-full-screen" | "leave-full-screen" | "maximize" | "unmaximize";

/** Registering an event listener returns a function that will un-register the listener */
export type UnregisterFn = () => void;

interface NativeMenuBridge {
  /**
   * Events from the native window are available in the main process but not the renderer, so we
   * forward them through the bridge.
   *
   * Return a function to remove the registered event handler.
   *
   * NOTE: We use an unregister function return value because the preload <-> renderer bridge
   * intercepts the function. This changes the reference value of the _handler_ function and breaks
   * the conventional event emitter API of using `.off(event, handler)` to unregister an event
   * handler since the handler function that renderer would provided will get wrapped and won't
   * resolve to the same instance as the one in the `.on` call.
   *
   * https://www.electronjs.org/docs/latest/api/context-bridge#parameter--error--return-type-support
   */
  addIpcEventListener(
    eventName: ForwardedMenuEvent,
    handler: () => void,
  ): UnregisterFn;
}

export type CLIFlags = Readonly<Record<string, string>>;

interface Desktop {
  /** https://www.electronjs.org/docs/tutorial/represented-file */
  setRepresentedFilename(path: string | undefined): Promise<void>;

  addIpcEventListener(
    eventName: ForwardedWindowEvent,
    handler: () => void,
  ): UnregisterFn;

  /**
   * Notify the app that the color scheme setting has changed and the native theme may need to be
   * updated.
   */
  updateNativeColorScheme(): Promise<void>;

  // Get an array of deep links provided on app launch
  getDeepLinks: () => Promise<string[]>;

  // Reset the deep links. After reset, `getDeepLinks` will return an empty array.
  resetDeepLinks: () => void;

  // Get CLI flags passed when the app was launched
  getCLIFlags: () => Promise<CLIFlags>;

  /** Handle a double-click on the custom title bar */
  handleTitleBarDoubleClick(): void;

  isMaximized(): boolean;
  minimizeWindow(): void;
  maximizeWindow(): void;
  unmaximizeWindow(): void;
  closeWindow(): void;
  reloadWindow(): void;

  /** Notify the app that the language setting has been changed */
  updateLanguage(): void;
}

export type { Desktop, NativeMenuBridge };
