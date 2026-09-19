// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC Team
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { initSegment, mediaSegment, MEDIA_SOURCE_FRAME_DURATION_US } from "./H264MediaSource";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
// SPS/PPS from an actual libx264 constrained-baseline 3840x2160, no-B stream.
const key = bytes(
  "000000016742c033da00f0010fa10000030001000003003c8f1832a00000000168ce0fc800000001658884",
);
function boxes(data: Uint8Array) {
  const result: { type: string; data: Uint8Array; offset: number }[] = [];
  for (let offset = 0; offset < data.length; ) {
    const size = new DataView(data.buffer, data.byteOffset + offset).getUint32(0);
    if (size < 8 || offset + size > data.length) {
      throw new Error("Invalid ISO box boundary");
    }
    result.push({
      type: String.fromCharCode(...data.subarray(offset + 4, offset + 8)),
      data: data.subarray(offset + 8, offset + size),
      offset,
    });
    offset += size;
  }
  return result;
}

it("uses complete source SPS/PPS and preserves native 4K dimensions", () => {
  const result = initSegment(key);
  expect(result.config).toMatchObject({
    codec: "avc1.42C033",
    codedWidth: 3840,
    codedHeight: 2160,
  });
  expect(boxes(result.bytes).map((box) => box.type)).toEqual(["ftyp", "moov"]);
  const moov = boxes(result.bytes)[1]!;
  expect(boxes(moov.data).map((box) => box.type)).toEqual(["mvhd", "trak", "mvex"]);
  expect(() => initSegment(bytes("00000001658884"))).toThrow(/recovery/);
});

it("uses relative fragment addressing and a contiguous private decode timeline", () => {
  const result = boxes(mediaSegment(key, MEDIA_SOURCE_FRAME_DURATION_US, 2));
  expect(result.map((box) => box.type)).toEqual(["moof", "mdat"]);
  const traf = boxes(result[0]!.data).find((box) => box.type === "traf")!;
  const children = boxes(traf.data);
  const tfdt = children.find((box) => box.type === "tfdt")!.data;
  expect(new DataView(tfdt.buffer, tfdt.byteOffset).getBigUint64(4)).toBe(
    BigInt(MEDIA_SOURCE_FRAME_DURATION_US),
  );
  const trun = children.find((box) => box.type === "trun")!.data;
  const view = new DataView(trun.buffer, trun.byteOffset);
  expect(view.getUint32(8)).toBe(result[1]!.offset + 8);
  expect(view.getUint32(12)).toBe(MEDIA_SOURCE_FRAME_DURATION_US);
  expect(view.getUint32(16)).toBe(result[1]!.data.length);
  expect(view.getUint32(20)).toBe(0x02000000);
});

it("accepts ordered P slices, including late slices in a 4K multi-slice frame", () => {
  // first_mb_in_slice=25200, slice_type=5 (P). A byte reader must not treat
  // repeated reads of a single zero byte as two emulation-prevention zeros.
  expect(() => mediaSegment(bytes("000000014100031389a207"), 0, 1)).not.toThrow();
});

it.each([
  ["0000000141a0", /B frames/],
  ["0000000142ff", /partitioned/],
  ["0000000165", /Truncated/],
  ["658884", /Annex-B/],
  ["0000000168ce0fc80000000141c0", /complete IDR/],
  ["000000010910", /no coded picture/],
])("rejects unsupported or incomplete coded input %s", (input, error) => {
  expect(() => mediaSegment(bytes(input), 0, 1)).toThrow(error);
});

it("rejects non-finite and invalid private sample timelines", () => {
  expect(() => mediaSegment(key, NaN, 1)).toThrow(/timeline/);
  expect(() => mediaSegment(key, -1, 1)).toThrow(/timeline/);
  expect(() => mediaSegment(key, 0, 0)).toThrow(/timeline/);
});
