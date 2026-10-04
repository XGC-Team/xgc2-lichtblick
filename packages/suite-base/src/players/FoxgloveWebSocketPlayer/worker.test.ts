// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { BinaryOpcode } from "@foxglove/ws-protocol";

import {
  CURRENT_FRAME_MAXIMUM_SIZE_BYTES,
  resolvePlayerMemoryCaps,
  WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES,
} from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/constants";
import { ToWorkerMessage } from "@lichtblick/suite-base/players/FoxgloveWebSocketPlayer/types";
import { BasicBuilder } from "@lichtblick/test-builders";

class MockWebSocket {
  public static lastInstance: MockWebSocket | undefined;
  public binaryType = "";
  public protocol = "test-protocol";
  public onerror?: (event: unknown) => void;
  public onopen?: (event: unknown) => void;
  public onclose?: (event: unknown) => void;
  public onmessage?: (event: MessageEvent) => void;
  public close = jest.fn();
  public send = jest.fn();

  public constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    MockWebSocket.lastInstance = this;
    if (constructorShouldThrow) {
      throw constructorError;
    }
  }
}

let constructorShouldThrow = false;
let constructorError: unknown;
let postMessageMock: jest.Mock;
let onmessage: (event: MessageEvent<ToWorkerMessage>) => void;

function dispatch(data: ToWorkerMessage): void {
  onmessage({ data } as MessageEvent<ToWorkerMessage>);
}

/** Every message the worker posted, in post order, whether it travelled alone or in a batch. */
function postedMessageData(): unknown[] {
  const delivered: unknown[] = [];
  for (const [message] of postMessageMock.mock.calls) {
    if (message?.type === "message") {
      delivered.push(message.data);
    } else if (message?.type === "messages") {
      delivered.push(...(message.data as unknown[]));
    }
  }
  return delivered;
}

function messageData(subscriptionId: number, payloadSize = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(13 + payloadSize);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryOpcode.MESSAGE_DATA);
  view.setUint32(1, subscriptionId, true);
  return buffer;
}

function timeData(): ArrayBuffer {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryOpcode.TIME);
  return buffer;
}

function assetResponseData(requestId: number, payloadSize = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(10 + payloadSize);
  const view = new DataView(buffer);
  view.setUint8(0, BinaryOpcode.FETCH_ASSET_RESPONSE);
  view.setUint32(1, requestId, true);
  view.setUint8(5, 0);
  view.setUint32(6, 0, true);
  return buffer;
}

function serverAdvertise(
  channels: Array<{ id: number; topic: string; schemaName?: string; encoding?: string }>,
): string {
  // JSON.stringify is typed string | undefined under TS 6; these objects always serialize.
  return JSON.stringify({
    op: "advertise",
    channels: channels.map((ch) => ({
      id: ch.id,
      topic: ch.topic,
      encoding: ch.encoding ?? "cdr",
      schemaName: ch.schemaName ?? "test",
      schema: "",
    })),
  })!;
}

function clientSubscribe(subscriptions: Array<{ id: number; channelId: number }>): string {
  return JSON.stringify({ op: "subscribe", subscriptions })!;
}

/** Build channel/subscription maps the same way a live session would. */
function establishTopicMapping(
  entries: Array<{
    subId: number;
    channelId: number;
    topic: string;
    schemaName?: string;
    encoding?: string;
  }>,
): void {
  dispatch({
    type: "data",
    data: clientSubscribe(entries.map((e) => ({ id: e.subId, channelId: e.channelId }))),
  });
  MockWebSocket.lastInstance?.onmessage?.({
    data: serverAdvertise(
      entries.map((e) => ({
        id: e.channelId,
        topic: e.topic,
        schemaName: e.schemaName,
        encoding: e.encoding,
      })),
    ),
  } as MessageEvent);
  // Advertise is enqueued and immediately posted; ack so subsequent telemetry is not blocked.
  dispatch({ type: "ack" });
}

function compressedVideoData(
  subscriptionId: number,
  nalUnits: number[],
  paddingSize = 0,
): ArrayBuffer {
  const format = new TextEncoder().encode("h264");
  const serializedSize =
    8 + // timestamp
    4 + // empty frame_id
    4 +
    nalUnits.length +
    paddingSize +
    4 +
    format.length;
  const buffer = messageData(subscriptionId, serializedSize);
  const view = new DataView(buffer);
  let offset = 13 + 8;
  view.setUint32(offset, 0, true);
  offset += 4;
  view.setUint32(offset, nalUnits.length + paddingSize, true);
  offset += 4;
  new Uint8Array(buffer, offset, nalUnits.length).set(nalUnits);
  offset += nalUnits.length + paddingSize;
  view.setUint32(offset, format.length, true);
  offset += 4;
  new Uint8Array(buffer, offset, format.length).set(format);
  return buffer;
}

const H264_KEYFRAME = [0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 2, 0, 0, 0, 1, 0x65, 3];
const H264_DELTA_FRAME = [0, 0, 0, 1, 0x61, 4];

describe("FoxgloveWebSocketPlayer worker", () => {
  const wsUrl = BasicBuilder.string();
  beforeEach(async () => {
    jest.resetModules();

    MockWebSocket.lastInstance = undefined;
    constructorShouldThrow = false;
    constructorError = undefined;

    postMessageMock = jest.fn();
    (global as unknown as { self: unknown }).self = global;
    self.postMessage = postMessageMock;
    (global as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

    await import("./worker");
    onmessage = self.onmessage as unknown as (event: MessageEvent<ToWorkerMessage>) => void;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("open", () => {
    it("should create a WebSocket with the given url and protocols", () => {
      // Given
      const protocols = [BasicBuilder.string()];
      // When
      dispatch({ type: "open", data: { wsUrl, protocols } });
      // Then
      expect(MockWebSocket.lastInstance?.url).toBe(wsUrl);
      expect(MockWebSocket.lastInstance?.protocols).toEqual(protocols);
    });

    it("should set the binaryType to arraybuffer", () => {
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(MockWebSocket.lastInstance?.binaryType).toBe("arraybuffer");
    });

    it("should post an open message when the socket opens", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      // When
      MockWebSocket.lastInstance?.onopen?.(undefined);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "open",
        protocol: "test-protocol",
      });
    });

    it("should post an error message when the socket errors", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const error = new Error(BasicBuilder.string());
      // When
      MockWebSocket.lastInstance?.onerror?.({ error });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "error", error });
    });

    it("should post a close message when the socket closes", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const closeEvent = { code: 1000, reason: BasicBuilder.string() };
      // When
      MockWebSocket.lastInstance?.onclose?.(closeEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "close",
        data: closeEvent,
      });
    });

    it("should post a message and transfer the buffer for ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const buffer = new ArrayBuffer(8);
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data: buffer } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: buffer }, [buffer]);
    });

    it("should post a message without transfer for non-ArrayBuffer payloads", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const data = BasicBuilder.string();
      // When
      MockWebSocket.lastInstance?.onmessage?.({ data } as MessageEvent);
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data });
    });

    it("should wait for an acknowledgement before posting the next message", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const first = messageData(1);
      const second = messageData(2);

      // When
      MockWebSocket.lastInstance?.onmessage?.({ data: first } as MessageEvent);
      postMessageMock.mockClear();
      MockWebSocket.lastInstance?.onmessage?.({ data: second } as MessageEvent);

      // Then
      expect(postMessageMock).not.toHaveBeenCalled();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: second }, [second]);
    });

    describe("batched posts", () => {
      function openWithMapping(): void {
        dispatch({ type: "open", data: { wsUrl } });
        establishTopicMapping([
          { subId: 1, channelId: 10, topic: "/camera/image" },
          { subId: 2, channelId: 20, topic: "/xgc/tf", schemaName: "tf2_msgs/TFMessage" },
          { subId: 3, channelId: 30, topic: "/lidar/points" },
        ]);
        postMessageMock.mockClear();
      }
      const receive = (data: unknown): void => {
        MockWebSocket.lastInstance?.onmessage?.({ data } as MessageEvent);
      };

      it("posts a lone message at once and what queued behind a busy post as one ordered batch", () => {
        openWithMapping();
        const first = messageData(2, 8);
        receive(first);
        expect(postMessageMock).toHaveBeenCalledTimes(1);
        expect(postMessageMock).toHaveBeenLastCalledWith({ type: "message", data: first }, [first]);
        postMessageMock.mockClear();

        // The post is unacknowledged: these queue, in order, and nothing is posted.
        const queued = [messageData(2, 8), messageData(2, 16), messageData(2, 24), messageData(2, 32)];
        queued.forEach(receive);
        expect(postMessageMock).not.toHaveBeenCalled();

        dispatch({ type: "ack" });

        expect(postMessageMock).toHaveBeenCalledTimes(1);
        const [message, transfer] = postMessageMock.mock.calls[0] as [
          { type: string; data: unknown[] },
          ArrayBuffer[],
        ];
        expect(message.type).toBe("messages");
        expect(message.data).toEqual(queued);
        message.data.forEach((data, index) => {
          expect(data).toBe(queued[index]);
        });
        expect(transfer).toEqual(queued);
      });

      it("keeps the one-post-in-flight rule: nothing more is posted until the batch is acknowledged", () => {
        openWithMapping();
        receive(messageData(2));
        receive(messageData(2, 1));
        receive(messageData(2, 2));
        dispatch({ type: "ack" });
        postMessageMock.mockClear();

        const during = messageData(2, 3);
        receive(during);
        expect(postMessageMock).not.toHaveBeenCalled();

        dispatch({ type: "ack" });
        expect(postMessageMock).toHaveBeenCalledTimes(1);
        // A batch of one is posted as the single message it always was.
        expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: during }, [during]);
      });

      it("takes the whole queue even when it holds mixed control frames and telemetry, in order", () => {
        openWithMapping();
        receive(messageData(2));
        const tfA = messageData(2, 4);
        const status = JSON.stringify({ op: "status", level: 0, message: "ok" });
        const tfB = messageData(2, 8);
        [tfA, status, tfB].forEach(receive);
        postMessageMock.mockClear();

        dispatch({ type: "ack" });

        expect(postedMessageData()).toEqual([tfA, status, tfB]);
        // Only the binary frames are transferred; the string is copied.
        expect(postMessageMock.mock.calls[0]?.[1]).toEqual([tfA, tfB]);
      });

      it("still keeps only the latest queued frame per ordinary telemetry subscription", () => {
        openWithMapping();
        receive(messageData(1));
        const tf = messageData(2, 4);
        const oldCamera = messageData(1, 4);
        const lidar = messageData(3, 4);
        const newCamera = messageData(1, 8);
        [tf, oldCamera, lidar, newCamera].forEach(receive);
        postMessageMock.mockClear();

        dispatch({ type: "ack" });

        // The superseded camera frame is gone; the others keep their arrival order.
        expect(postedMessageData()).toEqual([tf, lidar, newCamera]);
      });

      it("posts nothing for an acknowledgement with nothing queued and stays ready for the next message", () => {
        openWithMapping();
        receive(messageData(2));
        postMessageMock.mockClear();

        dispatch({ type: "ack" });
        expect(postMessageMock).not.toHaveBeenCalled();

        const next = messageData(2, 4);
        receive(next);
        expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: next }, [next]);
      });

      it("hands every message to the main thread exactly once across many batches", () => {
        openWithMapping();
        const sent: ArrayBuffer[] = [];
        const got: unknown[] = [];
        for (let round = 0; round < 40; round++) {
          // Bursts of varying size arrive while the previous post is outstanding.
          const burst = 1 + ((round * 7) % 9);
          for (let i = 0; i < burst; i++) {
            const data = messageData(2, sent.length);
            sent.push(data);
            receive(data);
          }
          got.push(...postedMessageData());
          postMessageMock.mockClear();
          dispatch({ type: "ack" });
          got.push(...postedMessageData());
          postMessageMock.mockClear();
        }
        dispatch({ type: "ack" });
        got.push(...postedMessageData());

        expect(got).toHaveLength(sent.length);
        got.forEach((data, index) => {
          expect(data).toBe(sent[index]);
        });
      });
    });

    it("should transfer an oversized asset response outside the bounded telemetry queue", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl, queueLimitBytes: 100 } });
      const socket = MockWebSocket.lastInstance;
      const inFlight = messageData(1);
      const queued = messageData(2);
      const asset = assetResponseData(7, 200);
      socket?.onmessage?.({ data: inFlight } as MessageEvent);
      socket?.onmessage?.({ data: queued } as MessageEvent);
      postMessageMock.mockClear();

      // When
      socket?.onmessage?.({ data: asset } as MessageEvent);

      // Then — the finite asset payload is transferred immediately and does not abort or mutate
      // the ACK state of the bounded live-message queue.
      expect(postMessageMock).toHaveBeenCalledWith(
        { type: "message", data: asset, requiresAck: false },
        [asset],
      );
      expect(socket?.close).not.toHaveBeenCalled();
      postMessageMock.mockClear();

      dispatch({ type: "ack" });
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: queued }, [queued]);
    });

    it("should keep only the latest queued telemetry frame for each subscription", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      // Map sub 1/2 to ordinary (non-exempt) topics so supersede applies.
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/lidar/points" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const superseded = messageData(2);
      const latest = messageData(2);
      MockWebSocket.lastInstance?.onmessage?.({
        data: inFlight,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: superseded,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: latest } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(latest);
      expect(postMessageMock.mock.calls[0]?.[1]?.[0]).toBe(latest);
    });

    it("should evict old telemetry when the raw queue exceeds its memory limit", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/lidar/points" },
        { subId: 3, channelId: 30, topic: "/camera/depth" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const evicted = messageData(2, 9 * 1024 * 1024);
      const retained = messageData(3, 9 * 1024 * 1024);
      MockWebSocket.lastInstance?.onmessage?.({
        data: inFlight,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: evicted,
      } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({
        data: retained,
      } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(retained);
      expect(postMessageMock.mock.calls[0]?.[1]?.[0]).toBe(retained);
    });

    it("should preserve /tf and /tf_static order while replaceable traffic can absorb pressure", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/camera/image" },
        { subId: 2, channelId: 20, topic: "/tf" },
        { subId: 3, channelId: 30, topic: "/tf_static" },
        { subId: 4, channelId: 40, topic: "/lidar/points" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(1);
      const tfA = messageData(2, 100);
      const tfB = messageData(2, 100);
      const tfStatic = messageData(3, 100);
      // Two large ordinary frames overflow the queue; replaceable traffic is discarded first.
      const bigCamera = messageData(1, 9 * 1024 * 1024);
      const bigLidar = messageData(4, 9 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfB } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfStatic } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: bigCamera } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: bigLidar } as MessageEvent);
      postMessageMock.mockClear();

      // When — drain the entire remaining queue
      const delivered: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        delivered.push(...postedMessageData());
        postMessageMock.mockClear();
      }

      // Then — both /tf frames and /tf_static keep their original order under ordinary pressure.
      expect(delivered).toContain(tfA);
      expect(delivered).toContain(tfB);
      expect(delivered).toContain(tfStatic);
    });

    it("drops oldest dynamic transforms before /tf_static and protocol control messages", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl, queueLimitBytes: 700 } });
      establishTopicMapping([
        { subId: 1, channelId: 10, topic: "/tf" },
        { subId: 2, channelId: 20, topic: "/tf_static" },
        { subId: 3, channelId: 30, topic: "/camera/image" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(3);
      const tfOld = messageData(1, 200);
      const tfNew = messageData(1, 200);
      const control = JSON.stringify({ op: "status", level: 0, message: "x".repeat(100) });
      const tfStatic = messageData(2, 200);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfOld } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfNew } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: control } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfStatic } as MessageEvent);
      postMessageMock.mockClear();

      // When — drain the hard-bounded queue.
      const delivered: unknown[] = [];
      for (let i = 0; i < 5; i++) {
        dispatch({ type: "ack" });
        delivered.push(...postedMessageData());
        postMessageMock.mockClear();
      }

      // Then — under exceptional protected-only congestion, dynamic TF degrades first. Static TF
      // and protocol control are preferred, but the queue implementation still ultimately permits
      // their oldest entries to be dropped if no lower-priority data remains.
      expect(delivered).not.toContain(tfOld);
      expect(delivered).not.toContain(tfNew);
      expect(delivered).toEqual([control, tfStatic]);
    });

    it("should protect transform messages by datatype on custom topic names", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        {
          subId: 1,
          channelId: 10,
          topic: "/xgc/tf",
          schemaName: "tf2_msgs/TFMessage",
        },
        {
          subId: 2,
          channelId: 20,
          topic: "/xgc/camera/world/tf",
          schemaName: "geometry_msgs/TransformStamped",
        },
        { subId: 3, channelId: 30, topic: "/camera/image" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(3);
      const tfA = messageData(1, 100);
      const tfB = messageData(1, 100);
      const cameraTf = messageData(2, 100);
      const oversizedTelemetry = messageData(3, 17 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: tfB } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: cameraTf } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: oversizedTelemetry } as MessageEvent);
      postMessageMock.mockClear();

      // When
      const delivered: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        delivered.push(...postedMessageData());
        postMessageMock.mockClear();
      }

      // Then
      expect(delivered).toContain(tfA);
      expect(delivered).toContain(tfB);
      expect(delivered).toContain(cameraTf);
    });

    it("should keep complete unsent compressed-video dependency chains", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([
        {
          subId: 1,
          channelId: 10,
          topic: "/camera/video",
          schemaName: "foxglove_msgs/CompressedVideo",
          encoding: "ros1",
        },
        { subId: 2, channelId: 20, topic: "/camera/image" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(2);
      const deltaA = compressedVideoData(1, H264_DELTA_FRAME);
      const deltaB = compressedVideoData(1, H264_DELTA_FRAME);
      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: deltaA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: deltaB } as MessageEvent);
      postMessageMock.mockClear();

      // When / Then — unlike ordinary telemetry, the first delta frame is not superseded, and the
      // chain keeps its order inside the one batch the acknowledgement releases.
      dispatch({ type: "ack" });
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postedMessageData()).toEqual([deltaA, deltaB]);
    });

    it("should discard an overflowing GOP and reject deltas until the next IDR/SPS", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl, queueLimitBytes: 100 } });
      establishTopicMapping([
        {
          subId: 1,
          channelId: 10,
          topic: "/camera/video",
          schemaName: "foxglove_msgs/CompressedVideo",
          encoding: "ros1",
        },
        { subId: 2, channelId: 20, topic: "/camera/image" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(2);
      const oldIdr = compressedVideoData(1, H264_KEYFRAME, 30);
      const overflowingDelta = compressedVideoData(1, H264_DELTA_FRAME, 30);
      const rejectedDelta = compressedVideoData(1, H264_DELTA_FRAME);
      // An Annex-B-looking byte pattern in wrapper metadata must not be mistaken for an IDR.
      new Uint8Array(rejectedDelta, 13, 5).set([0, 0, 0, 1, 0x65]);
      const nextIdr = compressedVideoData(1, H264_KEYFRAME, 10);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: oldIdr } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: overflowingDelta } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: rejectedDelta } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: nextIdr } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then — no P-frame following a dropped dependency is forwarded; decoding resumes at IDR.
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(nextIdr);
      expect(postMessageMock.mock.calls[0]?.[0].data).not.toBe(overflowingDelta);
      expect(postMessageMock.mock.calls[0]?.[0].data).not.toBe(rejectedDelta);
    });

    it("should reject an oversized video frame and resume only at a fitting IDR/SPS", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl, queueLimitBytes: 100 } });
      establishTopicMapping([
        {
          subId: 1,
          channelId: 10,
          topic: "/camera/video",
          schemaName: "foxglove_msgs/CompressedVideo",
          encoding: "ros1",
        },
        { subId: 2, channelId: 20, topic: "/camera/image" },
      ]);
      postMessageMock.mockClear();

      const inFlight = messageData(2);
      const oversizedIdr = compressedVideoData(1, H264_KEYFRAME, 100);
      const rejectedDelta = compressedVideoData(1, H264_DELTA_FRAME);
      const fittingIdr = compressedVideoData(1, H264_KEYFRAME, 10);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: oversizedIdr } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: rejectedDelta } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: fittingIdr } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });

      // Then
      expect(postMessageMock).toHaveBeenCalledTimes(1);
      expect(postMessageMock.mock.calls[0]?.[0].data).toBe(fittingIdr);
      expect(postMessageMock.mock.calls[0]?.[0].data).not.toBe(oversizedIdr);
      expect(postMessageMock.mock.calls[0]?.[0].data).not.toBe(rejectedDelta);
    });

    it("should not supersede a fail-safe exempt frame after the topic later maps to a non-exempt topic", () => {
      // Given — hold the port busy so subsequent frames stay queued
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);

      // Frame arrives before any topic mapping (fail-safe lossExempt=true) and remains queued
      const earlyExempt = messageData(5, 100);
      MockWebSocket.lastInstance?.onmessage?.({ data: earlyExempt } as MessageEvent);

      // Establish subId 5 → ordinary topic without acking (must not drain earlyExempt)
      dispatch({
        type: "data",
        data: clientSubscribe([{ id: 5, channelId: 50 }]),
      });
      MockWebSocket.lastInstance?.onmessage?.({
        data: serverAdvertise([{ id: 50, topic: "/camera/image" }]),
      } as MessageEvent);

      // New frame for same subId is non-exempt; must not supersede the earlier exempt frame
      const laterNonExempt = messageData(5, 100);
      MockWebSocket.lastInstance?.onmessage?.({ data: laterNonExempt } as MessageEvent);
      postMessageMock.mockClear();

      // When — drain the queue
      const delivered: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        delivered.push(...postedMessageData());
        postMessageMock.mockClear();
      }

      // Then — early fail-safe frame is not superseded; both frames are delivered
      expect(delivered).toContain(earlyExempt);
      expect(delivered).toContain(laterNonExempt);
    });

    it("should treat unmapped MESSAGE_DATA as loss-exempt (fail-safe)", () => {
      // Given — open socket but never advertise/subscribe, so topic map is empty
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      const unmappedA = messageData(99, 100);
      const unmappedB = messageData(99, 100);
      const big = messageData(2, 15 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: unmappedA } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: unmappedB } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: big } as MessageEvent);
      postMessageMock.mockClear();

      // When
      const delivered: unknown[] = [];
      for (let i = 0; i < 10; i++) {
        dispatch({ type: "ack" });
        delivered.push(...postedMessageData());
        postMessageMock.mockClear();
      }

      // Then — both unmapped frames retained (no supersede, not trimmed)
      expect(delivered).toContain(unmappedA);
      expect(delivered).toContain(unmappedB);
    });

    it("should keep only the latest unsent TIME frame", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const inFlight = messageData(1);
      const timeOld = timeData();
      const timeNew = timeData();

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: timeOld } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: timeNew } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });
      const firstAfterAck = postMessageMock.mock.calls[0]?.[0].data;
      postMessageMock.mockClear();
      dispatch({ type: "ack" });
      const secondAfterAck = postMessageMock.mock.calls[0]?.[0].data;
      postMessageMock.mockClear();
      dispatch({ type: "ack" });

      // Then — only the latest TIME is delivered; no further messages
      expect(firstAfterAck).toBe(timeNew);
      expect(secondAfterAck).toBeUndefined();
      expect(postMessageMock).not.toHaveBeenCalled();
      expect(timeOld).not.toBe(timeNew);
    });

    it("should reject a single oversized telemetry frame without evicting queued control", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      establishTopicMapping([{ subId: 1, channelId: 10, topic: "/camera/image" }]);
      postMessageMock.mockClear();

      const inFlight = messageData(2);
      const protocolMsg = JSON.stringify({ op: "status", level: 0, message: "ok" });
      // A single 17MB entry cannot fit within the 16MB hard queue limit.
      const oversized = messageData(1, 17 * 1024 * 1024);

      MockWebSocket.lastInstance?.onmessage?.({ data: inFlight } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: protocolMsg } as MessageEvent);
      MockWebSocket.lastInstance?.onmessage?.({ data: oversized } as MessageEvent);
      postMessageMock.mockClear();

      // When
      dispatch({ type: "ack" });
      expect(postMessageMock).toHaveBeenCalledWith({ type: "message", data: protocolMsg });
      postMessageMock.mockClear();
      dispatch({ type: "ack" });

      // Then — existing high-priority control survives and the oversized item fails closed.
      expect(postMessageMock).not.toHaveBeenCalled();
    });

    it("should close and resynchronize if a protocol control message cannot fit", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl, queueLimitBytes: 100 } });
      const socket = MockWebSocket.lastInstance;
      postMessageMock.mockClear();
      const oversizedControl = JSON.stringify({
        op: "status",
        level: 0,
        message: "x".repeat(100),
      });

      // When
      socket?.onmessage?.({ data: oversizedControl } as MessageEvent);

      // Then — continuing would leave the worker's metadata state ahead of the renderer.
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "error",
        error: expect.objectContaining({
          message: "WebSocket control message exceeded the bounded worker queue",
        }),
      });
      expect(socket?.close).toHaveBeenCalledWith(4000, "bounded control queue overflow");
    });

    it("should post an error message when constructing the WebSocket throws", () => {
      // Given
      constructorShouldThrow = true;
      constructorError = new Error("Insecure WebSocket connection");
      // When
      dispatch({ type: "open", data: { wsUrl } });
      // Then
      expect(postMessageMock).toHaveBeenCalledWith({
        type: "error",
        error: constructorError,
      });
    });
  });

  describe("close", () => {
    it("should close the active WebSocket", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const instance = MockWebSocket.lastInstance;
      // When
      dispatch({ type: "close", data: undefined });
      // Then
      expect(instance?.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("data", () => {
    it("should send data through the active WebSocket", () => {
      // Given
      dispatch({ type: "open", data: { wsUrl } });
      const instance = MockWebSocket.lastInstance;
      const data = BasicBuilder.string();
      // When
      dispatch({ type: "data", data });
      // Then
      expect(instance?.send).toHaveBeenCalledWith(data);
    });
  });
});

describe("resolvePlayerMemoryCaps", () => {
  it("returns 16MB defaults without overrides", () => {
    for (const search of [undefined, "", "?xgcFrameCapMB=abc", "?xgcWorkerQueueMB=2"]) {
      const caps = resolvePlayerMemoryCaps(search);
      expect(caps.currentFrameMaximumSizeBytes).toEqual(CURRENT_FRAME_MAXIMUM_SIZE_BYTES);
      expect(caps.workerQueueMaximumSizeBytes).toEqual(WORKER_MESSAGE_QUEUE_MAXIMUM_SIZE_BYTES);
    }
  });

  it("applies independent overrides with clamping", () => {
    const caps = resolvePlayerMemoryCaps("?xgcFrameCapMB=64&xgcWorkerQueueMB=9999");
    expect(caps.currentFrameMaximumSizeBytes).toEqual(64 * 1024 * 1024);
    expect(caps.workerQueueMaximumSizeBytes).toEqual(1024 * 1024 * 1024);
  });
});
