// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import {
  FromWorkerMessage,
  ToWorkerMessage,
} from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

import {
  CURRENT_FRAME_MAXIMUM_SIZE_BYTES,
  WORKER_BATCH_MAXIMUM_MESSAGES,
  WORKER_BATCH_TARGET_SIZE_BYTES,
  WORKER_BUFFER_MAXIMUM_MESSAGES,
} from "./constants";

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

function batches(): Array<Extract<FromWorkerMessage, { type: "messages" }>> {
  return postMessageMock.mock.calls
    .map((call) => call[0] as FromWorkerMessage)
    .filter(
      (message): message is Extract<FromWorkerMessage, { type: "messages" }> =>
        message.type === "messages",
    );
}

function consumeAll(): void {
  let count = 0;
  while (count < batches().length) {
    const batch = batches()[count++]!;
    dispatch({ type: "consumed", data: { id: batch.id, count: batch.messages.length } });
  }
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
      expect(postMessageMock).toHaveBeenCalledWith({ type: "close", data: closeEvent });
    });

    it("should post a message and transfer the buffer for ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const buffer = new ArrayBuffer(8);
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data: buffer } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith(
        { type: "messages", id: 1, messages: [buffer] },
        [buffer],
      );
    });

    it("should post a message without transfer for non-ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const data = BasicBuilder.string();
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith(
        { type: "messages", id: 1, messages: [data] },
        [],
      );
    });

    it("should post an error message when constructing the WebSocket throws", () => {
      // Given
      constructorShouldThrow = true;
      constructorError = new Error("Insecure WebSocket connection");
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "error", error: constructorError });
      expect(postMessageMock).toHaveBeenCalledWith({ type: "close", data: { code: 1006 } });
    });
  });

  describe("bounded ordered upstream delivery", () => {
    it("keeps a cloud over 16 MiB whole and waits for consumption before sending queued TF and Marker updates", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const frames = [
        new ArrayBuffer(17 * 1024 * 1024),
        new ArrayBuffer(32),
        new ArrayBuffer(48),
        new ArrayBuffer(48),
      ];
      frames.forEach((buffer, index) => {
        const view = new DataView(buffer);
        view.setUint8(0, BinaryOpcode.MESSAGE_DATA);
        view.setUint32(1, index < 2 ? index + 1 : 3, true);
        MockWebSocket.lastInstance?.onmessage?.({ data: buffer } as MessageEvent);
      });
      expect(batches()).toEqual([{ type: "messages", id: 1, messages: [frames[0]] }]);
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(batches()[1]).toEqual({ type: "messages", id: 2, messages: frames.slice(1) });
      expect(postMessageMock).toHaveBeenLastCalledWith(batches()[1], frames.slice(1));
      expect(frames[0]!.byteLength).toBe(17 * 1024 * 1024);
    });

    it("preserves interleaved protocol control, time and repeated same-topic messages", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const advertise = JSON.stringify({ op: "advertise", channels: [] });
      const time = new ArrayBuffer(9);
      new DataView(time).setUint8(0, BinaryOpcode.TIME);
      const markerAdd = new ArrayBuffer(32);
      const markerDelete = new ArrayBuffer(32);
      const unadvertise = JSON.stringify({ op: "unadvertise", channelIds: [] });
      const frames = [advertise, markerAdd, time, markerDelete, unadvertise];
      frames.forEach((data) => MockWebSocket.lastInstance?.onmessage?.({ data } as MessageEvent));
      expect(batches()).toHaveLength(1);
      consumeAll();
      expect(batches().flatMap((batch) => batch.messages)).toEqual(frames);
    });

    it("transfers an asset larger than the old raw cap in full before subsequent telemetry", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const asset = new ArrayBuffer(20 * 1024 * 1024);
      new DataView(asset).setUint8(0, BinaryOpcode.FETCH_ASSET_RESPONSE);
      const telemetry = new ArrayBuffer(13);
      MockWebSocket.lastInstance?.onmessage?.({ data: asset } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: telemetry } as MessageEvent);
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock).toHaveBeenCalledWith({ type: "messages", id: 1, messages: [asset] }, [
        asset,
      ]);
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(postMessageMock).toHaveBeenLastCalledWith(
        { type: "messages", id: 2, messages: [telemetry] },
        [telemetry],
      );
      expect(asset.byteLength).toEqual(20 * 1024 * 1024);
    });

    it("retains the finite upstream 400 MiB parsed frame cap", () => {
      expect(CURRENT_FRAME_MAXIMUM_SIZE_BYTES).toEqual(400 * 1024 * 1024);
    });

    it("batches pending work within the frame-count and byte targets without waiting to fill a first frame", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const socket = MockWebSocket.lastInstance!;
      socket.onmessage?.({ data: "first" } as MessageEvent);
      expect(batches()).toHaveLength(1);
      const tiny = Array.from(
        { length: WORKER_BATCH_MAXIMUM_MESSAGES + 1 },
        () => new ArrayBuffer(0),
      );
      tiny.forEach((data) => socket.onmessage?.({ data } as MessageEvent));
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(batches()[1]!.messages).toHaveLength(WORKER_BATCH_MAXIMUM_MESSAGES);
      consumeAll();
      expect(batches().flatMap((batch) => batch.messages)).toEqual(["first", ...tiny]);

      const before = batches().length;
      socket.onmessage?.({ data: "next" } as MessageEvent);
      const queued = Array.from({ length: 65 }, () => new ArrayBuffer(1024));
      queued.forEach((data) => socket.onmessage?.({ data } as MessageEvent));
      const first = batches()[before]!;
      dispatch({ type: "consumed", data: { id: first.id, count: first.messages.length } });
      const batch = batches()[before + 1]!;
      expect(batch.messages).toHaveLength(WORKER_BATCH_TARGET_SIZE_BYTES / 1024);
      expect(batch.messages.reduce((sum, data) => sum + (data as ArrayBuffer).byteLength, 0)).toBe(
        WORKER_BATCH_TARGET_SIZE_BYTES,
      );
    });

    it("keeps video dependencies and a queued large asset ordered and unsplit", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const frames = [
        "advertise",
        new ArrayBuffer(9),
        new ArrayBuffer(32),
        new ArrayBuffer(32),
        new ArrayBuffer(20 * 1024 * 1024),
        new ArrayBuffer(32),
        "unadvertise",
      ];
      frames.forEach((data) => MockWebSocket.lastInstance!.onmessage?.({ data } as MessageEvent));
      consumeAll();
      expect(batches().flatMap((batch) => batch.messages)).toEqual(frames);
      expect(batches().find((batch) => batch.messages.includes(frames[4]!))?.messages).toEqual([
        frames[4],
      ]);
    });

    it("ignores stale ACKs and explicitly closes after a short consumed prefix", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const socket = MockWebSocket.lastInstance!;
      ["first", "second", "third"].forEach((data) => socket.onmessage?.({ data } as MessageEvent));
      dispatch({ type: "consumed", data: { id: 99, count: 1 } });
      expect(batches()).toHaveLength(1);
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(batches()[1]!.messages).toEqual(["second", "third"]);
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      socket.onmessage?.({ data: "pending" } as MessageEvent);
      dispatch({ type: "consumed", data: { id: 2, count: 1 } });
      expect(socket.close).toHaveBeenCalledWith(4009, expect.stringContaining("complete batch"));
      expect(postMessageMock).toHaveBeenLastCalledWith({
        type: "close",
        data: { code: 4009, reason: expect.stringContaining("complete batch") },
      });
      dispatch({ type: "consumed", data: { id: 2, count: 2 } });
      socket.onmessage?.({ data: "late" } as MessageEvent);
      socket.onclose?.({ code: 4009 });
      expect(batches()).toHaveLength(2);
      expect(postMessageMock.mock.calls.filter((call) => call[0].type === "close")).toHaveLength(1);
    });

    it("bounds in-flight plus queued payload bytes and fails the connection instead of dropping an incremental suffix", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const socket = MockWebSocket.lastInstance!;
      const data = new ArrayBuffer(20 * 1024 * 1024);
      const capacity = CURRENT_FRAME_MAXIMUM_SIZE_BYTES / data.byteLength;
      for (let index = 0; index < capacity; index++) {
        socket.onmessage?.({ data } as MessageEvent);
      }
      expect(batches()).toHaveLength(1);
      expect(socket.close).not.toHaveBeenCalled();
      socket.onmessage?.({ data } as MessageEvent);
      expect(socket.close).toHaveBeenCalledWith(4009, expect.stringContaining("capacity"));
      expect(postMessageMock).toHaveBeenLastCalledWith({
        type: "close",
        data: { code: 4009, reason: expect.stringContaining("capacity") },
      });
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(batches()).toHaveLength(1);
    });

    it("independently bounds tiny-message work and starts a fresh connection without accepting old ACKs", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const previous = MockWebSocket.lastInstance!;
      for (let index = 0; index < WORKER_BUFFER_MAXIMUM_MESSAGES; index++) {
        previous.onmessage?.({ data: "" } as MessageEvent);
      }
      expect(previous.close).not.toHaveBeenCalled();
      previous.onmessage?.({ data: "" } as MessageEvent);
      expect(previous.close).toHaveBeenCalledWith(4009, expect.stringContaining("capacity"));
      dispatch({ type: "open", data: { wsUrl } });
      const current = MockWebSocket.lastInstance!;
      current.onmessage?.({ data: "new" } as MessageEvent);
      current.onmessage?.({ data: "next" } as MessageEvent);
      previous.onmessage?.({ data: "old" } as MessageEvent);
      previous.onclose?.({ code: 1000 });
      dispatch({ type: "consumed", data: { id: 1, count: 1 } });
      expect(batches()).toHaveLength(2);
      dispatch({ type: "consumed", data: { id: 2, count: 1 } });
      expect(batches()[2]!.messages).toEqual(["next"]);
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
