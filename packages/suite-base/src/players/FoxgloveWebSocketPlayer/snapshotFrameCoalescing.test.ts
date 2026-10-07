// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { mergeSubscriptions } from "@lichtblick/suite-base/components/MessagePipeline/subscriptions";
import type { InternalSubscribePayload } from "@lichtblick/suite-base/players/types";

import { CURRENT_FRAME_MAXIMUM_SIZE_BYTES } from "./constants";
import { LiveMessageQueue } from "./liveMessageQueue";
import {
  isDeferredSnapshotEvent,
  isSnapshotStateSchema,
  makeDeferredSnapshotEvent,
  resolveDeferredSnapshotEvent,
  snapshotCoalescingTopics,
} from "./snapshotFrameCoalescing";

describe("isSnapshotStateSchema", () => {
  it("allowlists only snapshot-semantics schemas", () => {
    for (const schema of [
      "foxglove.Grid",
      "sensor_msgs/Image",
      "sensor_msgs/CompressedImage",
      "sensor_msgs/LaserScan",
      "sensor_msgs/PointCloud2",
      "nav_msgs/OccupancyGrid",
      "nav_msgs/Path",
    ]) {
      expect(isSnapshotStateSchema(schema)).toBe(true);
    }
  });

  it("rejects append- or delete-semantics schemas", () => {
    for (const schema of [
      "tf2_msgs/TFMessage",
      "visualization_msgs/Marker",
      "visualization_msgs/MarkerArray",
      "foxglove.SceneUpdate",
      "geometry_msgs/PoseStamped",
      "std_msgs/Float64",
    ]) {
      expect(isSnapshotStateSchema(schema)).toBe(false);
    }
  });
});

describe("deferred snapshot events", () => {
  const receiveTime = { sec: 1, nsec: 2 };

  it("parses bytes only when resolved at drain time", () => {
    const deserialize = jest.fn((data: ArrayBufferView) => ({ parsed: data.byteLength }));
    const entry = makeDeferredSnapshotEvent({
      topic: "/cloud",
      schemaName: "sensor_msgs/PointCloud2",
      receiveTime,
      data: new Uint8Array([1, 2, 3]),
      deserialize,
    });
    expect(isDeferredSnapshotEvent(entry)).toBe(true);
    expect(deserialize).not.toHaveBeenCalled();

    const resolved = resolveDeferredSnapshotEvent(entry);
    expect(deserialize).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual({
      topic: "/cloud",
      receiveTime,
      message: { parsed: 3 },
      sizeInBytes: 3,
      schemaName: "sensor_msgs/PointCloud2",
    });
  });

  it("does not confuse a parsed pipeline message for a deferred entry", () => {
    expect(
      isDeferredSnapshotEvent({
        topic: "/cloud",
        receiveTime,
        message: {},
        sizeInBytes: 2,
        schemaName: "sensor_msgs/PointCloud2",
      }),
    ).toBe(false);
  });
});

describe("snapshot subscriber semantics", () => {
  const renderSubscription: InternalSubscribePayload = {
    topic: "/path",
    preloadType: "partial",
    samplingRequest: { mode: "latest-per-render-tick" },
    samplingAuthorized: true,
  };

  function deliveredSamples(subscriptions: InternalSubscribePayload[], schema = "nav_msgs/Path") {
    const allowed = snapshotCoalescingTopics(mergeSubscriptions(subscriptions));
    const queue = new LiveMessageQueue<number>(CURRENT_FRAME_MAXIMUM_SIZE_BYTES);
    for (const value of [1, 2]) {
      queue.enqueue(
        { value, key: "/path", sizeInBytes: 1, retention: "replaceable" },
        { supersedeReplaceable: allowed.has("/path") && isSnapshotStateSchema(schema) },
      );
    }
    return queue.drain();
  }

  it("delivers both Plot samples and resumes coalescing only after Plot leaves", () => {
    const plot: InternalSubscribePayload = { topic: "/path", preloadType: "full" };
    expect(deliveredSamples([renderSubscription])).toEqual([2]);
    expect(deliveredSamples([renderSubscription, plot])).toEqual([1, 2]);
    expect(deliveredSamples([plot, renderSubscription])).toEqual([1, 2]);
    expect(deliveredSamples([renderSubscription])).toEqual([2]);
  });

  it.each(["tf2_msgs/TFMessage", "visualization_msgs/Marker", "foxglove.SceneUpdate"])(
    "never coalesces %s even for an authorized display subscription",
    (schema) => { expect(deliveredSamples([renderSubscription], schema)).toEqual([1, 2]); },
  );

  it("coalesces an authorized display-only subscription", () => {
    expect(snapshotCoalescingTopics(mergeSubscriptions([renderSubscription]))).toEqual(
      new Set(["/path"]),
    );
  });

  it.each(["partial", "full"] as const)(
    "keeps all samples when a %s history consumer shares the display topic",
    (preloadType) => {
      const history: InternalSubscribePayload = { topic: "/path", preloadType };
      for (const inputs of [[renderSubscription, history], [history, renderSubscription]]) {
        expect(snapshotCoalescingTopics(mergeSubscriptions(inputs))).toEqual(new Set());
      }
    },
  );

  it("rejects an unapproved request and a full-history request even with approval", () => {
    expect(snapshotCoalescingTopics([{ ...renderSubscription, samplingAuthorized: undefined }]))
      .toEqual(new Set());
    expect(snapshotCoalescingTopics([{ ...renderSubscription, preloadType: "full" }]))
      .toEqual(new Set());
  });

  it("revokes sampling on subscription changes without changing unrelated topics", () => {
    const other = { ...renderSubscription, topic: "/cloud" };
    expect(snapshotCoalescingTopics(mergeSubscriptions([renderSubscription, other])))
      .toEqual(new Set(["/path", "/cloud"]));
    expect(snapshotCoalescingTopics(mergeSubscriptions([
      renderSubscription, other, { topic: "/path", preloadType: "partial" },
    ]))).toEqual(new Set(["/cloud"]));
  });
});
