// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { Time } from "@lichtblick/rostime";
import type { Immutable, MessageEvent } from "@lichtblick/suite";
import type { InternalSubscribePayload } from "@lichtblick/suite-base/players/types";

/**
 * Snapshot-semantics schemas: every message carries the complete current
 * state. Coalescing also requires the merged subscription to opt into
 * latest-per-render-tick; schema alone cannot rule out a Plot/history consumer.
 *
 * Deliberately excluded:
 * - tf2_msgs/TFMessage and other transform schemas (protected retention):
 *   different frames arrive in separate messages; dropping one loses a frame.
 * - visualization_msgs/Marker(Array): delete actions in a superseded message
 *   would be lost, leaving ghost markers.
 * - foxglove.SceneUpdate: entity deletions (SceneEntityDeletion) are used by
 *   XGC2 scene producers; byte-level supersede could drop a deletion. Its
 *   volume fix belongs to the producer-side rate/increment work.
 * - Plottable scalar/pose schemas: Plot panels need every sample.
 */
export const SNAPSHOT_STATE_SCHEMAS: ReadonlySet<string> = new Set([
  "foxglove.Grid",
  "sensor_msgs/Image",
  "sensor_msgs/CompressedImage",
  "sensor_msgs/LaserScan",
  "sensor_msgs/PointCloud2",
  "nav_msgs/OccupancyGrid",
  "nav_msgs/Path",
]);

export function isSnapshotStateSchema(schemaName: string): boolean {
  return SNAPSHOT_STATE_SCHEMAS.has(schemaName);
}

/** Keep the pipeline's existing needs-all veto, including full/partial duplicates. */
export function snapshotCoalescingTopics(
  subscriptions: Immutable<InternalSubscribePayload[]>,
): Set<string> {
  const allowed = new Set<string>();
  const needsAll = new Set<string>();
  for (const subscription of subscriptions) {
    if (
      subscription.preloadType !== "full" &&
      subscription.samplingAuthorized === true &&
      subscription.samplingRequest?.mode === "latest-per-render-tick"
    ) {
      allowed.add(subscription.topic);
    } else {
      needsAll.add(subscription.topic);
    }
  }
  for (const topic of needsAll) {
    allowed.delete(topic);
  }
  return allowed;
}

/**
 * A queued message whose bytes have not been parsed yet. Parsing happens at
 * drain time, so entries superseded before the window closes never cost the
 * main thread a deserialization.
 */
export type DeferredSnapshotEvent = {
  readonly deferred: true;
  readonly topic: string;
  readonly schemaName: string;
  readonly receiveTime: Time;
  readonly data: ArrayBufferView;
  readonly deserialize: (data: ArrayBufferView) => unknown;
};

export type LiveQueueMessage = MessageEvent | DeferredSnapshotEvent;

export function makeDeferredSnapshotEvent(args: {
  topic: string;
  schemaName: string;
  receiveTime: Time;
  data: ArrayBufferView;
  deserialize: (data: ArrayBufferView) => unknown;
}): DeferredSnapshotEvent {
  return { deferred: true, ...args };
}

export function isDeferredSnapshotEvent(message: LiveQueueMessage): message is DeferredSnapshotEvent {
  return "deferred" in message;
}

/** Parse a deferred entry into the pipeline's MessageEvent shape. */
export function resolveDeferredSnapshotEvent(entry: DeferredSnapshotEvent): MessageEvent {
  return {
    topic: entry.topic,
    receiveTime: entry.receiveTime,
    message: entry.deserialize(entry.data),
    sizeInBytes: entry.data.byteLength,
    schemaName: entry.schemaName,
  };
}
