// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { nanos, record, requireValue, rosNanos, type SnapshotEvent, type Time } from "./state";

export const OFFLINE_TF_HISTORY_SECONDS = 600;

/** Reject a snapshot if native TF storage would evict any of its selected history. */
export function validateTransformHistory(
  history: readonly SnapshotEvent[],
  bounds: { maxStorageTime: bigint; maxCapacityPerFrame: number },
): void {
  requireValue(bounds.maxStorageTime > 0n && Number.isSafeInteger(bounds.maxCapacityPerFrame) &&
    bounds.maxCapacityPerFrame > 1, "Invalid native TF history bounds");
  const frames = new Map<string, { mode: string; times: Set<bigint>; min: bigint; max: bigint }>();
  for (const row of history) {
    if (row.role === "data") { continue; }
    const message = row.event.message;
    requireValue(record(message) && Array.isArray(message.transforms) && message.transforms.length === 1,
      "Offline TF messages must contain exactly one normalized transform");
    const transform: unknown = message.transforms[0];
    requireValue(record(transform) && record(transform.header) && record(transform.header.stamp) &&
      typeof transform.child_frame_id === "string", "Invalid normalized TF");
    const id = transform.child_frame_id.replace(/^\/+/, "");
    requireValue(id.length > 0 && id.length <= 256, "Invalid TF child frame");
    const stamp = rosNanos(transform.header.stamp as Time);
    requireValue(row.role === "tf-static" || (stamp > 0n && stamp === nanos(row.timeNs)), "Dynamic TF time mismatch");
    let frame = frames.get(id);
    if (frame == undefined) {
      requireValue(frames.size < 4096, "Too many TF frames");
      frame = { mode: row.role, times: new Set(), min: stamp, max: stamp };
      frames.set(id, frame);
    }
    requireValue(frame.mode === row.role, "A frame cannot mix static and dynamic TF sources");
    frame.times.add(stamp);
    frame.min = stamp < frame.min ? stamp : frame.min;
    frame.max = stamp > frame.max ? stamp : frame.max;
    // Native capacity trims occur at >= max; time-bound equality is rejected too.
    requireValue(frame.times.size < bounds.maxCapacityPerFrame, `Native TF capacity would truncate ${id}`);
    requireValue(frame.max - frame.min < bounds.maxStorageTime,
      `TF history exceeds the offline window for ${id}; prepare a validated checkpoint rather than truncate history`);
  }
}
