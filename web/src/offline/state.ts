// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { sha256 as hashSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  parseTracks,
  parseFrozenModels,
  validFrozenResourceType,
  type Track,
  type FrozenModel,
} from "./scene";
import { assetPath, nanos, record, requireValue, type Asset } from "./validation";

export { assetPath, nanos, record, requireValue, type Asset } from "./validation";

export type FramePlan = {
  snapshotSha256: string;
  frameIndex: number;
  targetTimeNs: string;
  sourceFrameId: string;
  cameraTimeNs: string;
  width: number;
  height: number;
};
export type Time = { sec: number; nsec: number };
export type CameraFrame = {
  sourceFrameId: string;
  logTimeNs: string;
  cameraTimeNs: string;
  renderTimeNs?: string;
  width: number;
  height: number;
  format: "jpeg" | "png";
  header: { seq?: number; frame_id: string; stamp: Time };
  asset: Asset;
  sourceEncoding?: {
    codec: "h264";
    accessUnitSha256: string;
    accessUnitSize: number;
    decodeIndex: number;
  };
};
export type Snapshot = {
  schema: string;
  version: number;
  bagStartNs: string;
  recipe: {
    source: { cameraTopic: string; messageType?: string };
    interval: { startNs: string; endNs: string };
    output: { width: number; height: number; fps: number };
  };
  policy: { maxFrameAgeNs: string; tfLookaheadNs: string };
  topics: { name: string; schemaName: string }[];
  cameraFrames: CameraFrame[];
  events: Asset;
  rendererConfig: unknown;
  tracks?: Track[];
  models?: FrozenModel[];
};
export type SnapshotEvent = {
  timeNs: string;
  role: "data" | "tf" | "tf-static";
  event: {
    topic: string;
    schemaName: string;
    receiveTime: Time;
    message: unknown;
    sizeInBytes: number;
  };
};
export function rosNanos(value: Time): bigint {
  requireValue(
    Number.isSafeInteger(value.sec) &&
      value.sec >= 0 &&
      Number.isInteger(value.nsec) &&
      value.nsec >= 0 &&
      value.nsec < 1e9,
    "Invalid ROS time",
  );
  return BigInt(value.sec) * 1_000_000_000n + BigInt(value.nsec);
}
export async function digest(bytes: ArrayBuffer): Promise<string> {
  // WebCrypto is absent on HTTP LAN origins. Integrity is still mandatory there.
  const subtle = (globalThis as { crypto?: Partial<Crypto> }).crypto?.subtle;
  const result =
    subtle != undefined
      ? new Uint8Array(await subtle.digest("SHA-256", bytes))
      : hashSha256(new Uint8Array(bytes));
  return bytesToHex(result);
}
export async function verifiedFetch(
  url: URL,
  sha256: string,
  maximum: number,
): Promise<ArrayBuffer> {
  requireValue(
    url.origin === location.origin && !url.username && !url.password,
    "Cross-origin snapshot denied",
  );
  const response = await fetch(url, {
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  requireValue(response.ok && response.url === url.href, "Snapshot fetch failed or redirected");
  const length = response.headers.get("Content-Length");
  requireValue(length == undefined || Number(length) <= maximum, "Asset exceeds byte limit");
  const reader = response.body?.getReader();
  requireValue(reader != undefined, "Missing response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      requireValue(size <= maximum, "Asset exceeds byte limit");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  requireValue((await digest(bytes.buffer)) === sha256, "Snapshot asset hash mismatch");
  return bytes.buffer;
}
export function parseSnapshot(value: unknown): Snapshot {
  requireValue(
    record(value) && value.schema === "xgc2.video-snapshot" && value.version === 1,
    "Unsupported snapshot",
  );
  const s = value as unknown as Snapshot;
  s.tracks = parseTracks(s.tracks);
  s.models = parseFrozenModels(s.models, s.tracks);
  nanos(s.bagStartNs);
  nanos(s.recipe.interval.startNs);
  nanos(s.recipe.interval.endNs);
  requireValue(
    s.recipe.output.width === 3840 &&
      s.recipe.output.height === 2160 &&
      [24, 25, 30, 50, 60].includes(s.recipe.output.fps),
    "Unsupported output",
  );
  requireValue(nanos(s.recipe.interval.endNs) > nanos(s.recipe.interval.startNs), "Empty clip");
  requireValue(
    nanos(s.policy.maxFrameAgeNs) > 0n &&
      nanos(s.policy.maxFrameAgeNs) <= 1_000_000_000n &&
      nanos(s.policy.tfLookaheadNs) <= 1_000_000_000n,
    "Invalid source time policy",
  );
  requireValue(
    Array.isArray(s.topics) &&
      s.topics.length <= 256 &&
      Array.isArray(s.cameraFrames) &&
      s.cameraFrames.length > 0 &&
      s.cameraFrames.length <= 100000,
    "Invalid source index",
  );
  let log = -1n,
    sample = -1n,
    rendered = -1n;
  let decoded = -1;
  const ids = new Set<string>();
  for (const f of s.cameraFrames) {
    requireValue(
      typeof f.sourceFrameId === "string" &&
        !ids.has(f.sourceFrameId) &&
        nanos(f.logTimeNs) > log &&
        nanos(f.cameraTimeNs) > sample &&
        nanos(f.cameraTimeNs) > 0n,
      "Camera index is not strictly increasing",
    );
    const renderTime = nanos(f.renderTimeNs ?? f.logTimeNs);
    const recordTime = nanos(f.logTimeNs);
    requireValue(
      renderTime > rendered &&
        (renderTime > recordTime ? renderTime - recordTime : recordTime - renderTime) <=
          1_000_000_000n,
      "Invalid mapped camera timestamp",
    );
    rendered = renderTime;
    ids.add(f.sourceFrameId);
    log = nanos(f.logTimeNs);
    sample = nanos(f.cameraTimeNs);
    requireValue(
      f.width === 3840 &&
        f.height === 2160 &&
        ["jpeg", "png"].includes(f.format) &&
        rosNanos(f.header.stamp) === sample &&
        Boolean(f.header.frame_id),
      "Invalid camera frame",
    );
    const encoding: unknown = f.sourceEncoding;
    if (s.recipe.source.messageType === "foxglove_msgs/CompressedVideo") {
      requireValue(
        record(encoding) &&
          Object.keys(encoding).every((key) =>
            ["codec", "accessUnitSha256", "accessUnitSize", "decodeIndex"].includes(key),
          ) &&
          encoding.codec === "h264" &&
          typeof encoding.accessUnitSha256 === "string" &&
          /^[a-f0-9]{64}$/.test(encoding.accessUnitSha256) &&
          typeof encoding.accessUnitSize === "number" &&
          Number.isSafeInteger(encoding.accessUnitSize) &&
          encoding.accessUnitSize > 0 &&
          encoding.accessUnitSize <= 8 * 1024 * 1024 &&
          typeof encoding.decodeIndex === "number" &&
          Number.isSafeInteger(encoding.decodeIndex) &&
          encoding.decodeIndex > decoded &&
          encoding.decodeIndex < 100000 &&
          f.format === "png" &&
          f.asset.path.endsWith(".png"),
        "Invalid H264 decode evidence",
      );
      decoded = encoding.decodeIndex;
    } else {
      requireValue(typeof encoding === "undefined", "Unexpected camera decode evidence");
    }
    assetPath(f.asset);
  }
  assetPath(s.events);
  requireValue(s.events.size <= 256 * 1024 * 1024, "Event history exceeds limit");
  return s;
}

export async function fetchFrozenModelAsset(
  models: readonly FrozenModel[],
  base: URL,
  uri: string,
): Promise<{ uri: string; data: Uint8Array; mediaType: string }> {
  const model = models.find((item) => uri === `https://xgc2.invalid/${item.asset.sha256}.urdf`);
  const resource = models.flatMap((item) => item.resources ?? []).find((item) => item.uri === uri);
  const asset = model?.asset ?? resource?.asset;
  requireValue(asset != undefined, "Asset is not in the frozen model closure");
  const bytes = await verifiedFetch(new URL(assetPath(asset), base), asset.sha256, asset.size);
  requireValue(bytes.byteLength === asset.size, "Frozen model asset size mismatch");
  if (model != undefined) {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    requireValue(
      record(value) &&
        value.modelId === model.modelId &&
        typeof value.urdf === "string" &&
        (model.bundleSha256 == undefined || value.bundleSha256 === model.bundleSha256),
      "Invalid frozen model asset",
    );
    return { uri, data: new TextEncoder().encode(value.urdf), mediaType: "application/xml" };
  }
  requireValue(resource != undefined, "Missing frozen model resource");
  requireValue(
    validFrozenResourceType(uri, asset, resource.mediaType),
    "Invalid model resource type",
  );
  // Native ModelCache recognizes GLB magic before consulting the declared type.
  // Keep controlled meshes on its Collada path, whose texture loads use this owner.
  requireValue(
    (bytes.byteLength < 4 || new DataView(bytes).getUint32(0, false) !== 0x676c5446) &&
      (resource.mediaType !== "model/vnd.collada+xml" ||
        new TextDecoder().decode(bytes).trimStart().startsWith("<")),
    "Invalid model resource format",
  );
  return { uri, data: new Uint8Array(bytes), mediaType: resource.mediaType };
}
export function selectFrame(snapshot: Snapshot, plan: FramePlan, sha256: string): CameraFrame {
  const r = snapshot.recipe,
    count = (nanos(r.interval.endNs) - nanos(r.interval.startNs)) * BigInt(r.output.fps);
  requireValue(
    plan.snapshotSha256 === sha256 &&
      Number.isSafeInteger(plan.frameIndex) &&
      plan.frameIndex >= 0 &&
      BigInt(plan.frameIndex) < (count + 999999999n) / 1000000000n &&
      plan.width === 3840 &&
      plan.height === 2160,
    "Invalid frame request",
  );
  const target =
    nanos(r.interval.startNs) + (BigInt(plan.frameIndex) * 1000000000n) / BigInt(r.output.fps);
  requireValue(nanos(plan.targetTimeNs) === target, "Output time/index mismatch");
  const absolute = nanos(snapshot.bagStartNs) + target;
  let low = 0,
    high = snapshot.cameraFrames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (
      nanos(
        snapshot.cameraFrames[middle]!.renderTimeNs ?? snapshot.cameraFrames[middle]!.logTimeNs,
      ) <= absolute
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const frame = snapshot.cameraFrames[low - 1];
  requireValue(
    frame != undefined &&
      absolute - nanos(frame.renderTimeNs ?? frame.logTimeNs) <=
        nanos(snapshot.policy.maxFrameAgeNs),
    "Camera gap",
  );
  requireValue(
    frame.sourceFrameId === plan.sourceFrameId && frame.cameraTimeNs === plan.cameraTimeNs,
    "Source frame mapping mismatch",
  );
  return frame;
}
export function parseEvents(value: unknown, topics: Snapshot["topics"]): SnapshotEvent[] {
  requireValue(Array.isArray(value) && value.length <= 500000, "Invalid event history");
  const schemas = new Set([
    "tf2_msgs/TFMessage",
    "sensor_msgs/CameraInfo",
    "nav_msgs/Path",
    "visualization_msgs/Marker",
    "visualization_msgs/MarkerArray",
  ]);
  const declared = new Map(topics.map((t) => [t.name, t.schemaName]));
  let previous = -1n;
  for (const row of value as SnapshotEvent[]) {
    requireValue(record(row) && record(row.event), "Invalid event");
    const time = nanos(row.timeNs);
    requireValue(time >= previous, "Unsorted event history");
    previous = time;
    requireValue(
      ["data", "tf", "tf-static"].includes(row.role) &&
        schemas.has(row.event.schemaName) &&
        declared.get(row.event.topic) === row.event.schemaName,
      "Unsupported/undeclared event",
    );
    requireValue(
      (row.role === "data") === (row.event.schemaName !== "tf2_msgs/TFMessage"),
      "Event role/schema mismatch",
    );
    rosNanos(row.event.receiveTime);
    requireValue(record(row.event.message), "Invalid message");
    const msg = row.event.message;
    const markers =
      row.event.schemaName === "visualization_msgs/MarkerArray"
        ? msg.markers
        : row.event.schemaName === "visualization_msgs/Marker"
          ? [msg]
          : [];
    requireValue(Array.isArray(markers), "Invalid markers");
    for (const marker of markers) {
      requireValue(
        record(marker) &&
          marker.type !== 10 &&
          (marker.mesh_resource == undefined || marker.mesh_resource === ""),
        "Mesh asset loading is not supported in V1",
      );
    }
  }
  return value as SnapshotEvent[];
}
