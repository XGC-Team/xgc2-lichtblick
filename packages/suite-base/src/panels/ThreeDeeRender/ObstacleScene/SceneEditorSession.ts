// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { v4 as uuid } from "uuid";

import {
  EmbeddedSceneBridge,
  embeddedSceneBridge,
} from "@lichtblick/suite-base/components/EmbeddedSceneBridge";

import {
  parseSceneEnvelope,
  type SceneCommand,
  type SceneEnvelope,
  type SceneSelection,
} from "./types";

export type SceneAction = SceneCommand extends infer T
  ? T extends SceneCommand
    ? Omit<T, "requestId" | "expectedEpoch" | "expectedRevision">
    : never
  : never;
export type SceneEditorState = {
  envelope?: SceneEnvelope;
  selection?: SceneSelection;
  active: boolean;
  live: boolean;
  authorized: boolean;
  pending: boolean;
  needsRefresh: boolean;
  error?: string;
};

/** Accepted state lives here; render previews never alter it or leak into saved initial poses. */
export class SceneEditorSession {
  #state: SceneEditorState = {
    active: false,
    live: false,
    authorized: false,
    pending: false,
    needsRefresh: false,
  };
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;
  #generation = 0;

  public constructor(
    public readonly namespace: string,
    private bridge: EmbeddedSceneBridge = embeddedSceneBridge,
  ) {
    this.#unsubscribe = bridge.subscribe(this.#bindingChanged);
    this.#bindingChanged();
  }

  public getSnapshot = (): SceneEditorState => this.#state;
  public subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  public dispose(): void {
    this.#generation++;
    this.#unsubscribe();
    this.#listeners.clear();
  }

  #set(patch: Partial<SceneEditorState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => {
      listener();
    });
  }

  #bindingChanged = (): void => {
    const binding = this.bridge.getBinding();
    const authorized = binding?.namespace === this.namespace && binding.editable;
    if (authorized !== this.#state.authorized) {
      this.#generation++;
      this.#set({ authorized, pending: false, needsRefresh: true });
    }
  };

  public setLive({ live }: { live: boolean }): void {
    if (live === this.#state.live) {
      return;
    }
    this.#generation++;
    this.#set({ live, pending: false, needsRefresh: live });
  }

  public setActive({ active }: { active: boolean }): void {
    this.#set({ active });
  }
  public select(selection: SceneSelection | undefined): void {
    this.#set({ selection });
  }
  public reportError(error: unknown): void {
    this.#set({
      error: error instanceof Error ? error.message : String(error),
    });
  }

  public accept(value: unknown): void {
    try {
      const envelope = parseSceneEnvelope(value);
      const current = this.#state.envelope;
      if (current?.epoch === envelope.epoch && current.revision > envelope.revision) {
        return;
      }
      if (current != undefined && current.epoch !== envelope.epoch) {
        this.#generation++;
        this.#set({ pending: false, selection: undefined });
      }
      const selection = this.#state.selection;
      const obstacle = envelope.document.obstacles.find((o) => o.id === selection?.obstacleId);
      this.#set({
        envelope,
        needsRefresh: this.#state.error != undefined,
        selection: obstacle
          ? selection?.partId && !obstacle.parts.some((p) => p.id === selection.partId)
            ? { obstacleId: obstacle.id }
            : selection
          : undefined,
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  public resetForSeek(): void {
    this.#generation++;
    this.#set({
      envelope: undefined,
      selection: undefined,
      pending: false,
      needsRefresh: true,
    });
  }

  public canEdit(): boolean {
    return (
      this.#state.live &&
      this.#state.authorized &&
      !this.#state.pending &&
      !this.#state.needsRefresh &&
      this.#state.envelope != undefined
    );
  }

  public async command(action: SceneAction): Promise<boolean> {
    const { envelope, live, authorized, pending, needsRefresh } = this.#state;
    if (
      !live ||
      !authorized ||
      pending ||
      (action.operation !== "get" &&
        (!envelope || (!["resync", "reload", "save"].includes(action.operation) && needsRefresh)))
    ) {
      this.reportError(
        "Scene editing is unavailable. Connect the live scene and refresh its current state.",
      );
      return false;
    }
    const generation = this.#generation;
    this.#set({
      pending: true,
      ...(action.operation === "resync" ? {} : { error: undefined }),
    });
    try {
      const command: SceneCommand = {
        ...action,
        requestId: uuid(),
        ...(envelope
          ? {
              expectedEpoch: envelope.epoch,
              expectedRevision: envelope.revision,
            }
          : {}),
      };
      const result = await this.bridge.command(this.namespace, command);
      if (generation !== this.#generation) {
        return false;
      }
      if (result.document) {
        // A get response may start a new epoch; mutations from an older epoch cannot overwrite it.
        if (action.operation !== "get" && this.#state.envelope?.epoch !== result.epoch) {
          throw new Error("The scene was reloaded during this edit. Refresh before editing again.");
        }
        parseSceneEnvelope(result);
        this.accept(result);
      }
      if (!result.success) {
        throw new Error(
          result.error ?? "Scene update was rejected. Refresh and check the scene workflow.",
        );
      }
      if (!result.document) {
        throw new Error("Scene update returned no accepted scene. Refresh to check the result.");
      }
      this.#set({ pending: false, needsRefresh: false, error: undefined });
      return true;
    } catch (error) {
      if (generation === this.#generation) {
        this.#set({ pending: false, needsRefresh: true });
        this.reportError(error);
      }
      return false;
    }
  }
}
