// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { FromWorkerMessage } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

import WorkerSocketAdapter from "./WorkerSocketAdapter";

describe("WorkerSocketAdapter", () => {
  let workerMock: any;
  const wsUrl = "wss://example.com";

  beforeEach(() => {
    workerMock = {
      postMessage: jest.fn(),
      terminate: jest.fn(),
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    };

    global.Worker = jest.fn(() => workerMock as unknown as Worker);

    new WorkerSocketAdapter(wsUrl);
  });

  it("WorkerSocketAdapter should close a WebSocket connection", () => {
    workerMock.onmessage?.({
      data: { type: "close", data: {} },
    } as MessageEvent);

    expect(workerMock.terminate).toHaveBeenCalled();
  });

  it("WorkerSocketAdapter should send a message", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    const message = BasicBuilder.string();

    socket.send(message);

    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "data",
      data: message,
    });
  });

  it("WorkerSocketAdapter should handle an error", () => {
    workerMock.onmessage?.({
      data: { type: "error", error: "Something went wrong" },
    } as MessageEvent);

    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "open",
      data: { wsUrl, protocols: undefined },
    });
  });

  it("WorkerSocketAdapter should acknowledge a processed message", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onmessage = jest.fn();
    workerMock.postMessage.mockClear();

    workerMock.onmessage?.({
      data: { type: "message", data: BasicBuilder.string() },
    });

    expect(socket.onmessage).toHaveBeenCalledTimes(1);
    expect(workerMock.postMessage).toHaveBeenCalledWith({ type: "ack" });
  });

  describe("batched messages", () => {
    function deliverBatch(data: unknown[]): void {
      workerMock.onmessage?.({ data: { type: "messages", data } });
    }

    it("hands over each message in order as the single message it used to be", () => {
      const socket = new WorkerSocketAdapter(wsUrl);
      const received: unknown[] = [];
      socket.onmessage = jest.fn((event) => received.push(event));
      workerMock.postMessage.mockClear();
      const batch = [BasicBuilder.string(), new ArrayBuffer(8), BasicBuilder.string()];

      deliverBatch(batch);

      expect(received).toEqual(batch.map((data) => ({ type: "message", data })));
    });

    it("acknowledges the batch once, after its last message", () => {
      const socket = new WorkerSocketAdapter(wsUrl);
      const events: string[] = [];
      socket.onmessage = jest.fn(() => events.push("message"));
      workerMock.postMessage.mockClear();
      workerMock.postMessage.mockImplementation(() => events.push("ack"));

      deliverBatch(["a", "b", "c"]);

      expect(events).toEqual(["message", "message", "message", "ack"]);
      expect(workerMock.postMessage).toHaveBeenCalledTimes(1);
      expect(workerMock.postMessage).toHaveBeenCalledWith({ type: "ack" });
    });

    it("delivers the rest of the batch and still acknowledges once when a listener throws", () => {
      const socket = new WorkerSocketAdapter(wsUrl);
      const received: unknown[] = [];
      const failure = new Error(BasicBuilder.string());
      socket.onmessage = jest.fn((event: unknown) => {
        const { data } = event as { data: unknown };
        received.push(data);
        if (data === "b") {
          throw failure;
        }
      });
      workerMock.postMessage.mockClear();

      expect(() => {
        deliverBatch(["a", "b", "c"]);
      }).toThrow(failure);

      expect(received).toEqual(["a", "b", "c"]);
      expect(workerMock.postMessage).toHaveBeenCalledTimes(1);
      expect(workerMock.postMessage).toHaveBeenCalledWith({ type: "ack" });
    });
  });

  it("WorkerSocketAdapter should not acknowledge a directly transferred asset response", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onmessage = jest.fn();
    workerMock.postMessage.mockClear();

    workerMock.onmessage?.({
      data: {
        type: "message",
        data: new ArrayBuffer(32),
        requiresAck: false,
      },
    });

    expect(socket.onmessage).toHaveBeenCalledTimes(1);
    expect(workerMock.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        data: { type: "open", protocol: BasicBuilder.string() },
      } as MessageEvent<FromWorkerMessage>,
    ],
    [
      {
        data: { type: "message", data: BasicBuilder.string() },
      } as MessageEvent<FromWorkerMessage>,
    ],
    [
      {
        data: { type: "close", data: undefined },
      } as MessageEvent<FromWorkerMessage>,
    ],
  ])("WorkerSocketAdapter should handle '%s' event", (event) => {
    workerMock.onmessage?.(event);
    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "open",
      data: { wsUrl, protocols: undefined },
    });
  });
});
