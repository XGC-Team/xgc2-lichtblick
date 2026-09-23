// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Find the index of the next Annex B start code (0x000001 or 0x00000001) in
 * the given buffer, starting at the given offset. Shared between H.264 and
 * H.265 since both formats use the same Annex B framing.
 *
 * Every start code ends in the byte 0x01, so the search jumps between 0x01
 * bytes with the native `indexOf` instead of testing every byte in script.
 * Video frames are scanned on the main thread, and a 4K P-frame is mostly
 * slice payload, where 0x01 is rare. Results match the byte-by-byte scan,
 * which never starts a match after `data.length - 4`.
 *
 * Returns `data.length` if no start code is found.
 */
export function findNextStartCode(data: Uint8Array, start: number): number {
  for (let one = data.indexOf(1, start + 2); one !== -1; one = data.indexOf(1, one + 1)) {
    const startCode = one - 2;
    if (data[one - 1] !== 0 || data[startCode] !== 0) {
      continue;
    }
    // 0x00000001 begins one byte before 0x000001 and always fits before the end of `data`.
    if (startCode > start && data[startCode - 1] === 0) {
      return startCode - 1;
    }
    // A 3-byte start code ending on the last byte is not reported, as before.
    return startCode <= data.length - 4 ? startCode : data.length;
  }
  return data.length;
}

/**
 * Find the index immediately after the next Annex B start code, i.e. the index
 * of the first byte of the NAL unit that follows. Returns `data.length` if no
 * start code is found.
 */
export function findNextStartCodeEnd(data: Uint8Array, start: number): number {
  const startCodeStart = findNextStartCode(data, start);
  if (startCodeStart === data.length) {
    return data.length;
  }
  // 4-byte start code is 0x00000001; otherwise it must be the 3-byte 0x000001.
  const is4Byte =
    startCodeStart + 3 < data.length &&
    data[startCodeStart] === 0 &&
    data[startCodeStart + 1] === 0 &&
    data[startCodeStart + 2] === 0 &&
    data[startCodeStart + 3] === 1;
  return startCodeStart + (is4Byte ? 4 : 3);
}
