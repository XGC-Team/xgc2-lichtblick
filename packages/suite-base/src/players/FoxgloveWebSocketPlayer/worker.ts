// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import {
  FromWorkerMessage,
  ToWorkerMessage,
} from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { COMPRESSED_VIDEO_DATATYPES } from "@lichtblick/suite-base/util/foxgloveSchemas";

import { WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES } from "./constants";
import {
  inspectAnnexBVideoFrame,
  isTransformSchemaName,
  LiveMessageQueue,
  LiveMessageRetention,
} from "./liveMessageQueue";

let ws: WebSocket | undefined = undefined;
let messageInFlight = false;
const messageQueue = new LiveMessageQueue<unknown>(WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES);

type ChannelMetadata = {
  encoding: string | undefined;
  topic: string;
  schemaName: string | undefined;
};

/** Server channelId → channel metadata (from inbound advertise / unadvertise). */
const channelIdToMetadata = new Map<number, ChannelMetadata>();
/** Client subscriptionId → channelId (from outbound subscribe / unsubscribe). */
const subscriptionIdToChannelId = new Map<number, number>();

const send: (message: FromWorkerMessage) => void = self.postMessage;
const sendWithTransfer: (message: FromWorkerMessage, transfer: Transferable[]) => void =
  self.postMessage;

function clearTopicMaps(): void {
  channelIdToMetadata.clear();
  subscriptionIdToChannelId.clear();
}

function isLossExemptChannel(channel: ChannelMetadata): boolean {
  // Keep the conventional topic-name fallback for servers which omit a schema name, but classify
  // custom topics such as /xgc/tf and camera TF primarily by their advertised datatype.
  return (
    channel.topic === "/tf" ||
    channel.topic === "/tf_static" ||
    isTransformSchemaName(channel.schemaName)
  );
}

function channelForSubscription(subId: number): ChannelMetadata | undefined {
  const channelId = subscriptionIdToChannelId.get(subId);
  if (channelId == undefined) {
    return undefined;
  }
  return channelIdToMetadata.get(channelId);
}

/**
 * Fail-safe: an unknown channel (mapping not yet established) is treated as exempt so we never
 * drop transform-like frames before advertise/subscribe control messages are processed.
 */
function isLossExemptSubscription(subId: number): boolean {
  const channel = channelForSubscription(subId);
  if (channel == undefined) {
    return true;
  }
  return isLossExemptChannel(channel);
}

function isVideoSubscription(subId: number): boolean {
  const schemaName = channelForSubscription(subId)?.schemaName;
  return schemaName != undefined && COMPRESSED_VIDEO_DATATYPES.has(schemaName);
}

function isHighPriorityProtectedSubscription(subId: number): boolean {
  const channel = channelForSubscription(subId);
  // Unknown subscriptions stay fail-safe and /tf_static is preferred over dynamic transforms.
  return channel == undefined || channel.topic === "/tf_static";
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

function align(offset: number, alignment: number): number {
  return Math.ceil(offset / alignment) * alignment;
}

function extractRos1CompressedVideoData(data: ArrayBuffer): Uint8Array | undefined {
  const payloadOffset = 13;
  const view = new DataView(data, payloadOffset);
  let offset = 8; // ROS time: uint32 sec + uint32 nsec

  if (offset + 4 > view.byteLength) {
    return undefined;
  }
  const frameIdLength = view.getUint32(offset, true);
  offset += 4 + frameIdLength;
  if (offset + 4 > view.byteLength) {
    return undefined;
  }

  const frameDataLength = view.getUint32(offset, true);
  offset += 4;
  if (offset + frameDataLength > view.byteLength) {
    return undefined;
  }
  return new Uint8Array(data, payloadOffset + offset, frameDataLength);
}

function extractCdrCompressedVideoData(data: ArrayBuffer): Uint8Array | undefined {
  const payloadOffset = 13;
  const view = new DataView(data, payloadOffset);
  if (view.byteLength < 4) {
    return undefined;
  }

  // DDS encapsulation identifier 0x0001 is CDR little-endian; 0x0000 is big-endian.
  const littleEndian = view.getUint8(1) === 1;
  let offset = 4;
  offset = align(offset, 4) + 8; // builtin_interfaces/Time
  offset = align(offset, 4);
  if (offset + 4 > view.byteLength) {
    return undefined;
  }

  const frameIdLength = view.getUint32(offset, littleEndian);
  offset += 4 + frameIdLength; // CDR string length includes its trailing NUL.
  offset = align(offset, 4);
  if (offset + 4 > view.byteLength) {
    return undefined;
  }

  const frameDataLength = view.getUint32(offset, littleEndian);
  offset += 4;
  if (offset + frameDataLength > view.byteLength) {
    return undefined;
  }
  return new Uint8Array(data, payloadOffset + offset, frameDataLength);
}

function isVideoRecoveryPoint(data: unknown, encoding: string | undefined): boolean {
  if (!(data instanceof ArrayBuffer) || data.byteLength <= 13) {
    return false;
  }

  // Parse the serialized wrapper first rather than scanning message metadata. A false-positive IDR
  // in a timestamp/string field could otherwise let P-frames through after a dependency was lost.
  const frameData =
    encoding === "ros1"
      ? extractRos1CompressedVideoData(data)
      : encoding === "cdr"
        ? extractCdrCompressedVideoData(data)
        : undefined;
  return frameData != undefined && inspectAnnexBVideoFrame(frameData).isRecoveryPoint;
}

function sendNextMessage(): void {
  if (messageInFlight) {
    return;
  }
  const next = messageQueue.shift();
  if (!next) {
    return;
  }
  messageInFlight = true;

  if (next.value instanceof ArrayBuffer) {
    sendWithTransfer({ type: "message", data: next.value }, [next.value]);
  } else {
    send({ type: "message", data: next.value });
  }
}

function enqueueMessage(data: unknown): void {
  const subscriptionId = getSubscriptionId(data);
  const isTime = isTimeMessage(data);
  const lossExempt = subscriptionId != undefined ? isLossExemptSubscription(subscriptionId) : false;
  const isVideo = subscriptionId != undefined && isVideoSubscription(subscriptionId);
  const channel = subscriptionId != undefined ? channelForSubscription(subscriptionId) : undefined;
  const retention: LiveMessageRetention = isVideo
    ? "video"
    : lossExempt || (subscriptionId == undefined && !isTime)
      ? "protected"
      : "replaceable";
  const key =
    subscriptionId != undefined ? `subscription:${subscriptionId}` : isTime ? "time" : undefined;
  const protectedPriority =
    retention === "protected" && subscriptionId == undefined && !isTime
      ? "critical"
      : retention === "protected" &&
          subscriptionId != undefined &&
          isHighPriorityProtectedSubscription(subscriptionId)
        ? "high"
        : "normal";

  const sizeInBytes = getMessageSize(data);
  const enqueueResult = messageQueue.enqueue(
    {
      value: data,
      sizeInBytes,
      key,
      retention,
      protectedPriority,
      isVideoRecoveryPoint: isVideo ? isVideoRecoveryPoint(data, channel?.encoding) : undefined,
    },
    // Ordinary telemetry remains live-first/latest-only. Video is never superseded: if memory
    // pressure requires a drop, LiveMessageQueue discards the dependency chain as one unit.
    { supersedeReplaceable: retention === "replaceable" },
  );
  if ((enqueueResult.droppedCriticalEntries ?? 0) > 0) {
    // The worker has already applied inbound advertise/unadvertise metadata locally. Continuing
    // after the renderer misses a protocol control frame would split their protocol state. Abort
    // this connection so the normal reconnect path can rebuild both sides from one clean stream.
    messageQueue.clear();
    send({
      type: "error",
      error: new Error("WebSocket control message exceeded the bounded worker queue"),
    });
    ws?.close(1011, "bounded control queue overflow");
    return;
  }
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
          const schemaName = (channel as { schemaName?: unknown }).schemaName;
          const encoding = (channel as { encoding?: unknown }).encoding;
          channelIdToMetadata.set((channel as { id: number }).id, {
            encoding: typeof encoding === "string" ? encoding : undefined,
            topic: (channel as { topic: string }).topic,
            schemaName: typeof schemaName === "string" ? schemaName : undefined,
          });
        }
      }
    } else if (msg.op === "unadvertise" && Array.isArray(msg.channelIds)) {
      for (const channelId of msg.channelIds) {
        if (typeof channelId === "number") {
          channelIdToMetadata.delete(channelId);
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
          messageQueue.removeKey(`subscription:${subscriptionId}`);
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
        const queueLimitBytes =
          data.queueLimitBytes != undefined &&
          Number.isSafeInteger(data.queueLimitBytes) &&
          data.queueLimitBytes > 0
            ? data.queueLimitBytes
            : WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES;
        messageQueue.clear();
        messageQueue.setMaximumSize(queueLimitBytes);
        messageInFlight = false;
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
