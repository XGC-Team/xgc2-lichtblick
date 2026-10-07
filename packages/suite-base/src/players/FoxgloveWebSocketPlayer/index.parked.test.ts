/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { EventEmitter } from "events";

import {
  registerEmbeddedCanvasVisibility,
  type EmbeddedCanvasVisibilityReporter,
} from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import type { MessageEvent, PlayerState } from "@lichtblick/suite-base/players/types";

import FoxgloveWebSocketPlayer from "./index";

// A shared spy stands in for every channel's deserializer. Parked assertions
// check it is never called while hidden and exactly once per retained message
// on resume. Implementations are (re)installed in beforeEach because the repo
// jest config restores mocks between tests.
const mockDeserialize = jest.fn((data: ArrayBufferView) => ({
  bytes: Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
}));

jest.mock("@foxglove/ws-protocol", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeFoxgloveClient extends Emitter {
    public static SUPPORTED_SUBPROTOCOL = "foxglove.websocket.v1";
    public static instances: FakeFoxgloveClient[] = [];
    public nextSubscriptionId = 100;
    public subscribe = jest.fn((channelId: number) => {
      void channelId;
      return this.nextSubscriptionId++;
    });
    public unsubscribe = jest.fn((subscriptionId: number) => {
      void subscriptionId;
    });
    public close = jest.fn();
    public constructor(args: unknown) {
      super();
      void args;
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

jest.mock("@lichtblick/mcap-support", () => {
  const actual = jest.requireActual("@lichtblick/mcap-support");
  return {
    ...actual,
    parseChannel: jest.fn(),
  };
});

type FakeClientInstance = EventEmitter & {
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  close: jest.Mock;
};

const FakeClient: { instances: FakeClientInstance[] } = jest.requireMock("@foxglove/ws-protocol")
  .FoxgloveClient;

const parseChannelMock: jest.Mock = jest.requireMock("@lichtblick/mcap-support").parseChannel;

const CLOUD_CHANNEL = 11;
const TF_CHANNEL = 12;
const SCENE_CHANNEL = 13;
const MARKERS_CHANNEL = 14;

class StubWebSocket {
  public close(): void {}
}

type Harness = {
  player: FoxgloveWebSocketPlayer;
  client: FakeClientInstance;
  states: PlayerState[];
  subIdByChannel: Map<number, number>;
  reporter: EmbeddedCanvasVisibilityReporter;
};

function collectMessages(states: PlayerState[]): MessageEvent[] {
  return states.flatMap((state) => state.activeData?.messages ?? []);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("FoxgloveWebSocketPlayer parked parse pause", () => {
  let harnesses: Harness[] = [];

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
    const client = FakeClient.instances[FakeClient.instances.length - 1]!;
    client.emit("open");
    client.emit("serverInfo", { capabilities: [], name: "fake", sessionId: "session" });
    client.emit("advertise", [
      {
        id: CLOUD_CHANNEL,
        topic: "/cloud",
        encoding: "json",
        schemaName: "sensor_msgs/PointCloud2",
        schema: "{}",
        schemaEncoding: "jsonschema",
      },
      {
        id: TF_CHANNEL,
        topic: "/tf",
        encoding: "json",
        schemaName: "tf2_msgs/TFMessage",
        schema: "{}",
        schemaEncoding: "jsonschema",
      },
      {
        id: SCENE_CHANNEL,
        topic: "/scene",
        encoding: "json",
        schemaName: "foxglove.SceneUpdate",
        schema: "{}",
        schemaEncoding: "jsonschema",
      },
      {
        id: MARKERS_CHANNEL,
        topic: "/markers",
        encoding: "json",
        schemaName: "visualization_msgs/MarkerArray",
        schema: "{}",
        schemaEncoding: "jsonschema",
      },
    ]);
    const states: PlayerState[] = [];
    player.setListener(async (state) => {
      states.push(state);
    });
    player.setSubscriptions([
      { topic: "/cloud" },
      { topic: "/tf" },
      { topic: "/scene" },
      { topic: "/markers" },
    ]);
    const subIdByChannel = new Map<number, number>();
    client.subscribe.mock.calls.forEach((call: unknown[], index: number) => {
      subIdByChannel.set(call[0] as number, client.subscribe.mock.results[index]!.value as number);
    });
    const harness = { player, client, states, subIdByChannel, reporter };
    harnesses.push(harness);
    return harness;
  }

  function send(client: FakeClientInstance, subId: number, bytes: number[] | Uint8Array): void {
    client.emit("message", {
      subscriptionId: subId,
      data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    });
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
  });

  afterEach(() => {
    for (const harness of harnesses) {
      harness.player.close();
      harness.reporter.dispose();
    }
    // Several messages on one topic land inside a near-zero time window here,
    // which incidentally trips the high-frequency-topic alert logging.
    (console.warn as jest.Mock).mockClear();
  });

  it("visible hot path: messages are parsed eagerly, the gate changes nothing", async () => {
    const { client, states, subIdByChannel } = setup();
    states.length = 0;
    mockDeserialize.mockClear();

    send(client, subIdByChannel.get(TF_CHANNEL)!, [1, 2, 3]);
    // Synchronous parse on arrival: no deferral is added while visible.
    expect(mockDeserialize).toHaveBeenCalledTimes(1);
    send(client, subIdByChannel.get(CLOUD_CHANNEL)!, [4, 5]);
    expect(mockDeserialize).toHaveBeenCalledTimes(2);
    await flush();

    const messages = collectMessages(states);
    expect(messages.map((message) => [message.topic, message.message])).toEqual([
      ["/tf", { bytes: [1, 2, 3] }],
      ["/cloud", { bytes: [4, 5] }],
    ]);
  });

  it("parked: retains one latest message per topic unparsed; resume applies exactly the latest", async () => {
    const { client, states, subIdByChannel, reporter } = setup();
    states.length = 0;
    mockDeserialize.mockClear();

    reporter.setVisible(false);
    send(client, subIdByChannel.get(CLOUD_CHANNEL)!, [1]);
    send(client, subIdByChannel.get(TF_CHANNEL)!, [10]);
    send(client, subIdByChannel.get(CLOUD_CHANNEL)!, [2]);
    send(client, subIdByChannel.get(TF_CHANNEL)!, [11]);
    send(client, subIdByChannel.get(CLOUD_CHANNEL)!, [3]);

    // Zero parses and zero pipeline wakes while parked: no deserialization, no
    // scene application downstream.
    expect(mockDeserialize).not.toHaveBeenCalled();
    expect(states).toHaveLength(0);

    reporter.setVisible(true);
    await flush();

    // Each retained entry is parsed exactly once; TF resolves current from
    // the latest aggregated message only.
    expect(mockDeserialize).toHaveBeenCalledTimes(2);
    const parsedPayloads = mockDeserialize.mock.calls.map((call) =>
      Array.from(call[0] as Uint8Array),
    );
    expect(parsedPayloads).toEqual([[11], [3]]);

    const byTopic = new Map<string, MessageEvent[]>();
    for (const message of collectMessages(states)) {
      byTopic.set(message.topic, [...(byTopic.get(message.topic) ?? []), message]);
    }
    expect(byTopic.get("/cloud")?.map((message) => message.message)).toEqual([{ bytes: [3] }]);
    expect(byTopic.get("/tf")?.map((message) => message.message)).toEqual([{ bytes: [11] }]);
  });

  it("parked: deletion-semantic channels are unsubscribed; resume clears layers before resubscribing", async () => {
    const { client, states, subIdByChannel, reporter } = setup();
    const sceneSubId = subIdByChannel.get(SCENE_CHANNEL)!;
    const markersSubId = subIdByChannel.get(MARKERS_CHANNEL)!;
    const cloudSubId = subIdByChannel.get(CLOUD_CHANNEL)!;
    const tfSubId = subIdByChannel.get(TF_CHANNEL)!;
    mockDeserialize.mockClear();

    // Visible: entities including one that will be deleted while parked.
    send(client, sceneSubId, [7, 7]);
    await flush();
    states.length = 0;

    reporter.setVisible(false);
    expect(client.unsubscribe.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual(
      [sceneSubId, markersSubId].sort(),
    );
    expect(client.unsubscribe.mock.calls).not.toContainEqual([cloudSubId]);
    expect(client.unsubscribe.mock.calls).not.toContainEqual([tfSubId]);

    // A deletion happens server-side while parked; nothing is delivered. An
    // in-flight message on the canceled subscription is dropped silently.
    const stateCount = states.length;
    send(client, sceneSubId, [9, 9, 9]);
    expect(states).toHaveLength(stateCount);
    await flush();
    expect(states).toHaveLength(stateCount);
    expect(collectMessages(states)).toHaveLength(0);

    const subscribeCallsBeforeResume = client.subscribe.mock.calls.length;
    reporter.setVisible(true);
    await flush();

    // Resubscribed both paused channels with fresh subscription ids.
    const resumeCalls = client.subscribe.mock.calls.slice(
      subscribeCallsBeforeResume,
    ) as unknown[][];
    expect(resumeCalls.map((call) => call[0]).sort()).toEqual(
      [SCENE_CHANNEL, MARKERS_CHANNEL].sort(),
    );
    const resumedSceneSubId = client.subscribe.mock.results[subscribeCallsBeforeResume]!
      .value as number;

    // The producer's next full publish repopulates without the deleted entity.
    send(client, resumedSceneSubId, [8]);
    await flush();

    const sceneMessages = collectMessages(states).filter((message) => message.topic === "/scene");
    const markersMessages = collectMessages(states).filter(
      (message) => message.topic === "/markers",
    );
    // Clear-ALL lands first, so a missed deletion cannot survive as a ghost;
    // only then does fresh truth arrive.
    expect(sceneMessages.map((message) => message.message)).toEqual([
      { deletions: [{ type: 1 }], entities: [] },
      { bytes: [8] },
    ]);
    expect(markersMessages.map((message) => message.message)).toEqual([
      { markers: [{ action: 3, ns: "", id: 0 }] },
    ]);
  });

  it("a player constructed while already parked never subscribes deletion-semantic channels", async () => {
    const { client, states, reporter } = setup({ startParked: true });
    expect(client.subscribe.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual(
      [CLOUD_CHANNEL, TF_CHANNEL].sort(),
    );

    reporter.setVisible(true);
    await flush();

    expect(client.subscribe.mock.calls.map((call: unknown[]) => call[0]).sort()).toEqual(
      [CLOUD_CHANNEL, TF_CHANNEL, SCENE_CHANNEL, MARKERS_CHANNEL].sort(),
    );
    const clearedTopics = collectMessages(states)
      .filter((message) => message.sizeInBytes === 0)
      .map((message) => message.topic);
    expect(clearedTopics.sort()).toEqual(["/markers", "/scene"]);
  });

  it("bounds parked memory at the 32MB cap regardless of park duration", async () => {
    const { client, states, subIdByChannel, reporter } = setup();
    states.length = 0;

    reporter.setVisible(false);
    // Individually larger than PARKED_FRAME_MAXIMUM_SIZE_BYTES: rejected
    // without disturbing the other retained latest-per-topic entries.
    send(client, subIdByChannel.get(CLOUD_CHANNEL)!, new Uint8Array(40 * 1024 * 1024));
    send(client, subIdByChannel.get(TF_CHANNEL)!, [42]);

    reporter.setVisible(true);
    await flush();

    const messages = collectMessages(states);
    expect(messages.some((message) => message.topic === "/cloud")).toBe(false);
    expect(
      messages.filter((message) => message.topic === "/tf").map((message) => message.message),
    ).toEqual([{ bytes: [42] }]);
  });
});
