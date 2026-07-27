// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

/** Suppress warnings about messages on unknown subscriptions if the susbscription was recently canceled. */
export const SUBSCRIPTION_WARNING_SUPPRESSION_MS = 2000;

export const ZERO_TIME = Object.freeze({ sec: 0, nsec: 0 });
export const GET_ALL_PARAMS_REQUEST_ID = "get-all-params";
export const GET_ALL_PARAMS_PERIOD_MS = 15000;
export const ROS_ENCODINGS = ["ros1", "cdr"];
export const SUPPORTED_PUBLICATION_ENCODINGS = ["json", ...ROS_ENCODINGS];
export const FALLBACK_PUBLICATION_ENCODING = "json";
export const SUPPORTED_SERVICE_ENCODINGS = ["json", ...ROS_ENCODINGS];

/**
 * XGC2 is a live visualization client. Keep only a small amount of parsed history when rendering
 * falls behind; stale frames are less useful than bounded latency and predictable memory usage.
 */
export const CURRENT_FRAME_MAXIMUM_SIZE_BYTES = 16 * 1024 * 1024;

/**
 * Maximum raw telemetry backlog retained inside the WebSocket worker. The worker/main-thread
 * acknowledgement protocol guarantees that at most one additional message is queued by the
 * browser's MessagePort.
 */
export const WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES = 16 * 1024 * 1024;

const MEMORY_CAP_MIN_MB = 4;
const MEMORY_CAP_MAX_MB = 1024;

export type PlayerMemoryCaps = {
  currentFrameMaximumSizeBytes: number;
  workerQueueMaximumSizeBytes: number;
};

/**
 * Resolve the two backlog caps from a URL query string. High-bandwidth sensor
 * deployments (multi-MB PointCloud2 frames, several 4K cameras) can raise the
 * bounds per page load with `xgcFrameCapMB` (parsed-message backlog on the main
 * thread) and `xgcWorkerQueueMB` (raw backlog inside the WebSocket worker),
 * both clamped to 4..1024 MB. Absent or invalid values keep the 16 MB
 * live-first defaults. Per-topic loss policy is independent of these caps:
 * telemetry is superseded per subscription (latest frame wins), /tf and
 * /tf_static and protocol messages are never dropped.
 */
export function resolvePlayerMemoryCaps(search: string | undefined): PlayerMemoryCaps {
  const defaults: PlayerMemoryCaps = {
    currentFrameMaximumSizeBytes: CURRENT_FRAME_MAXIMUM_SIZE_BYTES,
    workerQueueMaximumSizeBytes: WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES,
  };
  if (search == undefined || search === "") {
    return defaults;
  }
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return defaults;
  }
  const readCapMb = (key: string): number | undefined => {
    const raw = params.get(key);
    if (raw == undefined || raw === "") {
      return undefined;
    }
    const mb = Number(raw);
    if (!Number.isFinite(mb) || mb < MEMORY_CAP_MIN_MB) {
      return undefined;
    }
    return Math.min(mb, MEMORY_CAP_MAX_MB);
  };
  const frameMb = readCapMb("xgcFrameCapMB");
  const workerMb = readCapMb("xgcWorkerQueueMB");
  return {
    currentFrameMaximumSizeBytes:
      frameMb != undefined
        ? Math.round(frameMb * 1024 * 1024)
        : defaults.currentFrameMaximumSizeBytes,
    workerQueueMaximumSizeBytes:
      workerMb != undefined
        ? Math.round(workerMb * 1024 * 1024)
        : defaults.workerQueueMaximumSizeBytes,
  };
}
