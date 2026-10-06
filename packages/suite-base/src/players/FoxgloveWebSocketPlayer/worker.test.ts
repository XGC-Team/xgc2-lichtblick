// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import { ToWorkerMessage } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

import { CURRENT_FRAME_MAXIMUM_SIZE_BYTES } from "./constants";

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

    it("should post an error message when constructing the WebSocket throws", () => {
      // Given
      constructorShouldThrow = true;
      constructorError = new Error("Insecure WebSocket connection");
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "error", error: constructorError });
    });
  });

  describe("continuous upstream delivery", () => {
    it("delivers a cloud over 16 MiB followed by TF and Marker updates without an ACK", () => {
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
      expect(postMessageMock).toHaveBeenCalledTimes(frames.length);
      frames.forEach((buffer, index) => {
        expect(postMessageMock).toHaveBeenNthCalledWith(
          index + 1,
          { type: "message", data: buffer },
          [buffer],
        );
      });
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
      expect(postMessageMock.mock.calls.map((call) => call[0])).toEqual(
        frames.map((data) => ({ type: "message", data })),
      );
    });

    it("transfers an asset larger than the old raw cap in full before subsequent telemetry", () => {
      dispatch({ type: "open", data: { wsUrl } });
      const asset = new ArrayBuffer(20 * 1024 * 1024);
      new DataView(asset).setUint8(0, BinaryOpcode.FETCH_ASSET_RESPONSE);
      const telemetry = new ArrayBuffer(13);
      MockWebSocket.lastInstance?.onmessage?.({ data: asset } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: telemetry } as MessageEvent);
      expect(postMessageMock).toHaveBeenNthCalledWith(1, { type: "message", data: asset }, [asset]);
      expect(postMessageMock).toHaveBeenNthCalledWith(2, { type: "message", data: telemetry }, [
        telemetry,
      ]);
      expect(asset.byteLength).toEqual(20 * 1024 * 1024);
    });

    it("retains the finite upstream 400 MiB parsed frame cap", () => {
      expect(CURRENT_FRAME_MAXIMUM_SIZE_BYTES).toEqual(400 * 1024 * 1024);
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
