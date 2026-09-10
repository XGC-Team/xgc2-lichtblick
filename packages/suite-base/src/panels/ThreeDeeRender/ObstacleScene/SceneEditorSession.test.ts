// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { EmbeddedSceneBridge } from "@lichtblick/suite-base/components/EmbeddedSceneBridge";

import { SceneEditorSession } from "./SceneEditorSession";
import { createObstacle } from "./geometry";
import { type SceneEnvelope, type SceneCommandResult } from "./types";

function envelope(revision = 1): SceneEnvelope {
  return {
    epoch: "epoch-1",
    revision,
    savedRevision: 1,
    dirty: revision !== 1,
    playing: false,
    sceneTime: 0,
    consumers: [],
    document: {
      schema: "xgc2.scene.v1",
      id: "test",
      frame: "world",
      obstacles: [createObstacle("Arch", "arch-1")],
    },
  };
}

async function createSession() {
  const bridge = new EmbeddedSceneBridge();
  jest.spyOn(bridge, "getBinding").mockReturnValue({ namespace: "/xgc/scene", editable: true });
  const command = jest.spyOn(bridge, "command").mockResolvedValue({ success: true, ...envelope() });
  const session = new SceneEditorSession("/xgc/scene", bridge);
  session.setLive({ live: true });
  session.accept(envelope());
  await Promise.resolve();
  await Promise.resolve();
  return { session, command };
}

describe("scene authority and live edits", () => {
  it("does not launch Scene commands merely because an optional scene is configured", () => {
    const bridge = new EmbeddedSceneBridge();
    jest.spyOn(bridge, "getBinding").mockReturnValue({ namespace: "/xgc/scene", editable: true });
    const command = jest.spyOn(bridge, "command");
    const session = new SceneEditorSession("/xgc/scene", bridge);
    session.setLive({ live: true });
    session.setActive({ active: true });
    session.resetForSeek();
    expect(command).not.toHaveBeenCalled();
    expect(session.canEdit()).toBe(false);
    session.accept(envelope());
    expect(session.canEdit()).toBe(true);
    session.dispose();
  });

  it("keeps bags read only even with a valid host and recorded document", async () => {
    const { session, command } = await createSession();
    session.setLive({ live: false });
    session.accept(envelope());
    command.mockClear();
    expect(await session.command({ operation: "delete", id: "arch-1" })).toBe(false);
    expect(command).not.toHaveBeenCalled();
    session.dispose();
  });

  it("waits for the live document after a renderer seek and ignores an old in-flight get", async () => {
    const { session, command } = await createSession();
    let finishOld!: (value: SceneCommandResult) => void;
    command.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    const oldGet = session.command({ operation: "get" });
    session.resetForSeek();
    expect(session.canEdit()).toBe(false);
    session.accept(envelope(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(session.canEdit()).toBe(true);
    expect(session.getSnapshot().envelope?.revision).toBe(3);
    finishOld({ success: true, ...envelope(2) });
    await oldGet;
    expect(session.getSnapshot().envelope?.revision).toBe(3);
    session.setLive({ live: false });
    command.mockClear();
    session.resetForSeek();
    expect(command).not.toHaveBeenCalled();
    expect(session.getSnapshot().envelope).toBeUndefined();
    session.dispose();
  });

  it("only adopts acknowledged edits and sends expected epoch/revision", async () => {
    const { session, command } = await createSession();
    const next = envelope(2);
    next.document.obstacles[0]!.pose.position = [1, 2, 3];
    let accept!: (value: SceneCommandResult) => void;
    command.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const pending = session.command({ operation: "update", obstacle: next.document.obstacles[0]! });
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({
        expectedEpoch: "epoch-1",
        expectedRevision: 1,
        operation: "update",
      }),
    );
    expect(session.getSnapshot().envelope).toEqual(envelope());
    accept({ success: true, ...next });
    await expect(pending).resolves.toBe(true);
    expect(session.getSnapshot().envelope).toEqual(next);
    session.dispose();
  });

  it("keeps accepted geometry after rejection and requires refresh", async () => {
    const { session, command } = await createSession();
    command.mockResolvedValue({
      success: false,
      error: "Gazebo collision update failed",
      ...envelope(),
    });
    expect(await session.command({ operation: "delete", id: "arch-1" })).toBe(false);
    expect(session.getSnapshot().envelope).toEqual(envelope());
    expect(session.getSnapshot().error).toContain("collision update failed");
    expect(session.canEdit()).toBe(false);
    session.dispose();
  });

  it("retries synchronization after failure without hiding the outstanding error before acknowledgement", async () => {
    const { session, command } = await createSession();
    command.mockResolvedValue({
      success: false,
      error: "Gazebo collision update failed",
      ...envelope(),
      synchronized: false,
    });
    await session.command({ operation: "delete", id: "arch-1" });
    let accept!: (value: SceneCommandResult) => void;
    command.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const retry = session.command({ operation: "resync" });
    expect(session.getSnapshot().error).toContain("collision update failed");
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({ operation: "resync", expectedRevision: 1 }),
    );
    accept({ success: true, ...envelope(3), dirty: false, synchronized: true });
    expect(await retry).toBe(true);
    expect(session.getSnapshot().error).toBeUndefined();
    expect(session.canEdit()).toBe(true);
    session.dispose();
  });

  it("does not roll back a newer snapshot when an older command response arrives", async () => {
    const { session, command } = await createSession();
    let accept!: (value: SceneCommandResult) => void;
    command.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const pending = session.command({ operation: "undo" });
    session.accept(envelope(4));
    accept({ success: true, ...envelope(2) });
    await pending;
    expect(session.getSnapshot().envelope?.revision).toBe(4);
    session.dispose();
  });

  it("ignores delayed results after scene reload and preserves stable selection across updates", async () => {
    const { session, command } = await createSession();
    session.select({ obstacleId: "arch-1", partId: "lintel" });
    session.accept(envelope(2));
    expect(session.getSnapshot().selection?.partId).toBe("lintel");
    let accept!: (value: SceneCommandResult) => void;
    command.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    const pending = session.command({ operation: "undo" });
    const reloaded = { ...envelope(), epoch: "epoch-2" };
    session.accept(reloaded);
    accept({ success: true, ...envelope(3) });
    await pending;
    expect(session.getSnapshot().envelope?.epoch).toBe("epoch-2");
    expect(session.getSnapshot().selection).toBeUndefined();
    session.dispose();
  });

  it("saving uses initial poses, without copying transient motion state into the document", async () => {
    const { session, command } = await createSession();
    const initial = envelope();
    initial.document.obstacles[0]!.motion = {
      type: "constant_twist",
      linear: [1, 0, 0],
      angular: [0, 0, 0],
    };
    session.accept({ ...initial, playing: true, sceneTime: 10 });
    command.mockResolvedValue({ success: true, ...initial });
    expect(await session.command({ operation: "save" })).toBe(true);
    expect(command).toHaveBeenLastCalledWith(
      "/xgc/scene",
      expect.objectContaining({ operation: "save" }),
    );
    expect(command.mock.lastCall?.[1]).not.toHaveProperty("document");
    session.dispose();
  });
});
