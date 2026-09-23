// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { findNextStartCode, findNextStartCodeEnd } from "./utils";

/** The byte-by-byte definition the indexOf search must reproduce exactly. */
function referenceFindNextStartCode(data: Uint8Array, start: number): number {
  let i = start;
  while (i < data.length - 3) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      return i;
    }
    if (
      i + 3 < data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      return i;
    }
    i++;
  }
  return data.length;
}

function referenceFindNextStartCodeEnd(data: Uint8Array, start: number): number {
  const startCodeStart = referenceFindNextStartCode(data, start);
  if (startCodeStart === data.length) {
    return data.length;
  }
  const is4Byte =
    startCodeStart + 3 < data.length &&
    data[startCodeStart] === 0 &&
    data[startCodeStart + 1] === 0 &&
    data[startCodeStart + 2] === 0 &&
    data[startCodeStart + 3] === 1;
  return startCodeStart + (is4Byte ? 4 : 3);
}

function expectSameAtEveryOffset(data: Uint8Array): void {
  for (let start = 0; start <= data.length + 1; start++) {
    expect([start, findNextStartCode(data, start)]).toEqual([
      start,
      referenceFindNextStartCode(data, start),
    ]);
    expect([start, findNextStartCodeEnd(data, start)]).toEqual([
      start,
      referenceFindNextStartCodeEnd(data, start),
    ]);
  }
}

describe("Annex B start code search", () => {
  it.each([
    [[]],
    [[1]],
    [[0, 1]],
    [[0, 0, 1]],
    [[0, 0, 0, 1]],
    [[0, 0, 0, 0, 1]],
    [[0, 0, 1, 0]],
    [[0, 0, 0, 0, 0, 1, 9]],
    [[1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1]],
    [[0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0]],
    [[5, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1]],
  ])("matches the byte-by-byte scan for %j", (bytes) => {
    expectSameAtEveryOffset(new Uint8Array(bytes));
  });

  it("matches the byte-by-byte scan on randomized zero/one-heavy buffers", () => {
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed >> 8;
    };
    for (let round = 0; round < 400; round++) {
      const data = new Uint8Array(next() % 48);
      for (let i = 0; i < data.length; i++) {
        // Mostly 0x00 and 0x01 so every start-code shape and boundary is exercised.
        const r = next() % 8;
        data[i] = r < 4 ? 0 : r < 7 ? 1 : next() & 0xff;
      }
      expectSameAtEveryOffset(data);
    }
  });

  it("walks every NAL unit of an access unit", () => {
    const au = new Uint8Array([
      0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0xce, 0, 0, 1, 0x65, 0x88, 0x84,
    ]);
    const headers: number[] = [];
    for (let i = findNextStartCodeEnd(au, 0); i < au.length; i = findNextStartCodeEnd(au, i)) {
      headers.push(au[i]!);
    }
    expect(headers).toEqual([9, 0x67, 0x68, 0x65]);
  });
});
