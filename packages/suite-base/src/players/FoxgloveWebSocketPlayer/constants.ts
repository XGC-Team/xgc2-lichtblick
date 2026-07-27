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
