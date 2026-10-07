// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import type { Time } from "@lichtblick/rostime";
import type { MessageEvent } from "@lichtblick/suite-base/players/types";

/**
 * Parked parse pause: while the embed reports hidden, the viewer spends ~zero
 * CPU on message processing. Mechanism per schema class:
 *
 * - Snapshot schemas (the S1 set in snapshotFrameCoalescing.ts) and every
 *   other append-only schema: raw bytes are queued UNPARSED with
 *   latest-per-topic supersede. On resume the drain parses and applies exactly
 *   one message per topic, so the scene shows current truth. This reuses the
 *   S1 deferred-event machinery with no new semantics.
 * - TF / transform schemas: same latest-per-topic raw-bytes queue. Applying
 *   the latest aggregated TF message refreshes current poses; poses resolve at
 *   the render time key, so the first drain after resume cannot produce stale
 *   intermediate poses. Transform frames are never deleted, so nothing missed
 *   while parked can leave a ghost.
 * - Deletion-semantic schemas (foxglove.SceneUpdate, visualization_msgs/Marker
 *   and MarkerArray, in all encoding/name variants): latest-wins coalescing
 *   would drop deletions and leave ghost entities, so instead the player
 *   UNSUBSCRIBES those channels while parked and, on resume, enqueues a
 *   synthesized layer-clear event (this file) BEFORE resubscribing. The
 *   foxglove websocket server does not replay non-latched channels on
 *   subscribe, so the producer's next full publish repopulates current truth;
 *   latched channels (the rare, cheap Marker case) replay their last message
 *   after the subscribe, which lands after the clear and is therefore equally
 *   correct. The clear-then-subscribe order makes missed deletions impossible
 *   to survive either way.
 * - Image/video schemas are snapshot class; decode stays deferred by
 *   canvasVisibility as before.
 *
 * Memory bound while parked: the live queue cap is tightened to
 * PARKED_FRAME_MAXIMUM_SIZE_BYTES for the duration of the park, and supersede
 * keeps at most one message per topic, so usage is
 * min(cap, sum of latest message sizes) regardless of park duration.
 * Deletion-semantic channels hold no queued bytes at all (unsubscribed).
 *
 * Schema-keyed only: behavior never depends on topic names.
 */

/** Hard memory bound for the deferred live queue while the embed is parked. */
export const PARKED_FRAME_MAXIMUM_SIZE_BYTES = 32 * 1024 * 1024;

/**
 * Schema leaf names whose message streams carry deletion semantics and must
 * never be latest-wins coalesced. Matched by leaf so ROS1 (`pkg/Type`), ROS2
 * (`pkg/msg/Type`), protobuf (`pkg.Type`) and IDL (`pkg::Type`) variants all
 * classify the same way, like `isTransformSchemaName` in liveMessageQueue.ts.
 *
 * `visualization_msgs/ImageMarker` is deliberately not included: its REMOVE
 * action has no clean delete-all equivalent to synthesize on resume.
 */
const DELETION_SEMANTIC_SCHEMA_LEAVES: ReadonlySet<string> = new Set([
  "SceneUpdate",
  "Marker",
  "MarkerArray",
]);

export function isDeletionSemanticSchema(schemaName: string | undefined): boolean {
  if (schemaName == undefined) {
    return false;
  }
  const leaf = schemaName.split(/[./:]/).filter(Boolean).at(-1);
  return leaf != undefined && DELETION_SEMANTIC_SCHEMA_LEAVES.has(leaf);
}

// Values mirror the wire enums so the synthesized events carry no imports from
// the schema packages: foxglove.SceneEntityDeletionType.ALL and
// visualization_msgs/Marker action DELETEALL.
const SCENE_ENTITY_DELETION_TYPE_ALL = 1;
const MARKER_ACTION_DELETEALL = 3;

/**
 * Synthesized "clear the whole layer for this topic" event for a
 * deletion-semantic channel. The player enqueues it on resume, before
 * resubscribing the channel, so the renderables' existing deletion handling
 * (SceneEntityDeletion ALL / Marker DELETEALL with empty namespace) wipes any
 * entities that pre-date the park and the producer's next publish repopulates
 * current truth with no ghosts.
 *
 * The message is built in the deserialized shape the renderables consume;
 * their normalizers are partial-tolerant, so the minimal fields below are
 * sufficient regardless of the channel's wire encoding.
 */
export function makeSceneLayerClearEvent(args: {
  topic: string;
  schemaName: string;
  receiveTime: Time;
}): MessageEvent {
  const leaf = args.schemaName.split(/[./:]/).filter(Boolean).at(-1);
  let message: unknown;
  if (leaf === "SceneUpdate") {
    message = { deletions: [{ type: SCENE_ENTITY_DELETION_TYPE_ALL }], entities: [] };
  } else if (leaf === "MarkerArray") {
    message = { markers: [{ action: MARKER_ACTION_DELETEALL, ns: "", id: 0 }] };
  } else {
    message = { action: MARKER_ACTION_DELETEALL, ns: "", id: 0 };
  }
  return {
    topic: args.topic,
    schemaName: args.schemaName,
    receiveTime: args.receiveTime,
    message,
    sizeInBytes: 0,
  };
}
