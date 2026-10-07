/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { MessageEvent } from "@lichtblick/suite";

import { RendererSubscription, RendererConfig } from "./IRenderer";
import { Renderer } from "./Renderer";
import { DEFAULT_SCENE_EXTENSION_CONFIG } from "./SceneExtensionConfig";
import { DEFAULT_CAMERA_STATE } from "./camera";
import { DEFAULT_PUBLISH_SETTINGS } from "./renderables/PublishSettings";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

jest.mock("./Picker", () => ({
  Picker: jest.fn().mockImplementation(() => ({ dispose: jest.fn(), pick: jest.fn(() => -1) })),
}));

// The drain tests below construct a full Renderer (the TF handlers and the
// transform pool are not reachable from a bare prototype), so WebGL is mocked
// here exactly as in Renderer.test.ts. The queue-ingestion tests above keep
// using Object.create(Renderer.prototype) and never touch WebGL.
jest.mock("three", () => ({
  ...jest.requireActual("three"),
  WebGLRenderer: jest.fn().mockImplementation(() => ({
    capabilities: { isWebGL2: true },
    setPixelRatio: jest.fn(),
    getPixelRatio: jest.fn(() => 1),
    setSize: jest.fn(),
    getDrawingBufferSize: () => ({ width: 100, height: 100 }),
    render: jest.fn(),
    clear: jest.fn(),
    clearDepth: jest.fn(),
    setClearColor: jest.fn(),
    readRenderTargetPixels: jest.fn(),
    info: { reset: jest.fn() },
    shadowMap: {},
    dispose: jest.fn(),
  })),
}));

function subscription(): RendererSubscription {
  return { handler: () => {}, shouldSubscribe: () => true };
}

function message(index: number, topic = "/pose", schemaName = "pose"): MessageEvent {
  return {
    topic,
    schemaName,
    receiveTime: { sec: 1, nsec: index },
    message: {
      header: { frame_id: "world", stamp: { sec: 1, nsec: index } },
      pose: {
        position: { x: index, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    },
    sizeInBytes: 0,
  };
}

function queueOnlyRenderer(): { renderer: Renderer; addCoordinateFrame: jest.Mock } {
  // Exercise the real queue methods without constructing a WebGL context.
  // These methods only use these public maps and addCoordinateFrame.
  const renderer = Object.create(Renderer.prototype) as Renderer;
  renderer.topicSubscriptions = new Map();
  renderer.schemaSubscriptions = new Map();
  const addCoordinateFrame = jest.fn();
  renderer.addCoordinateFrame = addCoordinateFrame;
  return { renderer, addCoordinateFrame };
}

describe("Renderer batch ingestion", () => {
  it("preserves interleaved schema aliases sharing a subscription", () => {
    const { renderer } = queueOnlyRenderer();
    const sub = subscription();
    renderer.schemaSubscriptions.set("pose", [sub]);
    renderer.schemaSubscriptions.set("pose_alias", [sub]);
    const events = [message(0), message(1, "/pose", "pose_alias"), message(2)];
    renderer.addMessageEventBatch(events);
    expect(sub.queue).toEqual(events);
  });

  it("preserves interleaved topics sharing a subscription", () => {
    const { renderer } = queueOnlyRenderer();
    const sub = subscription();
    renderer.topicSubscriptions.set("/pose", [sub]);
    renderer.topicSubscriptions.set("/other", [sub]);
    const events = [message(0), message(1, "/other"), message(2)];
    renderer.addMessageEventBatch(events);
    expect(sub.queue).toEqual(events);
  });

  it("queues a large backfill without argument spreading or sample loss", () => {
    const { renderer } = queueOnlyRenderer();
    const sub = subscription();
    renderer.topicSubscriptions.set("/pose", [sub]);
    const events = Array.from({ length: 200_000 }, (_, index) => message(index));
    renderer.addMessageEventBatch(events);
    expect(sub.queue).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) {
      if (sub.queue?.[i] !== events[i]) {
        throw new Error(`Missing, reordered, or copied sample at ${i}`);
      }
    }
  });

  it("retains message identity, timestamps, orientations, and frame extraction", () => {
    const { renderer, addCoordinateFrame } = queueOnlyRenderer();
    const topicSub = subscription();
    const schemaSub = subscription();
    renderer.topicSubscriptions.set("/pose", [topicSub]);
    renderer.schemaSubscriptions.set("pose", [schemaSub]);
    const event = message(123);
    const original = JSON.stringify(event);
    renderer.addMessageEventBatch([event]);
    expect(topicSub.queue?.[0]).toBe(event);
    expect(schemaSub.queue?.[0]).toBe(event);
    expect(JSON.stringify(event)).toBe(original);
    expect(addCoordinateFrame).toHaveBeenCalledWith("world");
  });

  it("appends to an existing queue and leaves it intact for an empty batch", () => {
    const { renderer } = queueOnlyRenderer();
    const sub = subscription();
    const first = message(0);
    const next = message(1);
    const queue = [first];
    sub.queue = queue;
    renderer.topicSubscriptions.set("/pose", [sub]);
    renderer.addMessageEventBatch([]);
    expect(sub.queue).toBe(queue);
    renderer.addMessageEventBatch([next]);
    expect(sub.queue).toEqual([first, next]);
  });

  it("has the same delivery multiplicity and order as single-message ingestion", () => {
    const { renderer: batch } = queueOnlyRenderer();
    const { renderer: single } = queueOnlyRenderer();
    const batchSub = subscription();
    const singleSub = subscription();
    for (const [renderer, sub] of [
      [batch, batchSub],
      [single, singleSub],
    ] as const) {
      renderer.topicSubscriptions.set("/pose", [sub]);
      renderer.topicSubscriptions.set("/other", [sub]);
      renderer.schemaSubscriptions.set("pose", [sub]);
    }
    const events = [message(0), message(1, "/other"), message(2)];
    batch.addMessageEventBatch(events);
    for (const event of events) {
      single.addMessageEvent(event);
    }
    expect(batchSub.queue).toEqual(singleSub.queue);
    expect(batchSub.queue).toHaveLength(2 * events.length);
  });
});

const drainRendererConfig: RendererConfig = {
  cameraState: DEFAULT_CAMERA_STATE,
  followMode: "follow-pose",
  followTf: undefined,
  scene: {},
  transforms: {},
  topics: {},
  layers: {},
  publish: DEFAULT_PUBLISH_SETTINGS,
  imageMode: {},
};

function tfEvent(
  transforms: { parent: string; child: string; stamp: { sec: number; nsec: number } }[],
  receiveTime: { sec: number; nsec: number } = { sec: 1, nsec: 0 },
): MessageEvent {
  return {
    topic: "/tf",
    schemaName: "tf2_msgs/TFMessage",
    receiveTime,
    message: {
      transforms: transforms.map(({ parent, child, stamp }) => ({
        header: { stamp, frame_id: parent },
        child_frame_id: child,
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      })),
    },
    sizeInBytes: 0,
  };
}

function transformTreeUpdatedCount(emitSpy: jest.SpyInstance): number {
  return emitSpy.mock.calls.filter(([name]) => name === "transformTreeUpdated").length;
}

describe("Renderer TF application batching", () => {
  let renderer: Renderer;

  beforeEach(() => {
    // Renderer watches the device pixel ratio at construction
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: jest.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    const parent = document.createElement("div");
    const canvas = document.createElement("canvas");
    parent.appendChild(canvas);
    renderer = new Renderer({
      canvas,
      config: drainRendererConfig,
      interfaceMode: "3d",
      sceneExtensionConfig: DEFAULT_SCENE_EXTENSION_CONFIG,
      customCameraModels: new Map(),
      fetchAsset: async () => {
        throw new Error("No assets expected in batch tests");
      },
      testOptions: {},
    });
  });

  afterEach(() => {
    renderer.dispose();
    // The constructor's first frame logs "No coordinate frames found" for the
    // empty tree; the drains under test assert their own emits explicitly.
    (console.warn as jest.Mock).mockClear();
  });

  it("coalesces a TF flood into one emit and one frameList recompute per drain", () => {
    const emitSpy = jest.spyOn(renderer, "emit");
    const frameListSpy = jest.spyOn(renderer.transformTree, "frameList");

    const frameCount = 8;
    const event = tfEvent(
      Array.from({ length: frameCount }, (_, i) => ({
        parent: i === 0 ? "world" : `link_${i - 1}`,
        child: `link_${i}`,
        stamp: { sec: 1, nsec: 0 },
      })),
    );
    renderer.addMessageEvent(event);

    // The message sits in the subscription queue; nothing has been applied yet.
    expect(transformTreeUpdatedCount(emitSpy)).toBe(0);
    expect(renderer.transformTree.hasFrame("link_0")).toBe(false);

    renderer.handleSubscriptionQueues();

    // 9 new frames (world + 8 links), one fan-out for the whole drain.
    expect(transformTreeUpdatedCount(emitSpy)).toBe(1);
    expect(frameListSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < frameCount; i++) {
      expect(renderer.transformTree.hasFrame(`link_${i}`)).toBe(true);
    }
    expect(renderer.transformTree.hasFrame("world")).toBe(true);
    expect(renderer.coordinateFrameList).toHaveLength(frameCount + 1);

    // A drain with no new frames does not emit at all.
    renderer.handleSubscriptionQueues();
    expect(transformTreeUpdatedCount(emitSpy)).toBe(1);
    expect(frameListSpy).toHaveBeenCalledTimes(1);
  });

  it("applies queued transforms in message order with per-delivery identity intact", () => {
    const received: MessageEvent[] = [];
    const recorder: RendererSubscription = {
      handler: (event) => {
        received.push(event);
      },
      shouldSubscribe: () => true,
    };
    renderer.topicSubscriptions.set("/tf", [recorder]);
    const emitSpy = jest.spyOn(renderer, "emit");

    const first = tfEvent([{ parent: "world", child: "base", stamp: { sec: 1, nsec: 0 } }], {
      sec: 1,
      nsec: 0,
    });
    const second = tfEvent(
      [
        { parent: "base", child: "sensor", stamp: { sec: 2, nsec: 0 } },
        { parent: "world", child: "base", stamp: { sec: 2, nsec: 0 } },
      ],
      { sec: 2, nsec: 0 },
    );
    renderer.addMessageEvent(first);
    renderer.addMessageEvent(second);
    renderer.handleSubscriptionQueues();

    expect(received).toEqual([first, second]);
    expect(received[0]).toBe(first);
    expect(received[1]).toBe(second);

    // In-order application: "base" existed before "sensor" was parented to it,
    // and both stamps of world->base are in its history.
    expect(renderer.transformTree.frame("sensor")?.parent()?.id).toBe("base");
    expect(renderer.transformTree.frame("base")?.transformsSize()).toBe(2);
    // Both messages drained in a single batch: one emit for both new frames.
    expect(transformTreeUpdatedCount(emitSpy)).toBe(1);
  });

  it("coalesces preloaded allFrames messages the same way once drained", () => {
    const emitSpy = jest.spyOn(renderer, "emit");
    const frameListSpy = jest.spyOn(renderer.transformTree, "frameList");

    renderer.currentTime = 10n * 1_000_000_000n;
    const events = [
      tfEvent([{ parent: "world", child: "a", stamp: { sec: 1, nsec: 0 } }], { sec: 1, nsec: 0 }),
      tfEvent([{ parent: "a", child: "b", stamp: { sec: 2, nsec: 0 } }], { sec: 2, nsec: 0 }),
      tfEvent([{ parent: "b", child: "c", stamp: { sec: 3, nsec: 0 } }], { sec: 3, nsec: 0 }),
    ];
    expect(renderer.handleAllFramesMessages(events)).toBe(true);
    expect(transformTreeUpdatedCount(emitSpy)).toBe(0);

    renderer.handleSubscriptionQueues();
    expect(transformTreeUpdatedCount(emitSpy)).toBe(1);
    expect(frameListSpy).toHaveBeenCalledTimes(1);
    expect(renderer.transformTree.frame("c")?.parent()?.id).toBe("b");
    expect(renderer.coordinateFrameList).toHaveLength(4);
  });

  it("coalesces addCoordinateFrame fan-out within the same drain", () => {
    const frames = ["lidar", "camera", "imu"];
    let next = 0;
    const registrar: RendererSubscription = {
      handler: () => {
        renderer.addCoordinateFrame(frames[next++]!);
      },
      shouldSubscribe: () => true,
    };
    renderer.topicSubscriptions.set("/clock", [registrar]);
    const emitSpy = jest.spyOn(renderer, "emit");
    const frameListSpy = jest.spyOn(renderer.transformTree, "frameList");

    // Messages without a header scrape no frames at ingestion time.
    const events = [0, 1, 2].map((nsec) => ({
      topic: "/clock",
      schemaName: "rosgraph_msgs/Clock",
      receiveTime: { sec: 1, nsec },
      message: {},
      sizeInBytes: 0,
    }));
    renderer.addMessageEventBatch(events);
    renderer.handleSubscriptionQueues();

    expect(transformTreeUpdatedCount(emitSpy)).toBe(1);
    expect(frameListSpy).toHaveBeenCalledTimes(1);
    for (const frame of frames) {
      expect(renderer.transformTree.hasFrame(frame)).toBe(true);
    }
  });

  it("keeps per-call emits for single addTransform calls outside a batch", () => {
    const emitSpy = jest.spyOn(renderer, "emit");
    const frameListSpy = jest.spyOn(renderer.transformTree, "frameList");

    renderer.addTransform("world", "a", 1n, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    renderer.addTransform("world", "b", 1n, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });

    expect(transformTreeUpdatedCount(emitSpy)).toBe(2);
    expect(frameListSpy).toHaveBeenCalledTimes(2);
    expect(renderer.coordinateFrameList).toHaveLength(3);
  });
});
