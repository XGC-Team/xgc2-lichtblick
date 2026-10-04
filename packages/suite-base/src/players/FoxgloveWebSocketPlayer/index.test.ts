/** @jest-environment jsdom */
// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { FoxgloveClient } from "@foxglove/ws-protocol";
import { parseChannel } from "@lichtblick/mcap-support";
import type {
  PlayerMetricsCollectorInterface,
  PlayerState,
  InternalSubscribePayload,
} from "@lichtblick/suite-base/players/types";
import FoxgloveWebSocketPlayer from "./index";
import { mergeSubscriptions } from "@lichtblick/suite-base/components/MessagePipeline/subscriptions";

jest.mock("@foxglove/ws-protocol", () => ({
  ...jest.requireActual("@foxglove/ws-protocol"),
  FoxgloveClient: jest.fn(),
}));
jest.mock("@lichtblick/mcap-support", () => ({ parseChannel: jest.fn() }));
jest.mock("./constants", () => {
  const actual = jest.requireActual("./constants");
  return {
    ...actual,
    resolvePlayerMemoryCaps: () => ({
      ...actual.resolvePlayerMemoryCaps(),
      currentFrameMaximumSizeBytes: 512,
    }),
  };
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("live authorized complete cloud decode", () => {
  it.each([
    "latest",
    "unsubscribe",
    "full-preload",
    "unapproved-oversize",
  ])("preserves the actual merged cloud delivery contract (%s)", async (mode) => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const client = {
      on: jest.fn((event: string, callback: (payload: unknown) => void) =>
        handlers.set(event, callback),
      ),
      subscribe: jest.fn(() => 1),
      unsubscribe: jest.fn(),
      close: jest.fn(),
    };
    jest.mocked(FoxgloveClient).mockImplementation(() => client as unknown as FoxgloveClient);
    const deserialize = jest.fn((data: ArrayBufferView) => ({
      points: Array.from(new Uint8Array(data.buffer)),
      ...(mode === "unapproved-oversize" ? { payload: new Uint8Array(1024) } : {}),
    }));
    jest
      .mocked(parseChannel)
      .mockReturnValue({ datatypes: new Map(), deserialize } as ReturnType<typeof parseChannel>);
    const socket = jest.spyOn(window, "WebSocket").mockImplementation(() => ({}) as WebSocket);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const states: PlayerState[] = [];
    let blocked = false;
    const player = new FoxgloveWebSocketPlayer({
      url: "ws://fixture",
      sourceId: "fixture",
      metricsCollector: {
        playerConstructed: jest.fn(),
      } as unknown as PlayerMetricsCollectorInterface,
    });
    try {
      player.setListener(async (state) => {
        states.push(state);
        if (state.activeData != undefined && !blocked) {
          blocked = true;
          await barrier;
        }
      });
      handlers.get("open")!(undefined);
      const subscription: InternalSubscribePayload = {
        topic: "/cloud",
        preloadType: "partial",
        samplingRequest: { mode: "latest-per-render-tick" },
        samplingAuthorized: true,
      };
      const merged =
        mode === "full-preload"
          ? mergeSubscriptions([subscription, { ...subscription, preloadType: "full" }])
          : [subscription];
      player.setSubscriptions(mode === "unapproved-oversize" ? [{ topic: "/cloud" }] : [...merged]);
      handlers.get("advertise")!([
        {
          id: 1,
          topic: "/cloud",
          encoding: "json",
          schemaName: "foxglove.PointCloud",
          schema: "{}",
        },
      ]);
      await flush();
      expect(blocked).toBe(true);
      const old = new DataView(new Uint8Array([1]).buffer);
      const newer = new DataView(new Uint8Array([2]).buffer);
      const clear = new DataView(new ArrayBuffer(0));
      for (const data of [old, newer, clear]) handlers.get("message")!({ subscriptionId: 1, data });
      if (mode === "full-preload" || mode === "unapproved-oversize")
        expect(deserialize).toHaveBeenCalledTimes(3);
      else expect(deserialize).not.toHaveBeenCalled();
      if (mode === "unsubscribe") player.setSubscriptions([]);
      release();
      await flush();
      const messages = states.flatMap((state) => state.activeData?.messages ?? []);
      if (mode === "unsubscribe") {
        expect(deserialize).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
      } else if (mode === "unapproved-oversize") {
        expect(deserialize).toHaveBeenCalledTimes(3);
        expect(messages).toEqual([]);
        expect(client.close).not.toHaveBeenCalled();
        expect(
          states.some((state) =>
            state.alerts?.some((alert) => alert.message.includes("maximum frame size")),
          ),
        ).toBe(true);
        const expectedErrors = jest.mocked(console.error).mock.calls;
        expect(expectedErrors.length).toBeGreaterThan(0);
        expect(
          expectedErrors.every(
            ([message, id, alert]) =>
              message === "Player alert" &&
              id === "webSocketPlayer:parsedMessageCacheFull" &&
              (alert as { severity?: string }).severity === "error",
          ),
        ).toBe(true);
        jest.mocked(console.error).mockClear();
      } else if (mode === "full-preload") {
        expect(deserialize).toHaveBeenCalledTimes(3);
        expect(messages.map((entry) => entry.message)).toEqual([
          { points: [1] },
          { points: [2] },
          { points: [] },
        ]);
        expect(client.close).not.toHaveBeenCalled();
      } else {
        expect(deserialize).toHaveBeenCalledTimes(1);
        expect(deserialize).toHaveBeenCalledWith(clear);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.message).toEqual({ points: [] });
      }
    } finally {
      release();
      player.close();
      socket.mockRestore();
    }
  });
});
