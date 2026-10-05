/** @jest-environment jsdom */
import type { NativeCloudConsumer } from "../nativeCloudPreparation";
import type { CloudPrepRequest, CloudPrepResponse } from "./cloudPrepWorker";
import type { LayerSettingsPointClouds } from "../../panels/ThreeDeeRender/renderables/PointClouds";
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
    "parked",
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
        ...(mode === "parked" ? { samplingParked: true as const } : {}),
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
      if (mode === "parked") {
        expect(deserialize).not.toHaveBeenCalled();
        expect(messages).toEqual([]);
        const subscribeCount = client.subscribe.mock.calls.length;
        player.setSubscriptions([{ ...subscription, samplingParked: undefined }]);
        await flush();
        expect(client.subscribe).toHaveBeenCalledTimes(subscribeCount);
        expect(client.unsubscribe).not.toHaveBeenCalled();
        expect(deserialize).toHaveBeenCalledTimes(1);
        expect(deserialize).toHaveBeenCalledWith(clear);
        expect(
          states
            .flatMap((state) => state.activeData?.messages ?? [])
            .map((message) => message.message),
        ).toEqual([{ points: [] }]);
      } else if (mode === "unsubscribe") {
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

describe("native cloud preparation ownership", () => {
  it("commits one native prep job without the render barrier and fences revision, parking and retirement", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const client = {
      on: jest.fn((name: string, fn: (payload: unknown) => void) => handlers.set(name, fn)),
      subscribe: jest.fn(() => 1),
      unsubscribe: jest.fn(),
      close: jest.fn(),
    };
    jest.mocked(FoxgloveClient).mockImplementation(() => client as unknown as FoxgloveClient);
    const deserialize = jest.fn((data: ArrayBufferView) => ({
      points: Array.from(new Uint8Array(data.buffer)),
    }));
    jest
      .mocked(parseChannel)
      .mockReturnValue({ datatypes: new Map(), deserialize } as ReturnType<typeof parseChannel>);
    const socket = jest.spyOn(window, "WebSocket").mockImplementation(() => ({}) as WebSocket);
    const player = new FoxgloveWebSocketPlayer({
      url: "ws://fixture",
      sourceId: "fixture",
      metricsCollector: {
        playerConstructed: jest.fn(),
      } as unknown as PlayerMetricsCollectorInterface,
    });
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const jobs: CloudPrepRequest[] = [];
    const worker = {
      onmessage: undefined as undefined | ((event: { data: CloudPrepResponse }) => void),
      onerror: undefined,
      postMessage: jest.fn((job: CloudPrepRequest) => jobs.push(job)),
      terminate: jest.fn(),
    };
    const createWorker = jest.fn(() => worker);
    Object.defineProperty(globalThis, "Worker", {
      value: createWorker,
      configurable: true,
      writable: true,
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const states: PlayerState[] = [];
    let blocked = false,
      latest: import("@lichtblick/suite").MessageEvent | undefined;
    const commit = jest.fn((event: import("@lichtblick/suite").MessageEvent) => {
      latest = event;
      return { cpuArrays: [], gpuCapacityBytes: 0, growOverlapBytes: 0 };
    });
    const consumer: NativeCloudConsumer = {
      kind: "pointcloud",
      key: {},
      identity: {},
      revision: "color0",
      inputKey: "same-input",
      parked: false,
      settings: {} as LayerSettingsPointClouds,
      capacity: () => 0,
      canReuseCoordinates: () => false,
      setEnabled: jest.fn(),
      invalidCloud: jest.fn(),
      usage: () => ({ cpuArrays: [], gpuCapacityBytes: 0, growOverlapBytes: 0 }),
      isActive: () => true,
      latest: () => latest,
      commit,
    };
    const subscribe = (value: NativeCloudConsumer) =>
      player.setSubscriptions([
        {
          topic: "/cloud",
          preloadType: "partial",
          samplingRequest: { mode: "latest-per-render-tick" },
          samplingAuthorized: true,
          samplingParked: value.parked ? true : undefined,
          nativeCloudConsumers: [value],
          nativeCloudPreparationAllowed: true,
        } as InternalSubscribePayload,
      ]);
    const finish = (job: CloudPrepRequest, value: number | undefined) => {
      const event = job.event ?? {
        topic: "/cloud",
        schemaName: "foxglove.PointCloud",
        receiveTime: job.receiveTime,
        sizeInBytes: value == undefined ? 0 : 1,
        message: { points: value == undefined ? [] : [value] },
      };
      worker.onmessage!({
        data: {
          id: job.id,
          event,
          prepared: {
            pointCloud: { data: new Uint8Array(0) } as never,
            pointCount: 0,
            coordinatesPrepared: true,
            positions: new Float32Array(0),
            colors: new Uint8Array(0),
            stixelPositions: new Float32Array(0),
            stixelColors: new Uint8Array(0),
            bounds: undefined,
            problems: [],
            settings: consumer.settings,
          },
        },
      });
    };
    try {
      player.setListener(async (state) => {
        states.push(state);
        if (state.activeData != undefined && !blocked) {
          blocked = true;
          await barrier;
        }
      });
      handlers.get("open")!(undefined);
      subscribe(consumer);
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
      handlers.get("message")!({
        subscriptionId: 1,
        data: new DataView(new Uint8Array([1]).buffer),
      });
      expect(jobs).toHaveLength(1);
      expect(createWorker).toHaveBeenCalledTimes(1);
      handlers.get("message")!({
        subscriptionId: 1,
        data: new DataView(new Uint8Array([2]).buffer),
      });
      handlers.get("message")!({ subscriptionId: 1, data: new DataView(new ArrayBuffer(0)) });
      expect(jobs).toHaveLength(1);
      expect(deserialize).not.toHaveBeenCalled();
      subscribe({ ...consumer, parked: true });
      finish(jobs[0]!, 1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0]![0].message).toEqual({ points: [1] });
      expect(jobs).toHaveLength(1); // Legitimate in-flight CPU commit is allowed; hidden starts nothing new.
      subscribe(consumer);
      expect(jobs).toHaveLength(2);
      expect(jobs[1]!.raw!.byteLength).toBe(0);
      finish(jobs[1]!, undefined);
      expect(commit).toHaveBeenCalledTimes(2);
      subscribe({ ...consumer, revision: "color1" });
      expect(jobs).toHaveLength(3);
      expect(jobs[2]!.raw).toBeUndefined();
      expect(jobs[2]!.event).toBe(latest); // Same immutable current sample, not raw re-enqueue.
      subscribe({ ...consumer, revision: "color2" });
      finish(jobs[2]!, undefined);
      expect(commit).toHaveBeenCalledTimes(2);
      expect(jobs).toHaveLength(4);
      finish(jobs[3]!, undefined);
      expect(commit).toHaveBeenCalledTimes(3);
      subscribe({ ...consumer, revision: "color3" });
      expect(jobs).toHaveLength(5);
      player.setSubscriptions([]);
      finish(jobs[4]!, undefined);
      expect(commit).toHaveBeenCalledTimes(3);
      expect(client.subscribe).toHaveBeenCalledTimes(1);
      expect(client.unsubscribe).toHaveBeenCalledTimes(1);
      release();
      await flush();
      expect(states.flatMap((state) => state.activeData?.messages ?? [])).toEqual([]);
    } finally {
      release();
      player.close();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      socket.mockRestore();
      if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
      else Reflect.deleteProperty(globalThis, "Worker");
    }
  });
});
