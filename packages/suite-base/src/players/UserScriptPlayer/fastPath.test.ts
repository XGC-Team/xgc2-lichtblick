// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { signal } from "@lichtblick/den/async";
import FakePlayer from "@lichtblick/suite-base/components/MessagePipeline/FakePlayer";
import {
  MessageEvent,
  PlayerState,
  PlayerStateActiveData,
} from "@lichtblick/suite-base/players/types";
import { UserScript } from "@lichtblick/suite-base/types/panels";
import { basicDatatypes } from "@lichtblick/suite-base/util/basicDatatypes";
import { DEFAULT_STUDIO_SCRIPT_PREFIX } from "@lichtblick/suite-base/util/constants";

import UserScriptPlayer from ".";
import MockUserScriptPlayerWorker from "./MockUserScriptPlayerWorker";

const OUTPUT = `${DEFAULT_STUDIO_SCRIPT_PREFIX}fast_path`;

function message(nsec: number, topic = "/input", payload = "value"): MessageEvent {
  return {
    topic,
    receiveTime: { sec: 1, nsec },
    message: { payload, orientation: { x: 0, y: 0, z: 0.6, w: 0.8 } },
    schemaName: "foo",
    sizeInBytes: 64,
  };
}

const baseActive: PlayerStateActiveData = {
  startTime: { sec: 0, nsec: 0 },
  endTime: { sec: 10, nsec: 0 },
  currentTime: { sec: 1, nsec: 0 },
  isPlaying: true,
  speed: 1,
  lastSeekTime: 0,
  totalBytesReceived: 128,
  messages: [],
  topics: [
    { name: "/input", schemaName: "foo" },
    { name: "/other", schemaName: "foo" },
  ],
  topicStats: new Map(),
  datatypes: new Map([["foo", { definitions: [{ name: "payload", type: "string" }] }]]),
};

function script(input = "/input"): UserScript {
  return {
    name: "Fast path regression",
    sourceCode: `
      export const inputs = ["${input}"];
      export const output = "${OUTPUT}";
      export default (event: { message: { payload: string } }): { value: string } => {
        return { value: event.message.payload };
      };
    `,
  };
}

function setup() {
  const source = new FakePlayer();
  const actions = {
    setUserScriptDiagnostics: jest.fn(),
    addUserScriptLogs: jest.fn(),
    setUserScriptRosLib: jest.fn(),
    setUserScriptTypesLib: jest.fn(),
  };
  const player = new UserScriptPlayer(source, actions);
  const states: PlayerState[] = [];
  player.setListener(async (state) => {
    states.push(state);
  });
  return { source, player, states, actions };
}

describe("UserScriptPlayer optional-work fast path", () => {
  beforeEach(() => {
    jest
      .spyOn(UserScriptPlayer, "CreateRuntimeWorker")
      .mockImplementation(() => new MockUserScriptPlayerWorker() as unknown as SharedWorker);
    jest
      .spyOn(UserScriptPlayer, "CreateTransformWorker")
      .mockImplementation(() => new MockUserScriptPlayerWorker() as unknown as SharedWorker);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("does not schedule per-message empty Promise.all calls for a script-free burst", async () => {
    const { source, player, states, actions } = setup();
    try {
      await source.emit({ activeData: baseActive });
      const input = Object.freeze(Array.from({ length: 2_000 }, (_, i) => message(i)));
      const all = jest.spyOn(Promise, "all");
      await source.emit({ activeData: { ...baseActive, messages: input } });
      expect(all).not.toHaveBeenCalled();
      expect(states.at(-1)?.activeData?.messages).toBe(input);
      expect(UserScriptPlayer.CreateRuntimeWorker).not.toHaveBeenCalled();
      expect(UserScriptPlayer.CreateTransformWorker).not.toHaveBeenCalled();
      expect(actions.setUserScriptRosLib).not.toHaveBeenCalled();
      expect(actions.setUserScriptTypesLib).not.toHaveBeenCalled();
    } finally {
      player.close();
    }
  });

  it("keeps stable timestamp sorting and source identity for unordered input", async () => {
    const { source, player, states } = setup();
    try {
      const a = message(2);
      const b = message(1, "/other");
      const c = message(1);
      const input = Object.freeze([a, b, c, b]);
      await source.emit({ activeData: { ...baseActive, messages: input } });
      expect(states.at(-1)?.activeData?.messages).toEqual([b, c, b, a]);
      expect(states.at(-1)?.activeData?.messages[0]).toBe(b);
      expect(input).toEqual([a, b, c, b]);
    } finally {
      player.close();
    }
  });

  it("retains basic datatypes, source overrides, metadata and seek state", async () => {
    const { source, player, states } = setup();
    try {
      await source.emit({ activeData: baseActive });
      const [basicName] = basicDatatypes.keys();
      expect(basicName).toBeDefined();
      const override = { definitions: [{ name: "overridden", type: "float64" }] };
      const datatypes = new Map(baseActive.datatypes);
      datatypes.set(basicName!, override);
      const messages = Object.freeze([message(3)]);
      const active = { ...baseActive, messages, datatypes, lastSeekTime: 42 };
      await source.emit({ activeData: active });
      const result = states.at(-1)?.activeData;
      expect(result).toMatchObject({ lastSeekTime: 42, totalBytesReceived: 128 });
      expect(result?.messages).toBe(messages);
      expect(result?.topicStats).toBe(active.topicStats);
      expect(result?.topics).toEqual(active.topics);
      expect(result?.datatypes.get(basicName!)).toBe(override);
      expect(result?.datatypes.size).toBe(new Map([...basicDatatypes, ...datatypes]).size);
      expect(UserScriptPlayer.CreateTransformWorker).not.toHaveBeenCalled();
    } finally {
      player.close();
    }
  });

  it("still awaits the downstream listener instead of accumulating unacknowledged frames", async () => {
    const { source, player } = setup();
    const entered = signal();
    const release = signal();
    let completed = false;
    player.setListener(async () => {
      entered.resolve();
      await release;
    });
    try {
      const pending = source.emit({ activeData: baseActive }).then(() => {
        completed = true;
      });
      await entered;
      expect(completed).toBe(false);
      release.resolve();
      await pending;
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      player.close();
    }
  });

  it("activates scripts without reconnecting and returns to the fast path after removal", async () => {
    const { source, player, states } = setup();
    try {
      await source.emit({ activeData: baseActive });
      player.setSubscriptions([{ topic: OUTPUT }]);
      await player.setUserScripts({ node: script() });
      const input = message(1, "/input", "first");
      await source.emit({ activeData: { ...baseActive, messages: [input] } });
      const activeMessages = states.at(-1)?.activeData?.messages;
      expect(activeMessages?.map((event) => event.topic)).toEqual(["/input", OUTPUT]);
      expect(activeMessages?.[0]).toBe(input);
      expect(activeMessages?.[1]?.message).toEqual({ value: "first" });
      expect(source.subscriptions).toEqual([{ topic: "/input", preloadType: "partial" }]);

      await player.setUserScripts({});
      const next = Object.freeze([message(2)]);
      await source.emit({ activeData: { ...baseActive, messages: next } });
      expect(states.at(-1)?.activeData?.messages).toBe(next);
      expect(states.at(-1)?.activeData?.topics.some((topic) => topic.name === OUTPUT)).toBe(false);

      await player.setUserScripts({ node: script() });
      await source.emit({ activeData: { ...baseActive, messages: [message(3)] } });
      expect(states.at(-1)?.activeData?.messages.map((event) => event.topic)).toEqual([
        "/input",
        OUTPUT,
      ]);
    } finally {
      player.close();
    }
  });

  it("keeps pre-script input history needed by a paused edit to another input topic", async () => {
    const { source, player, states } = setup();
    try {
      const saved = message(1, "/other", "cached before scripts existed");
      await source.emit({ activeData: { ...baseActive, messages: [saved] } });
      player.setSubscriptions([{ topic: OUTPUT }]);
      await player.setUserScripts({ node: script() });
      await source.emit({
        activeData: { ...baseActive, isPlaying: false, messages: [message(2)] },
      });
      await player.setUserScripts({ node: script("/other") });
      const result = states.at(-1)?.activeData?.messages;
      expect(result).toHaveLength(1);
      expect(result?.[0]?.topic).toBe(OUTPUT);
      expect(result?.[0]?.receiveTime).toEqual(saved.receiveTime);
      expect(result?.[0]?.message).toEqual({ value: "cached before scripts existed" });
    } finally {
      player.close();
    }
  });

  it("skips empty processing for unsubscribed outputs and unrelated topics", async () => {
    const { source, player, states } = setup();
    try {
      await source.emit({ activeData: baseActive });
      player.setSubscriptions([{ topic: "/input" }]);
      await player.setUserScripts({ node: script() });
      const input = Object.freeze([message(1)]);
      const all = jest.spyOn(Promise, "all");
      await source.emit({ activeData: { ...baseActive, messages: input } });
      expect(all).not.toHaveBeenCalled();
      expect(states.at(-1)?.activeData?.messages).toBe(input);
      expect(UserScriptPlayer.CreateRuntimeWorker).not.toHaveBeenCalled();

      player.setSubscriptions([{ topic: OUTPUT }]);
      const unrelated = Object.freeze([message(2, "/other")]);
      all.mockClear();
      await source.emit({ activeData: { ...baseActive, messages: unrelated } });
      expect(all).not.toHaveBeenCalled();
      expect(states.at(-1)?.activeData?.messages).toBe(unrelated);
      expect(UserScriptPlayer.CreateRuntimeWorker).not.toHaveBeenCalled();
    } finally {
      player.close();
    }
  });
});
