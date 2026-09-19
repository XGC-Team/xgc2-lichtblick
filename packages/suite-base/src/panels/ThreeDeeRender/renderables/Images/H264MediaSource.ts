// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { H264, H264NaluType } from "@lichtblick/den/video";
import { SPS } from "@lichtblick/den/video/h264/SPS";
import { findNextStartCode, findNextStartCodeEnd } from "@lichtblick/den/video/utils";

const ascii = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
const u16 = (v: number) => new Uint8Array([v >>> 8, v & 255]);
const u32 = (...v: number[]) => {
  const a = new Uint8Array(v.length * 4);
  const d = new DataView(a.buffer);
  v.forEach((n, i) => {
    d.setUint32(i * 4, n);
  });
  return a;
};
const join = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of a) {
    out.set(b, p);
    p += b.length;
  }
  return out;
};
const box = (type: string, ...payload: Uint8Array[]) =>
  join(u32(8 + payload.reduce((n, b) => n + b.length, 0)), ascii(type), ...payload);
const full = (type: string, flags: number, ...payload: Uint8Array[]) =>
  box(type, u32(flags), ...payload);
const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
/** ISO BMFF initialization for a complete Annex-B AVC recovery point.
 * Only repackages encoded bytes; no transcoding, resize or AR implementation.
 * https://www.w3.org/TR/mse-byte-stream-format-isobmff/
 */
export function initSegment(frame: Uint8Array): {
  config: VideoDecoderConfig;
  bytes: Uint8Array<ArrayBuffer>;
} {
  const config = H264.ParseDecoderConfig(frame);
  const sps = H264.GetFirstNALUOfType(frame, H264NaluType.SPS);
  const pps = H264.GetFirstNALUOfType(frame, H264NaluType.PPS);
  if (!config || !sps || !pps || !H264.IsKeyframe(frame)) {
    throw Error("H264 complete recovery point required");
  }
  const { width, height } = new SPS(sps).cropRect;
  if (
    ![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 65535) ||
    sps.length > 65535 ||
    pps.length > 65535
  ) {
    throw Error("Invalid AVC dimensions or parameter-set size");
  }
  const avcC = box(
    "avcC",
    new Uint8Array([1, sps[1]!, sps[2]!, sps[3]!, 255, 225]),
    u16(sps.length),
    sps,
    new Uint8Array([1]),
    u16(pps.length),
    pps,
  );
  const avc1 = box(
    "avc1",
    new Uint8Array(6),
    u16(1),
    new Uint8Array(16),
    u16(width),
    u16(height),
    u32(0x480000, 0x480000, 0),
    u16(1),
    new Uint8Array(32),
    u16(24),
    u16(65535),
    avcC,
  );
  const stbl = box(
    "stbl",
    full("stsd", 0, u32(1), avc1),
    full("stts", 0, u32(0)),
    full("stsc", 0, u32(0)),
    full("stsz", 0, u32(0, 0)),
    full("stco", 0, u32(0)),
  );
  const minf = box(
    "minf",
    full("vmhd", 1, new Uint8Array(8)),
    box("dinf", full("dref", 0, u32(1), full("url ", 1))),
    stbl,
  );
  const mdia = box(
    "mdia",
    full("mdhd", 0, u32(0, 0, 1000000, 0), u16(0x55c4), u16(0)),
    full("hdlr", 0, u32(0), ascii("vide"), new Uint8Array(12), ascii("VideoHandler\0")),
    minf,
  );
  const trak = box(
    "trak",
    full(
      "tkhd",
      7,
      u32(0, 0, 1, 0, 0),
      new Uint8Array(8),
      new Uint8Array(8),
      matrix,
      u32(width * 65536, height * 65536),
    ),
    mdia,
  );
  const moov = box(
    "moov",
    full(
      "mvhd",
      0,
      u32(0, 0, 1000000, 0, 0x10000),
      u16(0x100),
      new Uint8Array(10),
      matrix,
      new Uint8Array(24),
      u32(2),
    ),
    trak,
    box("mvex", full("trex", 0, u32(1, 1, 0, 0, 0))),
  );
  return {
    config,
    bytes: join(box("ftyp", ascii("isom"), u32(512), ascii("isomiso6avc1mp41")), moov),
  };
}
// Only the first_mb_in_slice and slice_type Exp-Golomb fields are needed.
// Account for emulation-prevention bytes at byte boundaries, not per bit.
function readSliceType(nal: Uint8Array): number {
  let offset = 1,
    remaining = 0,
    byte = 0;
  const bit = () => {
    if (remaining === 0) {
      if (nal[offset] === 3 && offset >= 3 && nal[offset - 1] === 0 && nal[offset - 2] === 0) {
        offset++;
      }
      if (offset >= nal.length) {
        throw new Error("Truncated H264 slice header");
      }
      byte = nal[offset++]!;
      remaining = 8;
    }
    return (byte >> --remaining) & 1;
  };
  const ue = () => {
    let zeros = 0;
    while (bit() === 0) {
      if (++zeros > 31) {
        throw new Error("Invalid H264 slice header");
      }
    }
    let value = 1;
    for (let i = 0; i < zeros; i++) {
      value = value * 2 + bit();
    }
    return value - 1;
  };
  ue();
  return ue();
}

// A private contiguous decode timeline avoids MSE gaps on irregular ROS clocks.
// The paused HTMLVideo decoder returns each frame with its original ROS timestamp.
// There is no playback clock, interpolation, frame-rate conversion or B-frame reorder.
export const MEDIA_SOURCE_FRAME_DURATION_US = 33333;
export function mediaSegment(frame: Uint8Array, ts: number, seq: number): Uint8Array<ArrayBuffer> {
  if (!H264.IsAnnexB(frame)) {
    throw Error("MSE H264 requires Annex-B access units");
  }
  if (
    !Number.isSafeInteger(ts) ||
    ts < 0 ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    seq > 0xffffffff
  ) {
    throw Error("Invalid MSE decode timeline");
  }
  const duration = MEDIA_SOURCE_FRAME_DURATION_US;
  const key = H264.IsKeyframe(frame);
  const nals: Uint8Array[] = [];
  let hasSlice = false;
  for (let i = findNextStartCodeEnd(frame, 0); i < frame.length; ) {
    const end = findNextStartCode(frame, i);
    const nal = frame.subarray(i, end);
    if (nal.length > 0) {
      const type = nal[0]! & 31;
      if (!key && (type === H264NaluType.SPS || type === H264NaluType.PPS)) {
        throw new Error("MSE H264 parameter changes require a complete IDR");
      }
      if (type === 1 || type === 5) {
        hasSlice = true;
        const sliceType = readSliceType(nal);
        if (sliceType > 9 || sliceType % 5 === 1) {
          throw Error("MSE H264 supports ordered I/P frames, not B frames");
        }
      } else if (type >= 2 && type <= 4) {
        throw Error("MSE H264 does not support partitioned slices");
      }
      nals.push(u32(nal.length), nal);
    }
    i = findNextStartCodeEnd(frame, end);
  }
  if (!hasSlice) {
    throw new Error("H264 access unit has no coded picture");
  }
  const sample = join(...nals);
  const traf = (offset: number) =>
    box(
      "traf",
      full("tfhd", 0x20000, u32(1)),
      full("tfdt", 0x1000000, u32(Math.floor(ts / 4294967296), ts >>> 0)),
      full("trun", 0x701, u32(1, offset, duration, sample.length, key ? 0x02000000 : 0x01010000)),
    );
  const mfhd = full("mfhd", 0, u32(seq));
  let moof = box("moof", mfhd, traf(0));
  moof = box("moof", mfhd, traf(moof.length + 8));
  return join(moof, box("mdat", sample));
}
