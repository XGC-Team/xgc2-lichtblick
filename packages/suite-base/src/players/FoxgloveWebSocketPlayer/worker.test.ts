// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import { ToWorkerMessage } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

class MockWebSocket {
  public static lastInstance: MockWebSocket | undefined;
  public binaryType = "";
  public protocol = "test-protocol";
  public onerror?: (event: unknown) => void;
  public onopen?: (event: unknown) => void;
  public onclose?: (event: unknown) => void;
  public onmessage?: (event: MessageEvent) => void;
  public close = jest.fn();
  public send = jest.fn();

  public constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    MockWebSocket.lastInstance = this;
    if (constructorShouldThrow) {
      throw constructorError;
    }
  }
}

let constructorShouldThrow = false;
let constructorError: unknown;
let postMessageMock: jest.Mock;
let onmessage: (event: MessageEvent<ToWorkerMessage>) => void;

function dispatch(data: ToWorkerMessage): void {
  onmessage({ data } as MessageEvent<ToWorkerMessage>);
}

function messageData(subscriptionId: number, payloadSize = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(13 + payloadSize);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryOpcode.MESSAGE_DATA);
  view.setUint32(1, subscriptionId, true);
  return buffer;
}

function timeData(): ArrayBuffer {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryOpcode.TIME);
  return buffer;
}

function serverAdvertise(channels: Array<{ id: number; topic: string }>): string {
  // JSON.stringify is typed string | undefined under TS 6; these objects always serialize.
  return JSON.stringify({
    op: "advertise",
    channels: channels.map((ch) => ({
      id: ch.id,
      topic: ch.topic,
      encoding: "cdr",
      schemaName: "test",
      schema: "",
    })),
  })!;
}

function clientSubscribe(subscriptions: Array<{ id: number; channelId: number }>): string {
  return JSON.stringify({ op: "subscribe", subscriptions })!;
}

/** Build channel/subscription maps the same way a live session would. */
function establishTopicMapping(
  entries: Array<{ subId: number; channelId: number; topic: string }>,
): void {
  dispatch({
    type: "data",
    data: clientSubscribe(entries.map((e) => ({ id: e.subId, channelId: e.channelId }))),
  });
  MockWebSocket.lastInstance?.onmessage?.({
    data: serverAdvertise(entries.map((e) => ({ id: e.channelId, topic: e.topic }))),
  } as MessageEvent);
  // Advertise is enqueued and immediately posted; ack so subsequent telemetry is not blocked.
  dispatch({ type: "ack" });
}

describe("FoxgloveWebSocketPlayer worker", () => {
  const wsUrl = BasicBuilder.string();
  beforeEach(async () => {
    jest.resetModules();

    MockWebSocket.lastInstance = undefined;
    constructorShouldThrow = false;
    constructorError = undefined;

    postMessageMock = jest.fn();
    (global as unknown as { self: unknown }).self = global;
    self.postMessage = postMessageMock;
    (global as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

    await import("./worker");
    onmessage = self.onmessage as unknown as (event: MessageEvent<ToWorkerMessage>) => void;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("open", () => {
    it("should create a WebSocket with the given url and protocols", () => {
      // Given
      const protocols = [BasicBuilder.string()];
      // When
      dispatch({ type: "open", data: { wsUrl, protocols } });
      // Then
      expect(MockWebSocket.lastInstance?.url).toBe(wsUrl);
      expect(MockWebSocket.lastInstance?.protocols).toEqual(protocols);
    });

    it("should set the binaryType to arraybuffer", () => {
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(MockWebSocket.lastInstance?.binaryType).toBe("arraybuffer");
    });

    it("should post an open message when the socket opens", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      // When
      MockWebSocket.lastInstance?.onopen?.(undefined);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "open",
        protocol: "test-protocol",
      });
    });

    it("should post an error message when the socket errors", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const error = new Error(BasicBuilder.string());
      // When
      MockWebSocket.lastInstance?.onerror?.({ error });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "error", error });
    });

    it("should post a close message when the socket closes", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const closeEvent = { code: 1000, reason: BasicBuilder.string() };
      // When
      MockWebSocket.lastInstance?.onclose?.(closeEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "close",
        data: closeEvent,
      });
    });

    it("should post a message and transfer the buffer for ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const buffer = new ArrayBuffer(8);
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data: buffer } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: buffer }, [buffer]);
    });

    it("should post a message without transfer for non-ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const data = BasicBuilder.string();
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data });
    });

    it("should wait for an acknowledgement before posting the next message", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const first = messageData(1);
      const second = messageData(2);

      // When
      MockWebSocket.lastInstance?.onmessage?.({ data: first } as MessageEvent);
      postMessageMock.mockClear();
      MockWebSocket.lastInstance?.onmessage?.({ data: second } as MessageEvent);

      // Then
      expect(postMessageMock).not.toHaveBeenCalled();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: second }, [second]);
    });

    it("should keep only the latest queued telemetry frame for each subscription", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      // Map sub 1/2 to ordinary (non-exempt) topics so supersede applies.
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/lidar/points" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const superseded = messageData(2);
      const latest = messageData(2);
      MockWebSocket.lastInstance?.onmessage?.({
        data: inFlight,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: superseded,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: latest } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(latest);
      expect(postMessageMock.mock.calls[0]?.[1]?.[0]).toBe(latest);
    });

    it("should evict old telemetry when the raw queue exceeds its memory limit", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/lidar/points" },
        { subId: 3, channelId: 30, topic: "/camera/depth" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const evicted = messageData(2, 9 * 1024 * 1024);
      const retained = messageData(3, 9 * 1024 * 1024);
      MockWebSocket.lastInstance?.onmessage?.({
        data: inFlight,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: evicted,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: retained,
      } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(retained);
      expect(postMessageMock.mock.calls[0]?.[1]?.[0]).toBe(retained);
    });

    it("should not supersede or trim-evict /tf and /tf_static frames under backpressure", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/tf" },
        { subId: 3, channelId: 30, topic: "/tf_static" },
        { subId: 4, channelId: 40, topic: "/lidar/points" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const tfA = messageData(2, 100);
      const tfB = messageData(2, 100);
      const tfStatic = messageData(3, 100);
      // Two large ordinary frames so queue exceeds 16MB; only non-exempt telemetry is trim-eligible.
      const bigCamera = messageData(1, 9 * 1024 * 1024);
      const bigLidar = messageData(4, 9 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfB } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfStatic } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: bigCamera } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: bigLidar } as MessageEvent);
      postMessageMock.mockClear();

      // When — drain the entire remaining queue
      const delivered: ArrayBuffer[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        for (const call of postMessageMock.mock.calls) {
          if (call[0]?.type === "message" && call[0].data instanceof ArrayBuffer) {
            delivered.push(call[0].data);
          }
        }
        postMessageMock.mockClear();
      }

      // Then — both /tf frames kept (no supersede); /tf_static kept (no trim eviction)
      expect(delivered).toContain(tfA);
      expect(delivered).toContain(tfB);
      expect(delivered).toContain(tfStatic);
    });

    it("should not supersede a fail-safe exempt frame after the topic later maps to a non-exempt topic", () => {
      // Given — hold the port busy so subsequent frames stay queued
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);

      // Frame arrives before any topic mapping (fail-safe lossExempt=true) and remains queued
      const earlyExempt = messageData(5, 100);
      MockWebSocket.lastInstance?.onmessage?.({ data: earlyExempt } as MessageEvent);

      // Establish subId 5 → ordinary topic without acking (must not drain earlyExempt)
      dispatch({
        type: "data",
        data: clientSubscribe([{ id: 5, channelId: 50 }]),
      });
      MockWebSocket.lastInstance?.onmessage?.({
        data: serverAdvertise([{ id: 50, topic: "/camera/image" }]),
      } as MessageEvent);

      // New frame for same subId is non-exempt; must not supersede the earlier exempt frame
      const laterNonExempt = messageData(5, 100);
      MockWebSocket.lastInstance?.onmessage?.({ data: laterNonExempt } as MessageEvent);
      postMessageMock.mockClear();

      // When — drain the queue
      const delivered: ArrayBuffer[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        for (const call of postMessageMock.mock.calls) {
          if (call[0]?.type === "message" && call[0].data instanceof ArrayBuffer) {
            delivered.push(call[0].data);
          }
        }
        postMessageMock.mockClear();
      }

      // Then — early fail-safe frame is not superseded; both frames are delivered
      expect(delivered).toContain(earlyExempt);
      expect(delivered).toContain(laterNonExempt);
    });

    it("should treat unmapped MESSAGE_DATA as loss-exempt (fail-safe)", () => {
      // Given — open socket but never advertise/subscribe, so topic map is empty
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      const unmappedA = messageData(99, 100);
      const unmappedB = messageData(99, 100);
      const big = messageData(2, 15 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: unmappedA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: unmappedB } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: big } as MessageEvent);
      postMessageMock.mockClear();

      // When
      const delivered: ArrayBuffer[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        for (const call of postMessageMock.mock.calls) {
          if (call[0]?.type === "message" && call[0].data instanceof ArrayBuffer) {
            delivered.push(call[0].data);
          }
        }
        postMessageMock.mockClear();
      }

      // Then — both unmapped frames retained (no supersede, not trimmed)
      expect(delivered).toContain(unmappedA);
      expect(delivered).toContain(unmappedB);
    });

    it("should keep only the latest unsent TIME frame", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      const timeOld = timeData();
      const timeNew = timeData();

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: timeOld } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: timeNew } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });
      const firstAfterAck = postMessageMock.mock.calls[0]?.[0].data;
      postMessageMock.mockClear();
      dispatch({ type: "ack" });
      const secondAfterAck = postMessageMock.mock.calls[0]?.[0].data;
      postMessageMock.mockClear();
      dispatch({ type: "ack" });

      // Then — only the latest TIME is delivered; no further messages
      expect(firstAfterAck).toBe(timeNew);
      expect(secondAfterAck).toBeUndefined();
      expect(postMessageMock).not.toHaveBeenCalled();
      expect(timeOld).not.toBe(timeNew);
    });

    it("should retain a single oversized telemetry frame when protocol messages remain in queue", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([{ subId: 1, channelId: 10, topic: "/camera/image" }]);
      postMessageMock.mockClear();

      const inFlight = messageData(2);
      const protocolMsg = JSON.stringify({ op: "status", level: 0, message: "ok" });
      // 17MB exceeds the 16MB queue limit; previously this was dropped whenever
      // messageQueue.length !== 1 (e.g. protocol string still queued).
      const oversized = messageData(1, 17 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: protocolMsg } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: oversized } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: protocolMsg });
      postMessageMock.mockClear();
      dispatch({ type: "ack" });

      // Then — oversized telemetry still delivered despite coexisting with protocol messages
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(oversized);
    });

    it("should post an error message when constructing the WebSocket throws", () => {
      // Given
      constructorShouldThrow = true;
      constructorError = new Error("Insecure WebSocket connection");
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "error",
        error: constructorError,
      });
    });
  });

  describe("close", () => {
    it("should close the active WebSocket", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const instance = MockWebSocket.lastInstance;
      // When
      dispatch({ type: "close", data: undefined });
      // Then
      expect(instance?.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("data", () => {
    it("should send data through the active WebSocket", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const instance = MockWebSocket.lastInstance;
      const data = BasicBuilder.string();
      // When
      dispatch({ type: "data", data });
      // Then
      expect(instance?.send).toHaveBeenCalledWith(data);
    });
  });
});
