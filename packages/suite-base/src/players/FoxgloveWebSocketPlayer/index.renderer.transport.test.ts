/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { FoxgloveServer } from "@foxglove/ws-protocol";
import type * as Esbuild from "esbuild";
import { createRequire } from "module";
import path from "path";
import { TextEncoder as NodeTextEncoder } from "util";
import { Worker as Thread } from "worker_threads";
import type * as WsModule from "ws";

import { registerEmbeddedCanvasVisibility } from "@lichtblick/suite-base/components/EmbeddedParkedSignal";
import { Renderer } from "@lichtblick/suite-base/panels/ThreeDeeRender/Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "@lichtblick/suite-base/panels/ThreeDeeRender/SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "@lichtblick/suite-base/panels/ThreeDeeRender/camera";
import { DEFAULT_PUBLISH_SETTINGS } from "@lichtblick/suite-base/panels/ThreeDeeRender/renderables/PublishSettings";

import FoxgloveWebSocketPlayer from "./index";
import type { FromWorkerMessage } from "./types";

const wsPath = path.join(
  path.dirname(
    createRequire(path.resolve(__dirname, "../../../package.json")).resolve("ws/package.json"),
  ),
  "index.js",
);
const { WebSocketServer } = jest.requireActual<typeof WsModule>(wsPath);

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");
jest.mock("@lichtblick/suite-base/panels/ThreeDeeRender/Picker", () => ({
  Picker: jest.fn().mockImplementation(() => ({ dispose: jest.fn(), pick: jest.fn(() => -1) })),
}));
jest.mock("three", () => ({
  ...jest.requireActual("three"),
  WebGLRenderer: jest.fn().mockImplementation(() => ({
    capabilities: { isWebGL2: true },
    setPixelRatio: jest.fn(),
    getPixelRatio: () => 1,
    setSize: jest.fn(),
    getDrawingBufferSize: () => ({ width: 100, height: 100 }),
    render: jest.fn(),
    clear: jest.fn(),
    clearDepth: jest.fn(),
    setClearColor: jest.fn(),
    info: { reset: jest.fn() },
    shadowMap: {},
    dispose: jest.fn(),
  })),
}));

let workerSource = "";
let workerDeliveries = 0;
class RealWorker {
  public onmessage?: (event: { data: FromWorkerMessage }) => void;
  public onerror?: (error: Error) => void;
  #thread = new Thread(workerSource, { eval: true });
  public constructor() {
    this.#thread.on("message", (data: FromWorkerMessage) => {
      let delivered = data;
      if (data.type === "messages") {
        workerDeliveries++;
        // Worker threads deliver Node-realm buffers; browser postMessage gives
        // the receiving document's realm an ArrayBuffer.
        delivered = {
          ...data,
          messages: data.messages.map((message) =>
            typeof message === "string" ? message : Uint8Array.from(new Uint8Array(message)).buffer,
          ),
        };
      }
      this.onmessage?.({ data: delivered });
    });
    this.#thread.on("error", (error) => this.onerror?.(error));
  }
  public postMessage(value: unknown): void {
    this.#thread.postMessage(value);
  }
  public terminate(): void {
    void this.#thread.terminate();
  }
}

async function until(predicate: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(
        `${failure}; deliveries=${workerDeliveries}; errors=${JSON.stringify((console.error as jest.Mock).mock.calls)}; warnings=${JSON.stringify((console.warn as jest.Mock).mock.calls)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("real server to renderer parking", () => {
  const originalEncoder = globalThis.TextEncoder;
  const originalWorker = globalThis.Worker;
  beforeAll(() => {
    class RealmTextEncoder extends NodeTextEncoder {
      public override encode(input?: string): Uint8Array {
        return Uint8Array.from(super.encode(input));
      }
    }
    globalThis.TextEncoder = RealmTextEncoder as typeof TextEncoder;
    const { buildSync } = jest.requireActual<typeof Esbuild>("esbuild");
    const source = buildSync({
      entryPoints: [path.join(__dirname, "worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      write: false,
    }).outputFiles[0]!.text;
    workerSource = `const { parentPort } = require('worker_threads');\nglobal.WebSocket = require(${JSON.stringify(wsPath)});\nglobal.self = { postMessage: (message, transfer) => parentPort.postMessage(message, transfer) };\n${source}\nparentPort.on('message', data => self.onmessage({ data }));`;
  });
  afterAll(() => {
    globalThis.TextEncoder = originalEncoder;
    globalThis.Worker = originalWorker;
  });

  it("sends no hidden frames or schedules and paints one current observation after reveal", async () => {
    globalThis.Worker = RealWorker as unknown as typeof Worker;
    workerDeliveries = 0;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn(() => ({ addEventListener: jest.fn(), removeEventListener: jest.fn() })),
    });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextFrame;
      frames.set(id, (time) => {
        frames.delete(id);
        callback(time);
      });
      return id;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const parent = document.createElement("div");
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    Object.defineProperties(parent, { clientWidth: { value: 100 }, clientHeight: { value: 100 } });
    const renderer = new Renderer({
      canvas,
      config: {
        cameraState: DEFAULT_CAMERA_STATE,
        followMode: "follow-pose",
        followTf: undefined,
        scene: {},
        transforms: {},
        topics: {},
        layers: {},
        publish: DEFAULT_PUBLISH_SETTINGS,
        imageMode: {},
      },
      interfaceMode: "3d",
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      customCameraModels: new Map(),
      fetchAsset: async () => {
        throw new Error("No asset expected");
      },
      testOptions: {},
    });
    const paint = jest.spyOn(renderer.gl, "render");
    renderer.animationFrame();
    paint.mockClear();
    raf.mockClear();
    const server = new FoxgloveServer({ name: "render-fixture", sessionId: "render-session" });
    let subscribers = 0,
      wireBytes = 0;
    server.on("subscribe", () => {
      subscribers++;
    });
    server.on("unsubscribe", () => {
      subscribers--;
    });
    server.on("error", (error) => {
      throw error;
    });
    const id = server.addChannel({
      topic: "/cloud",
      schemaName: "sensor_msgs/PointCloud2",
      encoding: "json",
      schemaEncoding: "jsonschema",
      schema: '{"type":"object"}',
    });
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: server.handleProtocols.bind(server),
    });
    wss.on("connection", (socket) => {
      const send = socket.send.bind(socket);
      socket.send = ((data: string | ArrayBufferView) => {
        wireBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        send(data);
      }) as typeof socket.send;
      server.handleConnection(socket, "renderer");
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const reporter = registerEmbeddedCanvasVisibility("render-server-canvas");
    const player = new FoxgloveWebSocketPlayer({
      url: `ws://127.0.0.1:${(wss.address() as WsModule.AddressInfo).port}`,
      metricsCollector: { setProperty: jest.fn(), playerConstructed: jest.fn() },
      sourceId: "foxglove-websocket",
    });
    let received = 0;
    player.setListener(async (state) => {
      for (const message of state.activeData?.messages ?? []) {
        received++;
        renderer.addMessageEvent(message);
        renderer.queueThrottledAnimationFrame();
      }
    });
    player.setSubscriptions([{ topic: "/cloud" }]);
    const publish = (sequence: number) => {
      server.sendMessage(
        id,
        BigInt(Date.now()) * 1_000_000n,
        new TextEncoder().encode(JSON.stringify({ sequence })),
      );
    };
    try {
      await until(() => subscribers === 1, "visible subscription missing");
      publish(1);
      await until(() => received === 1 && frames.size > 0, "visible frame was not scheduled");
      for (let index = 0; index < 10 && paint.mock.calls.length === 0 && frames.size > 0; index++) {
        [...frames.values()][0]!(0);
      }
      expect(paint).toHaveBeenCalled();
      renderer.setCanvasVisibility("hidden");
      reporter.setVisible(false);
      await until(
        () => subscribers === 0 && wss.clients.size === 0,
        "hidden view did not release the source",
      );
      const before = {
        wireBytes,
        workerDeliveries,
        received,
        scheduled: raf.mock.calls.length,
        painted: paint.mock.calls.length,
        pending: frames.size,
      };
      for (let index = 0; index < 100; index++) {
        renderer.setCanvasVisibility("hidden");
        reporter.setVisible(false);
        publish(index);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect({
        wireBytes,
        workerDeliveries,
        received,
        scheduled: raf.mock.calls.length,
        painted: paint.mock.calls.length,
        pending: frames.size,
      }).toEqual(before);
      renderer.setCanvasVisibility("visible");
      reporter.setVisible(true);
      await until(() => subscribers === 1, "reveal subscription missing");
      publish(2);
      await until(() => received === 2, "current frame missing after reveal");
      expect(frames.size).toBe(1);
      for (
        let index = 0;
        index < 10 && paint.mock.calls.length === before.painted && frames.size > 0;
        index++
      ) {
        [...frames.values()][0]!(1);
      }
      expect(paint.mock.calls.length).toBe(before.painted + 1);
    } finally {
      player.close();
      reporter.dispose();
      renderer.dispose();
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      (console.warn as jest.Mock).mockClear();
      (console.error as jest.Mock).mockClear();
    }
  });
});
