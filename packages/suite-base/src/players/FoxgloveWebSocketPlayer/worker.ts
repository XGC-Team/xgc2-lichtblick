// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import {
  FromWorkerMessage,
  ToWorkerMessage,
} from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";

import { WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES } from "./constants";

let ws: WebSocket | undefined = undefined;
let messageInFlight = false;
let queueLimitBytes = WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES;

type QueuedMessage = {
  data: unknown;
  sizeInBytes: number;
  subscriptionId: number | undefined;
  /** MESSAGE_DATA on /tf, /tf_static, or unknown topic — never superseded or trim-evicted. */
  lossExempt: boolean;
  isTime: boolean;
};

const messageQueue: QueuedMessage[] = [];
let messageQueueSizeBytes = 0;

/** Server channelId → topic (from inbound advertise / unadvertise). */
const channelIdToTopic = new Map<number, string>();
/** Client subscriptionId → channelId (from outbound subscribe / unsubscribe). */
const subscriptionIdToChannelId = new Map<number, number>();

const send: (message: FromWorkerMessage) => void = self.postMessage;
const sendWithTransfer: (message: FromWorkerMessage, transfer: Transferable[]) => void =
  self.postMessage;

function clearTopicMaps(): void {
  channelIdToTopic.clear();
  subscriptionIdToChannelId.clear();
}

function isLossExemptTopic(topic: string): boolean {
  return topic === "/tf" || topic === "/tf_static";
}

function topicForSubscription(subId: number): string | undefined {
  const channelId = subscriptionIdToChannelId.get(subId);
  if (channelId == undefined) {
    return undefined;
  }
  return channelIdToTopic.get(channelId);
}

/**
 * Fail-safe: unknown topic (mapping not yet established) is treated as exempt so we never
 * drop TF-like frames before advertise/subscribe control messages are processed.
 */
function isLossExemptSubscription(subId: number): boolean {
  const topic = topicForSubscription(subId);
  if (topic == undefined) {
    return true;
  }
  return isLossExemptTopic(topic);
}

function getSubscriptionId(data: unknown): number | undefined {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 5) {
    return undefined;
  }
  const view = new DataView(data);
  return view.getUint8(0) === BinaryOpcode.MESSAGE_DATA ? view.getUint32(1, true) : undefined;
}

function isTimeMessage(data: unknown): boolean {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 1) {
    return false;
  }
  return new DataView(data).getUint8(0) === BinaryOpcode.TIME;
}

function getMessageSize(data: unknown): number {
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return typeof data === "string" ? data.length * 2 : 0;
}

function removeQueuedMessage(index: number): void {
  const [removed] = messageQueue.splice(index, 1);
  if (removed) {
    messageQueueSizeBytes -= removed.sizeInBytes;
  }
}

function isEvictableTelemetry(queued: QueuedMessage): boolean {
  return queued.subscriptionId != undefined && !queued.lossExempt;
}

function trimMessageQueue(): void {
  while (messageQueueSizeBytes > queueLimitBytes) {
    // Telemetry frames on non-exempt topics may be superseded/evicted. Protocol control
    // messages, service responses, asset responses, TIME, and loss-exempt topics (/tf,
    // /tf_static, or unknown topic) must remain ordered and are never discarded by trim.
    let oldestEvictableIndex = -1;
    let evictableCount = 0;
    for (let i = 0; i < messageQueue.length; i++) {
      if (isEvictableTelemetry(messageQueue[i]!)) {
        if (oldestEvictableIndex < 0) {
          oldestEvictableIndex = i;
        }
        evictableCount++;
      }
    }
    if (oldestEvictableIndex < 0) {
      return;
    }

    // Keep the last remaining evictable telemetry frame so a single oversized frame can still
    // be rendered, even when other non-evictable (protocol / exempt) messages remain in queue.
    if (evictableCount === 1) {
      return;
    }
    removeQueuedMessage(oldestEvictableIndex);
  }
}

function sendNextMessage(): void {
  if (messageInFlight) {
    return;
  }
  const next = messageQueue.shift();
  if (!next) {
    return;
  }
  messageQueueSizeBytes -= next.sizeInBytes;
  messageInFlight = true;

  if (next.data instanceof ArrayBuffer) {
    sendWithTransfer({ type: "message", data: next.data }, [next.data]);
  } else {
    send({ type: "message", data: next.data });
  }
}

function enqueueMessage(data: unknown): void {
  const subscriptionId = getSubscriptionId(data);
  const isTime = isTimeMessage(data);
  const lossExempt =
    subscriptionId != undefined ? isLossExemptSubscription(subscriptionId) : false;

  if (subscriptionId != undefined) {
    // Non-exempt telemetry: when the renderer is behind, only the newest unsent frame for a
    // subscription is useful. Loss-exempt topics (/tf, /tf_static, unknown) never supersede.
    if (!lossExempt) {
      // Never supersede frames that were enqueued as loss-exempt (e.g. fail-safe before the
      // topic map existed). Exempt frames neither supersede others nor are superseded.
      const supersededIndex = messageQueue.findIndex(
        (queued) => queued.subscriptionId === subscriptionId && !queued.lossExempt,
      );
      if (supersededIndex >= 0) {
        removeQueuedMessage(supersededIndex);
      }
    }
  } else if (isTime) {
    // Only the latest TIME frame is meaningful; keep at most one unsent TIME in the queue.
    const supersededIndex = messageQueue.findIndex((queued) => queued.isTime);
    if (supersededIndex >= 0) {
      removeQueuedMessage(supersededIndex);
    }
  }

  const sizeInBytes = getMessageSize(data);
  messageQueue.push({ data, sizeInBytes, subscriptionId, lossExempt, isTime });
  messageQueueSizeBytes += sizeInBytes;
  trimMessageQueue();
  sendNextMessage();
}

/**
 * Server → client control messages stream through the worker. Track channelId→topic from
 * advertise/unadvertise so MESSAGE_DATA frames can be classified for backpressure policy.
 * Lightweight: only JSON objects with an "op" field; parse failures are ignored.
 */
function trackInboundControlMessage(data: unknown): void {
  if (typeof data !== "string" || !data.startsWith("{")) {
    return;
  }
  try {
    const msg = JSON.parse(data) as {
      op?: unknown;
      channels?: unknown;
      channelIds?: unknown;
    };
    if (typeof msg.op !== "string") {
      return;
    }
    if (msg.op === "advertise" && Array.isArray(msg.channels)) {
      for (const channel of msg.channels) {
        if (
          channel != undefined &&
          typeof channel === "object" &&
          typeof (channel as { id?: unknown }).id === "number" &&
          typeof (channel as { topic?: unknown }).topic === "string"
        ) {
          channelIdToTopic.set(
            (channel as { id: number }).id,
            (channel as { topic: string }).topic,
          );
        }
      }
    } else if (msg.op === "unadvertise" && Array.isArray(msg.channelIds)) {
      for (const channelId of msg.channelIds) {
        if (typeof channelId === "number") {
          channelIdToTopic.delete(channelId);
        }
      }
    }
  } catch {
    // Malformed JSON control frames are still forwarded; mapping stays unchanged.
  }
}

/**
 * Client → server subscribe/unsubscribe also stream through the worker. Track
 * subscriptionId→channelId so we can resolve topics for inbound MESSAGE_DATA.
 */
function trackOutboundControlMessage(data: unknown): void {
  if (typeof data !== "string" || !data.startsWith("{")) {
    return;
  }
  try {
    const msg = JSON.parse(data) as {
      op?: unknown;
      subscriptions?: unknown;
      subscriptionIds?: unknown;
    };
    if (typeof msg.op !== "string") {
      return;
    }
    if (msg.op === "subscribe" && Array.isArray(msg.subscriptions)) {
      for (const sub of msg.subscriptions) {
        if (
          sub != undefined &&
          typeof sub === "object" &&
          typeof (sub as { id?: unknown }).id === "number" &&
          typeof (sub as { channelId?: unknown }).channelId === "number"
        ) {
          subscriptionIdToChannelId.set(
            (sub as { id: number }).id,
            (sub as { channelId: number }).channelId,
          );
        }
      }
    } else if (msg.op === "unsubscribe" && Array.isArray(msg.subscriptionIds)) {
      for (const subscriptionId of msg.subscriptionIds) {
        if (typeof subscriptionId === "number") {
          subscriptionIdToChannelId.delete(subscriptionId);
        }
      }
    }
  } catch {
    // Malformed JSON control frames are still forwarded; mapping stays unchanged.
  }
}

self.onmessage = (event: MessageEvent<ToWorkerMessage>) => {
  const { type } = event.data;
  switch (type) {
    case "open":
      try {
        const { data } = event.data;
        queueLimitBytes =
          data.queueLimitBytes != undefined &&
          Number.isFinite(data.queueLimitBytes) &&
          data.queueLimitBytes > 0
            ? data.queueLimitBytes
            : WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES;
        clearTopicMaps();
        ws = new WebSocket(data.wsUrl, data.protocols);
        ws.binaryType = "arraybuffer";
        ws.onerror = (wsEvent) => {
          send({
            type: "error",
            error: (wsEvent as unknown as { error: Error }).error,
          });
        };
        ws.onopen = (_event) => {
          send({
            type: "open",
            protocol: ws!.protocol,
          });
        };
        ws.onclose = (wsEvent) => {
          send({ type: "close", data: JSON.parse(JSON.stringify(wsEvent) ?? "{}") });
        };
        ws.onmessage = (wsEvent: MessageEvent) => {
          trackInboundControlMessage(wsEvent.data);
          enqueueMessage(wsEvent.data);
        };
      } catch (err: unknown) {
        // try-catch is needed to catch `Mixed Content` errors in Chrome, where the client
        // attempts to load `ws://` from `https://`. (Safari would catch these in `ws.onerror`
        // but with `undefined` as an error.)
        send({
          type: "error",
          error: err ?? { message: "Insecure WebSocket connection" },
        });
      }
      break;
    case "close":
      ws?.close();
      break;
    case "data":
      trackOutboundControlMessage(event.data.data);
      ws?.send(event.data.data as string | BufferSource);
      break;
    case "ack":
      messageInFlight = false;
      sendNextMessage();
      break;
  }
};
