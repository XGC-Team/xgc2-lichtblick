// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { FromWorkerMessage } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

import WorkerSocketAdapter from "./WorkerSocketAdapter";

describe("WorkerSocketAdapter", () => {
  let workerMock: {
    postMessage: jest.Mock;
    terminate: jest.Mock;
    onmessage?: (event: MessageEvent<FromWorkerMessage>) => void;
    onerror?: (event: unknown) => void;
  };
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
    } as MessageEvent<FromWorkerMessage>);

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
    } as MessageEvent<FromWorkerMessage>);

    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "open",
      data: { wsUrl, protocols: undefined },
    });
  });

  it("delivers complete large frames and ordered batches with one synchronous consumed ACK per batch", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    const onmessage = jest.fn();
    socket.onmessage = onmessage;
    workerMock.postMessage.mockClear();
    const messages = [
      new ArrayBuffer(17 * 1024 * 1024),
      new ArrayBuffer(32),
      "control",
      new ArrayBuffer(20 * 1024 * 1024),
    ];
    workerMock.onmessage?.({
      data: { type: "messages", id: 1, messages: messages.slice(0, 1) },
    } as MessageEvent<FromWorkerMessage>);
    workerMock.onmessage?.({
      data: { type: "messages", id: 2, messages: messages.slice(1, 3) },
    } as MessageEvent<FromWorkerMessage>);
    workerMock.onmessage?.({
      data: { type: "messages", id: 3, messages: messages.slice(3) },
    } as MessageEvent<FromWorkerMessage>);
    expect(onmessage.mock.calls.map((call) => call[0].data)).toEqual(messages);
    expect(workerMock.postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: "consumed", data: { id: 1, count: 1 } },
      { type: "consumed", data: { id: 2, count: 2 } },
      { type: "consumed", data: { id: 3, count: 1 } },
    ]);
  });

  it("confirms only the callbacks that returned when a consumer throws inside a batch", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    const failure = new Error("Consumer failed");
    socket.onmessage = jest.fn((event: unknown) => {
      if ((event as { data: string }).data === "second") {
        throw failure;
      }
    });
    workerMock.postMessage.mockClear();
    expect(() =>
      workerMock.onmessage?.({
        data: { type: "messages", id: 7, messages: ["first", "second", "third"] },
      } as MessageEvent<FromWorkerMessage>),
    ).toThrow(failure);
    expect(socket.onmessage).toHaveBeenCalledTimes(2);
    expect(workerMock.postMessage).toHaveBeenCalledWith({
      type: "consumed",
      data: { id: 7, count: 1 },
    });
  });

  it("sends the ACK after synchronous consumption without waiting for rendering", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    const order: string[] = [];
    socket.onmessage = (event) => {
      order.push((event as { data: string }).data);
    };
    workerMock.postMessage.mockImplementation(() => order.push("consumed"));
    workerMock.onmessage?.({
      data: { type: "messages", id: 4, messages: ["first", "second"] },
    } as MessageEvent<FromWorkerMessage>);
    expect(order).toEqual(["first", "second", "consumed"]);
  });

  it("stops a batch when its consumer closes and ignores late delivery during the close handshake", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onmessage = jest.fn(() => {
      socket.close();
    });
    workerMock.postMessage.mockClear();
    workerMock.onmessage?.({
      data: { type: "messages", id: 1, messages: ["first", "second"] },
    } as MessageEvent<FromWorkerMessage>);
    workerMock.onmessage?.({
      data: { type: "messages", id: 2, messages: ["late"] },
    } as MessageEvent<FromWorkerMessage>);
    expect(socket.onmessage).toHaveBeenCalledTimes(1);
    expect(workerMock.postMessage.mock.calls.map((call) => call[0])).toEqual([
      { type: "close", data: undefined },
    ]);
    expect(() => {
      socket.send("late outbound");
    }).toThrow("Can't send message over closed websocket connection");
  });

  it("closes through the original worker and rejects outbound data after close", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onclose = jest.fn();
    workerMock.postMessage.mockClear();
    socket.close();
    expect(workerMock.postMessage).toHaveBeenCalledWith({ type: "close", data: undefined });
    workerMock.onmessage?.({
      data: { type: "close", data: { code: 1000 } },
    } as MessageEvent<FromWorkerMessage>);
    expect(workerMock.terminate).toHaveBeenCalled();
    expect(socket.onclose).toHaveBeenCalledTimes(1);
    expect(() => {
      socket.send("late");
    }).toThrow("Can't send message over closed websocket connection");
  });

  it("terminates a failed worker and reports one close so the player can reconnect", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onerror = jest.fn();
    socket.onclose = jest.fn();
    workerMock.onerror?.(new Error("worker failed"));
    workerMock.onmessage?.({
      data: { type: "close", data: { code: 1006 } },
    } as MessageEvent<FromWorkerMessage>);
    expect(socket.onerror).toHaveBeenCalledTimes(1);
    expect(socket.onclose).toHaveBeenCalledTimes(1);
    expect(workerMock.terminate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      {
        data: { type: "open", protocol: BasicBuilder.string() },
      } as MessageEvent<FromWorkerMessage>,
    ],
    [
      {
        data: { type: "messages", id: 1, messages: [BasicBuilder.string()] },
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
