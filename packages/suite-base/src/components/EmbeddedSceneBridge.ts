// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  isRecord,
  sceneNamespace,
  type SceneCommand,
  type SceneCommandResult,
} from "@lichtblick/suite-base/panels/ThreeDeeRender/ObstacleScene/types";

import { XGC2_EMBED_CHANNEL, XGC2_EMBED_VERSION } from "./EmbeddedWorkspaceProtocol";

export type SceneBinding = { namespace: string; editable: boolean };
type HostEnvelope = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "xgc2";
};
export type Xgc2SceneBindingMessage = HostEnvelope & {
  type: "scene-binding";
  binding?: SceneBinding;
};
export type Xgc2SceneCommandResultMessage = HostEnvelope & {
  type: "scene-command-result";
  requestId: string;
  result: SceneCommandResult;
  error?: string;
};
export type Xgc2SceneCommandMessage = {
  channel: typeof XGC2_EMBED_CHANNEL;
  version: typeof XGC2_EMBED_VERSION;
  sender: "lichtblick";
  type: "scene-command";
  requestId: string;
  command: SceneCommand;
};

export function isSceneHostMessage(
  value: unknown,
): value is Xgc2SceneBindingMessage | Xgc2SceneCommandResultMessage {
  if (
    !isRecord(value) ||
    value.channel !== XGC2_EMBED_CHANNEL ||
    value.version !== XGC2_EMBED_VERSION ||
    value.sender !== "xgc2"
  ) {
    return false;
  }
  const common = ["channel", "version", "sender", "type"];
  if (value.type === "scene-binding") {
    return (
      Object.keys(value).every((k) => [...common, "binding"].includes(k)) &&
      (typeof value.binding === "undefined" ||
        (isRecord(value.binding) &&
          Object.keys(value.binding).every((k) => ["namespace", "editable"].includes(k)) &&
          sceneNamespace(value.binding.namespace) != undefined &&
          typeof value.binding.editable === "boolean"))
    );
  }
  return (
    value.type === "scene-command-result" &&
    Object.keys(value).every((k) => [...common, "requestId", "result", "error"].includes(k)) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    isRecord(value.result) &&
    typeof value.result.success === "boolean" &&
    (typeof value.error === "undefined" || typeof value.error === "string")
  );
}

/** Only the authenticated embed host supplies this transport. It never publishes ROS messages. */
export class EmbeddedSceneBridge {
  #binding: SceneBinding | undefined;
  #listeners = new Set<() => void>();
  #pending = new Map<
    string,
    {
      resolve: (v: SceneCommandResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  #parent: Window | undefined;
  #origin: string | undefined;

  public getBinding = (): SceneBinding | undefined => this.#binding;
  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public connect(parent: Window, origin: string): () => void {
    this.#parent = parent;
    this.#origin = origin;
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== parent || event.origin !== origin || !isSceneHostMessage(event.data)) {
        return;
      }
      const message = event.data;
      if (message.type === "scene-binding") {
        if (
          this.#binding?.namespace !== message.binding?.namespace ||
          this.#binding?.editable !== message.binding?.editable
        ) {
          this.#rejectPending(
            "Scene editing connection changed. Refresh the scene before editing.",
          );
          this.#binding = message.binding;
          this.#listeners.forEach((listener) => {
            listener();
          });
        }
      } else {
        const pending = this.#pending.get(message.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.#pending.delete(message.requestId);
          pending.resolve(
            message.error
              ? { ...message.result, success: false, error: message.error }
              : message.result,
          );
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      this.#parent = undefined;
      this.#origin = undefined;
      this.#binding = undefined;
      this.#rejectPending("Scene editing connection closed. Reopen the experiment view.");
      this.#listeners.forEach((listener) => {
        listener();
      });
    };
  }

  public async command(namespace: string, command: SceneCommand): Promise<SceneCommandResult> {
    if (
      !this.#parent ||
      !this.#origin ||
      this.#binding?.namespace !== namespace ||
      !this.#binding.editable
    ) {
      throw new Error("Scene editing is unavailable. Open a live scene in the experiment view.");
    }
    if (this.#pending.has(command.requestId)) {
      throw new Error("This scene request is already pending.");
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(command.requestId);
        reject(
          new Error(
            "Scene update timed out. Refresh to check the current scene before trying again.",
          ),
        );
      }, 30_000);
      this.#pending.set(command.requestId, { resolve, reject, timeout });
      const message: Xgc2SceneCommandMessage = {
        channel: XGC2_EMBED_CHANNEL,
        version: XGC2_EMBED_VERSION,
        sender: "lichtblick",
        type: "scene-command",
        requestId: command.requestId,
        command,
      };
      this.#parent!.postMessage(message, this.#origin!);
    });
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }
}

export const embeddedSceneBridge = new EmbeddedSceneBridge();
