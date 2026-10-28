// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment node */

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import {
  BinaryOpcode,
  FetchAssetStatus,
  FoxgloveServer,
  type FetchAsset,
  type IWebSocket,
  type ServiceCallRequest,
} from "@foxglove/ws-protocol";
import { buildSync } from "esbuild";
import { createRequire } from "module";
import path from "path";
import { Worker as Thread } from "worker_threads";
import { WebSocket, WebSocketServer, type AddressInfo } from "ws";

import { registerEmbeddedCanvasVisibility } from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import type { PlayerState } from "@lichtblick/suite-base/players/types";

import FoxgloveWebSocketPlayer from "./index";
import type { FromWorkerMessage } from "./types";

const mockMeasurements = { parses: 0 };
jest.mock("@lichtblick/mcap-support", () => {
  const actual = jest.requireActual("@lichtblick/mcap-support");
  return {
    ...actual,
    parseChannel: (...args: unknown[]) => {
      const parsed = actual.parseChannel(...args);
      return {
        ...parsed,
        deserialize: (data: ArrayBufferView) => {
          mockMeasurements.parses++;
          return parsed.deserialize(data);
        },
      };
    },
  };
});

type Counters = {
  workers: number;
  terminated: number;
  deliveries: number;
  deliveredBytes: number;
  wireBytes: number;
  connections: number;
};
let counters: Counters;
let workerSource: string;

class RealWorker {
  public onmessage?: (event: { data: FromWorkerMessage }) => void;
  public onerror?: (error: Error) => void;
  #thread: Thread;
  public constructor() {
    counters.workers++;
    this.#thread = new Thread(workerSource, { eval: true });
    this.#thread.on("message", (data: FromWorkerMessage) => {
      if (data.type === "messages") {
        counters.deliveries++;
        counters.deliveredBytes += data.messages.reduce(
          (total, message) =>
            total + (typeof message === "string" ? Buffer.byteLength(message) : message.byteLength),
          0,
        );
      }
      this.onmessage?.({ data });
    });
    this.#thread.on("error", (error) => this.onerror?.(error));
  }
  public postMessage(message: unknown): void {
    this.#thread.postMessage(message);
  }
  public terminate(): void {
    counters.terminated++;
    void this.#thread.terminate();
  }
}

class VisibilityDocument extends EventTarget {
  public visibilityState: "hidden" | "visible" = "visible";
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `${message}: ${JSON.stringify(counters)}; errors=${JSON.stringify((console.error as jest.Mock).mock.calls)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("real Foxglove server and worker view lifetime", () => {
  let wss: WebSocketServer;
  let server: FoxgloveServer;
  let document: VisibilityDocument;
  let player: FoxgloveWebSocketPlayer;
  let reporter: ReturnType<typeof registerEmbeddedCanvasVisibility>;
  let states: PlayerState[];
  let ids: number[];
  let active: Set<number>;
  const oldWorker = globalThis.Worker;
  const oldDocument = globalThis.document;

  beforeAll(() => {
    const source = buildSync({
      entryPoints: [path.join(__dirname, "worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    }).outputFiles[0]!.text;
    const wsPath = path.join(
      path.dirname(
        createRequire(path.resolve(__dirname, "../../../package.json")).resolve("ws/package.json"),
      ),
      "index.js",
    );
    workerSource = `const { parentPort } = require('worker_threads');\nglobal.WebSocket = require(${JSON.stringify(wsPath)});\nglobal.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };\n${source}\nparentPort.on('message', data => self.onmessage({ data }));`;
  });
  beforeEach(async () => {
    counters = {
      workers: 0,
      terminated: 0,
      deliveries: 0,
      deliveredBytes: 0,
      wireBytes: 0,
      connections: 0,
    };
    mockMeasurements.parses = 0;
    globalThis.Worker = RealWorker as unknown as typeof Worker;
    document = new VisibilityDocument();
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    server = new FoxgloveServer({
      name: "fixture",
      sessionId: "fixture-session",
      capabilities: ["services", "assets"],
      supportedEncodings: ["json"],
    });
    active = new Set();
    server.on("subscribe", (id) => active.add(id));
    server.on("unsubscribe", (id) => active.delete(id));
    server.on("error", (error) => {
      throw error;
    });
    ids = [
      ["/cloud", "sensor_msgs/PointCloud2"],
      ["/tf", "tf2_msgs/TFMessage"],
      ["/scene", "foxglove.SceneUpdate"],
      ["/markers", "visualization_msgs/MarkerArray"],
    ].map(([topic, schemaName]) =>
      server.addChannel({
        topic: topic!,
        schemaName: schemaName!,
        encoding: "json",
        schemaEncoding: "jsonschema",
        schema: '{"type":"object"}',
      }),
    );
    wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: server.handleProtocols.bind(server),
    });
    wss.on("connection", (socket: WebSocket) => {
      counters.connections++;
      const original = socket.send.bind(socket);
      socket.send = ((data: string | ArrayBufferView) => {
        counters.wireBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        original(data);
      }) as typeof socket.send;
      server.handleConnection(socket, "fixture");
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    reporter = registerEmbeddedCanvasVisibility("real-server-canvas");
    player = new FoxgloveWebSocketPlayer({
      url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      metricsCollector: { setProperty: jest.fn(), playerConstructed: jest.fn() },
      sourceId: "foxglove-websocket",
    });
    states = [];
    player.setListener(async (state) => {
      states.push(state);
    });
    player.setSubscriptions([
      { topic: "/cloud" },
      { topic: "/tf" },
      { topic: "/scene" },
      { topic: "/markers" },
    ]);
    await until(() => active.size === 4, "initial subscriptions did not reach the server");
  });
  afterEach(async () => {
    player.close();
    reporter.dispose();
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        resolve();
      });
    });
    globalThis.Worker = oldWorker;
    Object.defineProperty(globalThis, "document", { configurable: true, value: oldDocument });
    (console.warn as jest.Mock).mockClear();
    (console.error as jest.Mock).mockClear();
  });

  function publish(index: number, value: unknown): void {
    server.sendMessage(
      ids[index]!,
      BigInt(Date.now()) * 1_000_000n,
      new TextEncoder().encode(JSON.stringify(value)),
    );
  }

  async function beginService() {
    let request: ServiceCallRequest | undefined;
    let connection: IWebSocket | undefined;
    server.on("serviceCallRequest", (next, client) => {
      request = next;
      connection = client;
    });
    const schema = {
      encoding: "json",
      schemaEncoding: "jsonschema",
      schema: '{"type":"object"}',
      schemaName: "Command",
    };
    server.addService({ name: "/command", type: "Command", request: schema, response: schema });
    const deliveries = counters.deliveries;
    await until(() => counters.deliveries > deliveries, "service advertisement was not delivered");
    const result = player.callService("/command", { run: true });
    await until(() => request != undefined, "service operation was not accepted by the server");
    return { request: request!, connection: connection!, result };
  }

  function completeService(request: ServiceCallRequest, connection: IWebSocket): void {
    const payload = new TextEncoder().encode('{"ok":true}');
    server.sendServiceCallResponse(
      { serviceId: request.serviceId, callId: request.callId, encoding: "json", data: payload },
      connection,
    );
  }

  it("sends no bytes, worker deliveries, parses, or renders while the route is parked, then rebuilds once", async () => {
    publish(0, { sequence: 1, data: "x".repeat(256_000) });
    publish(1, { transforms: [{ child_frame_id: "old" }] });
    await until(() => mockMeasurements.parses >= 2, "visible messages were not parsed");
    await until(
      () => states.some((state) => (state.activeData?.messages.length ?? 0) > 0),
      "visible messages were not rendered",
    );
    const priorSeek = states.at(-1)!.activeData!.lastSeekTime;
    reporter.setVisible(false);
    await until(
      () => active.size === 0 && wss.clients.size === 0,
      "park did not release the server connection",
    );
    const before = {
      counters: { ...counters },
      parses: mockMeasurements.parses,
      renders: states.length,
    };
    for (let index = 0; index < 100; index++) {
      reporter.setVisible(false);
      publish(0, { sequence: index, data: "x".repeat(16_000) });
      publish(1, { transforms: [{ child_frame_id: `hidden-${index}` }] });
      publish(2, { deletions: [{ type: 1 }], entities: [] });
      publish(3, { markers: [{ action: 3 }] });
    }
    await pause(100);
    expect(counters).toEqual(before.counters);
    expect(mockMeasurements.parses).toBe(before.parses);
    expect(states).toHaveLength(before.renders);
    expect(counters.workers).toBe(1);
    reporter.setVisible(true);
    await until(
      () => active.size === 4 && counters.connections === 2,
      "reveal did not reconcile subscriptions",
    );
    expect(counters.workers).toBe(2);
    expect(states.at(-1)!.activeData!.lastSeekTime).toBeGreaterThan(priorSeek);
    const beforeCurrent = mockMeasurements.parses;
    publish(1, { transforms: [{ child_frame_id: "current-a" }, { child_frame_id: "current-b" }] });
    publish(3, { markers: [{ action: 0, id: 9 }] });
    await until(
      () => mockMeasurements.parses === beforeCurrent + 2,
      "current TF and marker updates were not parsed",
    );
    await until(
      () =>
        states.some(
          (state) =>
            state.activeData?.messages.some((message) => message.topic === "/markers") ?? false,
        ),
      "current marker was not delivered",
    );
    const tf = states
      .flatMap((state) => state.activeData?.messages ?? [])
      .filter((message) => message.topic === "/tf");
    expect(tf.at(-1)?.message).toEqual({
      transforms: [{ child_frame_id: "current-a" }, { child_frame_id: "current-b" }],
    });
    expect(counters.connections).toBe(2);
  });

  it("releases a document-hidden connection and cannot reconnect until visible", async () => {
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await until(
      () => active.size === 0 && wss.clients.size === 0,
      "document hide did not close the server connection",
    );
    const before = {
      counters: { ...counters },
      parses: mockMeasurements.parses,
      renders: states.length,
    };
    for (let index = 0; index < 100; index++) {
      document.dispatchEvent(new Event("visibilitychange"));
      publish(0, { sequence: index });
    }
    await pause(350);
    expect(counters).toEqual(before.counters);
    expect(mockMeasurements.parses).toBe(before.parses);
    expect(states).toHaveLength(before.renders);
    document.visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await until(
      () => active.size === 4 && counters.connections === 2,
      "document reveal did not reconnect once",
    );
    expect(counters.workers).toBe(2);
  });

  it("cancels a real disconnect retry while hidden and reconnects once after reveal", async () => {
    jest.spyOn(Math, "random").mockReturnValue(1);
    [...wss.clients][0]!.terminate();
    await until(
      () => (console.error as jest.Mock).mock.calls.length > 0,
      "disconnect was not observed",
    );
    reporter.setVisible(false);
    await until(
      () => active.size === 0 && wss.clients.size === 0,
      "disconnected subscriptions remained",
    );
    const before = { ...counters };
    await pause(400);
    expect(counters).toEqual(before);
    expect(counters.workers).toBe(1);
    reporter.setVisible(true);
    await until(
      () => active.size === 4 && counters.connections === 2,
      "reconnect after reveal failed",
    );
    expect(counters.workers).toBe(2);
  });

  it("lets an accepted service finish while releasing all view topics, then closes the socket", async () => {
    const { request, connection, result } = await beginService();
    reporter.setVisible(false);
    await until(() => active.size === 0, "view subscriptions were not released");
    expect(wss.clients.size).toBe(1);
    const before = {
      wireBytes: counters.wireBytes,
      parses: mockMeasurements.parses,
      renders: states.length,
    };
    for (let index = 0; index < 100; index++) {
      publish(0, { sequence: index });
    }
    await pause(100);
    expect(counters.wireBytes).toBe(before.wireBytes);
    expect(mockMeasurements.parses).toBe(before.parses);
    expect(states).toHaveLength(before.renders);
    completeService(request, connection);
    await expect(result).resolves.toEqual({ ok: true });
    await until(() => wss.clients.size === 0, "completed service kept the parked socket open");
    expect(counters.workers).toBe(1);
  });

  it("reconciles each selected topic once when revealed before an accepted service finishes", async () => {
    const { request, connection, result } = await beginService();
    const resubscribed: number[] = [];
    server.on("subscribe", (id) => resubscribed.push(id));
    reporter.setVisible(false);
    await until(() => active.size === 0, "parked subscriptions were not released");
    server.removeChannel(ids[0]!);
    ids[0] = server.addChannel({
      topic: "/cloud",
      schemaName: "sensor_msgs/PointCloud2",
      encoding: "json",
      schemaEncoding: "jsonschema",
      schema: '{"type":"object"}',
    });
    reporter.setVisible(true);
    await until(() => active.size === 4, "selected subscriptions were not restored");
    expect(resubscribed.sort()).toEqual([...ids].sort());
    expect(counters.connections).toBe(2);
    expect(counters.workers).toBe(2);
    completeService(request, connection);
    await expect(result).resolves.toEqual({ ok: true });
    await until(() => wss.clients.size === 1, "completed service retained its old connection");
  });

  it("keeps an accepted operation independent when the revealed view reconnects", async () => {
    jest.spyOn(Math, "random").mockReturnValue(1);
    const { request, connection, result } = await beginService();
    const operationSocket = [...wss.clients][0]!;
    reporter.setVisible(false);
    await until(() => active.size === 0, "parked subscriptions were not released");
    reporter.setVisible(true);
    await until(
      () => counters.connections === 2 && active.size === 4,
      "new view was not connected",
    );
    const viewSocket = [...wss.clients].find((socket) => socket !== operationSocket)!;
    viewSocket.terminate();
    await until(() => counters.connections === 3 && active.size === 4, "view did not reconnect");
    completeService(request, connection);
    await expect(result).resolves.toEqual({ ok: true });
    await until(() => wss.clients.size === 1, "operation socket did not close after completion");
    expect(active.size).toBe(4);
  });

  it("does not retry a failed operation socket while the view remains hidden", async () => {
    const { result } = await beginService();
    reporter.setVisible(false);
    await until(() => active.size === 0, "parked subscriptions were not released");
    [...wss.clients][0]!.terminate();
    await expect(result).rejects.toThrow("WebSocket connection closed before the service response");
    const before = { ...counters };
    await pause(350);
    expect(counters).toEqual(before);
    expect(counters.workers).toBe(1);
  });

  it("cancels a parked view asset and ignores its late response while an operation remains owned", async () => {
    const { request, connection, result } = await beginService();
    const assets: { request: FetchAsset; connection: IWebSocket }[] = [];
    server.on("fetchAsset", (next, client) => {
      assets.push({ request: next, connection: client });
    });
    const old = player.fetchAsset("package://robot/model.glb");
    await until(() => assets.length === 1, "asset request was not received");
    reporter.setVisible(false);
    await expect(old).rejects.toThrow("View parked");
    await expect(player.fetchAsset("package://robot/hidden.glb")).rejects.toThrow("view is parked");
    server.sendFetchAssetResponse(
      {
        op: BinaryOpcode.FETCH_ASSET_RESPONSE,
        requestId: assets[0]!.request.requestId,
        status: FetchAssetStatus.SUCCESS,
        data: new Uint8Array([1]),
      },
      assets[0]!.connection,
    );
    const renders = states.length;
    await pause(50);
    expect(states).toHaveLength(renders);
    reporter.setVisible(true);
    await until(
      () => active.size === 4 && counters.connections === 2,
      "current view did not reconnect",
    );
    const current = player.fetchAsset("package://robot/model.glb");
    await until(() => assets.length === 2, "current asset request was not received");
    server.sendFetchAssetResponse(
      {
        op: BinaryOpcode.FETCH_ASSET_RESPONSE,
        requestId: assets[1]!.request.requestId,
        status: FetchAssetStatus.SUCCESS,
        data: new Uint8Array([9]),
      },
      assets[1]!.connection,
    );
    await expect(current).resolves.toMatchObject({
      uri: "package://robot/model.glb",
      data: new Uint8Array([9]),
    });
    completeService(request, connection);
    await expect(result).resolves.toEqual({ ok: true });
  });
});
