/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { EventEmitter } from "events";

import {
  registerEmbeddedCanvasVisibility,
  resetEmbeddedHostVisibilityForTests,
  subscribeLiveViewPause,
  type EmbeddedCanvasVisibilityReporter,
} from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import { XGC2_HOST_VISIBILITY_EVENT } from "@lichtblick/suite-base/components/EmbeddedWorkspaceProtocol";
import {
  PlayerPresence,
  type MessageEvent,
  type PlayerState,
} from "@lichtblick/suite-base/players/types";

import FoxgloveWebSocketPlayer from "./index";

const mockDeserialize = jest.fn((data: ArrayBufferView) => ({
  bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
}));

jest.mock("@foxglove/ws-protocol", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeFoxgloveClient extends Emitter {
    public static SUPPORTED_SUBPROTOCOL = "foxglove.websocket.v1";
    public static instances: FakeFoxgloveClient[] = [];
    public nextSubscriptionId = 100;
    public subscribe = jest.fn((_channelId: number) => this.nextSubscriptionId++);
    public unsubscribe = jest.fn();
    public unsubscribeConnectionGraph = jest.fn();
    public subscribeConnectionGraph = jest.fn();
    public getParameters = jest.fn();
    public sendServiceCallRequest = jest.fn();
    public close = jest.fn();
    public constructor(_args: unknown) {
      super();
      FakeFoxgloveClient.instances.push(this);
    }
  }
  return {
    __esModule: true,
    FoxgloveClient: FakeFoxgloveClient,
    ServerCapability: {
      time: "time",
      clientPublish: "clientPublish",
      services: "services",
      parameters: "parameters",
      parametersSubscribe: "parametersSubscribe",
      connectionGraph: "connectionGraph",
      assets: "assets",
    },
    StatusLevel: { INFO: 0, WARNING: 1, ERROR: 2 },
    FetchAssetStatus: { SUCCESS: 0, ERROR: 1 },
    BinaryOpcode: { MESSAGE_DATA: 1, TIME: 2, SERVICE_CALL_RESPONSE: 3, FETCH_ASSET_RESPONSE: 4 },
  };
});

jest.mock("@lichtblick/mcap-support", () => ({
  ...jest.requireActual("@lichtblick/mcap-support"),
  parseChannel: jest.fn(),
}));

type FakeClientInstance = EventEmitter & {
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  getParameters: jest.Mock;
  subscribeConnectionGraph: jest.Mock;
  unsubscribeConnectionGraph: jest.Mock;
  close: jest.Mock;
  sendServiceCallRequest: jest.Mock;
};
const FakeClient: { instances: FakeClientInstance[] } =
  jest.requireMock("@foxglove/ws-protocol").FoxgloveClient;
const parseChannelMock: jest.Mock = jest.requireMock("@lichtblick/mcap-support").parseChannel;
const channels = [
  { id: 11, topic: "/cloud", schemaName: "sensor_msgs/PointCloud2" },
  { id: 12, topic: "/tf", schemaName: "tf2_msgs/TFMessage" },
  { id: 13, topic: "/scene", schemaName: "foxglove.SceneUpdate" },
  { id: 14, topic: "/markers", schemaName: "visualization_msgs/MarkerArray" },
].map((channel) => ({ ...channel, encoding: "json", schema: "{}", schemaEncoding: "jsonschema" }));

class StubWebSocket {
  public close(): void {}
}

type Harness = {
  player: FoxgloveWebSocketPlayer;
  states: PlayerState[];
  reporter: EmbeddedCanvasVisibilityReporter;
};

function collectMessages(states: PlayerState[]): MessageEvent[] {
  return states.flatMap((state) => state.activeData?.messages ?? []);
}
function connect(client: FakeClientInstance): void {
  client.emit("open");
  client.emit("serverInfo", { capabilities: [], name: "fake", sessionId: "session" });
  client.emit("advertise", channels);
}
function subscription(client: FakeClientInstance, channelId: number): number {
  const index = client.subscribe.mock.calls.findIndex((call: unknown[]) => call[0] === channelId);
  return client.subscribe.mock.results[index]!.value as number;
}
function send(client: FakeClientInstance, subId: number, bytes: number[]): void {
  client.emit("message", { subscriptionId: subId, data: new Uint8Array(bytes) });
}
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) {
    await Promise.resolve();
  }
}

describe("FoxgloveWebSocketPlayer view lifetime", () => {
  let harnesses: Harness[];
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  function setup({ startParked = false }: { startParked?: boolean } = {}): Harness {
    const reporter = registerEmbeddedCanvasVisibility(`canvas-${harnesses.length}`);
    if (startParked) {
      reporter.setVisible(false);
    }
    const player = new FoxgloveWebSocketPlayer({
      url: "ws://127.0.0.1:1",
      metricsCollector: { setProperty: jest.fn(), playerConstructed: jest.fn() },
      sourceId: "foxglove-websocket",
    });
    const states: PlayerState[] = [];
    player.setListener(async (state) => {
      states.push(state);
    });
    player.setSubscriptions(channels.map(({ topic }) => ({ topic })));
    if (!startParked) {
      connect(FakeClient.instances.at(-1)!);
    }
    const harness = { player, states, reporter };
    harnesses.push(harness);
    return harness;
  }

  beforeAll(() => {
    (globalThis as Record<string, unknown>).WebSocket = StubWebSocket;
  });
  beforeEach(() => {
    FakeClient.instances.length = 0;
    harnesses = [];
    mockDeserialize.mockImplementation((data: ArrayBufferView) => ({
      bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    }));
    parseChannelMock.mockImplementation((args: { schema: { name: string } }) => ({
      datatypes: new Map([[args.schema.name, { name: args.schema.name }]]),
      deserialize: mockDeserialize,
    }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(() => {
    for (const { player, reporter } of harnesses) {
      player.close();
      reporter.dispose();
    }
    if (visibility) {
      Object.defineProperty(document, "visibilityState", visibility);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
    jest.useRealTimers();
    (console.warn as jest.Mock).mockClear();
  });

  it("releases every view subscription and ignores 100 late messages before one reveal connection", async () => {
    const { reporter, states } = setup();
    const first = FakeClient.instances[0]!;
    send(first, subscription(first, 12), [1]);
    send(first, subscription(first, 13), [2]);
    await flush();
    const previousSeek = states.at(-1)!.activeData!.lastSeekTime;
    states.length = 0;
    mockDeserialize.mockClear();
    reporter.setVisible(false);
    expect(first.unsubscribe.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual(
      channels.map(({ id }) => subscription(first, id)).sort(),
    );
    expect(first.close).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 100; index++) {
      send(first, subscription(first, 11), [index]);
      first.emit("advertise", channels);
      first.emit("close");
      reporter.setVisible(false);
    }
    await flush();
    expect(mockDeserialize).not.toHaveBeenCalled();
    expect(states).toHaveLength(0);
    expect(FakeClient.instances).toHaveLength(1);
    reporter.setVisible(true);
    expect(FakeClient.instances).toHaveLength(2);
    const current = FakeClient.instances[1]!;
    connect(current);
    await flush();
    expect(current.subscribe.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual(
      channels.map(({ id }) => id).sort(),
    );
    expect(states.at(-1)!.activeData!.lastSeekTime).toBeGreaterThan(previousSeek);
    states.length = 0;
    send(current, subscription(current, 12), [4]);
    send(current, subscription(current, 12), [5]);
    send(current, subscription(current, 14), [6]);
    await flush();
    expect(collectMessages(states).map((message) => [message.topic, message.message])).toEqual([
      ["/tf", { bytes: [4] }],
      ["/tf", { bytes: [5] }],
      ["/markers", { bytes: [6] }],
    ]);
    expect(mockDeserialize).toHaveBeenCalledTimes(3);
  });

  it("does not open or retry while initially parked and creates one connection on reveal", async () => {
    jest.useFakeTimers();
    const { reporter } = setup({ startParked: true });
    expect(FakeClient.instances).toHaveLength(0);
    jest.advanceTimersByTime(60_000);
    expect(FakeClient.instances).toHaveLength(0);
    reporter.setVisible(true);
    expect(FakeClient.instances).toHaveLength(1);
    connect(FakeClient.instances[0]!);
    await flush();
    expect(FakeClient.instances[0]!.subscribe).toHaveBeenCalledTimes(4);
  });

  it("signals one live scene discontinuity for repeated parked notifications", () => {
    const { reporter } = setup();
    const paused = jest.fn();
    const unsubscribe = subscribeLiveViewPause(paused);
    try {
      for (let index = 0; index < 100; index++) {
        reporter.setVisible(false);
      }
      expect(paused).toHaveBeenCalledTimes(1);
      reporter.setVisible(true);
      reporter.setVisible(false);
      expect(paused).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("stops parameter polling and connection-graph demand while parked", () => {
    jest.useFakeTimers();
    const { reporter } = setup();
    const client = FakeClient.instances[0]!;
    client.emit("serverInfo", {
      capabilities: ["parameters", "connectionGraph"],
      name: "fake",
      sessionId: "session",
    });
    expect(client.getParameters).toHaveBeenCalledTimes(1);
    expect(client.subscribeConnectionGraph).toHaveBeenCalledTimes(1);
    reporter.setVisible(false);
    expect(client.unsubscribeConnectionGraph).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    expect(client.getParameters).toHaveBeenCalledTimes(1);
    expect(FakeClient.instances).toHaveLength(1);
  });

  it("waits for host visibility before opening an embedded player with no canvas", async () => {
    const previous = window.location.href;
    window.history.replaceState({}, "", "/?xgc2Embed=1");
    const player = new FoxgloveWebSocketPlayer({
      url: "ws://127.0.0.1:1",
      metricsCollector: { setProperty: jest.fn(), playerConstructed: jest.fn() },
      sourceId: "foxglove-websocket",
    });
    try {
      expect(FakeClient.instances).toHaveLength(0);
      for (let index = 0; index < 100; index++) {
        window.dispatchEvent(
          new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: false } }),
        );
      }
      await flush();
      expect(FakeClient.instances).toHaveLength(0);
      window.dispatchEvent(
        new CustomEvent(XGC2_HOST_VISIBILITY_EVENT, { detail: { visible: true } }),
      );
      expect(FakeClient.instances).toHaveLength(1);
    } finally {
      player.close();
      window.history.replaceState({}, "", previous);
      resetEmbeddedHostVisibilityForTests();
    }
  });

  it("cancels an already scheduled reconnect until the document is visible", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(1);
    setup();
    const first = FakeClient.instances[0]!;
    first.emit("close");
    expect(console.error).toHaveBeenCalledWith(
      "Player alert",
      "ws:connection-failed",
      expect.anything(),
    );
    (console.error as jest.Mock).mockClear();
    await flush();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(FakeClient.instances).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(FakeClient.instances).toHaveLength(2);
    connect(FakeClient.instances[1]!);
    await flush();
    expect(FakeClient.instances[1]!.subscribe).toHaveBeenCalledTimes(4);
  });

  it("keeps renderer history across an ordinary disconnect only until the current reconnect", async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(1);
    const { states } = setup();
    const first = FakeClient.instances[0]!;
    send(first, subscription(first, 14), [1]);
    await flush();
    const previous = states.at(-1)!.activeData!;
    first.emit("close");
    expect(console.error).toHaveBeenCalledWith(
      "Player alert",
      "ws:connection-failed",
      expect.anything(),
    );
    (console.error as jest.Mock).mockClear();
    await flush();
    expect(states.at(-1)!.presence).toBe(PlayerPresence.RECONNECTING);
    jest.advanceTimersByTime(250);
    const replacement = FakeClient.instances[1]!;
    connect(replacement);
    await flush();
    expect(states.at(-1)!.activeData!.lastSeekTime).toBeGreaterThan(previous.lastSeekTime);
    expect(states.at(-1)!.activeData!.messages).toEqual([]);
  });
});
