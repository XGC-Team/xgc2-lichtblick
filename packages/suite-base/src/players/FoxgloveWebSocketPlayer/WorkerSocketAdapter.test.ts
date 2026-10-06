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

  it("delivers consecutive messages across topics without sending ACKs", () => {
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
    messages.forEach((data) => workerMock.onmessage?.({ data: { type: "message", data } }));
    expect(onmessage.mock.calls.map((call) => call[0].data)).toEqual(messages);
    expect(workerMock.postMessage).not.toHaveBeenCalled();
  });

  it("closes through the original worker and rejects outbound data after close", () => {
    const socket = new WorkerSocketAdapter(wsUrl);
    socket.onclose = jest.fn();
    workerMock.postMessage.mockClear();
    socket.close();
    expect(workerMock.postMessage).toHaveBeenCalledWith({ type: "close", data: undefined });
    workerMock.onmessage?.({ data: { type: "close", data: { code: 1000 } } });
    expect(workerMock.terminate).toHaveBeenCalled();
    expect(socket.onclose).toHaveBeenCalledTimes(1);
    expect(() => {
      socket.send("late");
    }).toThrow("Can't send message over closed websocket connection");
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
