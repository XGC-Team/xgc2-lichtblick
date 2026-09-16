// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** @jest-environment jsdom */

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { MessageEvent } from "@lichtblick/suite";

import { RendererSubscription } from "./IRenderer";
import { Renderer } from "./Renderer";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "");

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
