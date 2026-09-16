// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0

import { compare } from "@lichtblick/rostime";
import { MessageEvent } from "@lichtblick/suite-base/players/types";

import { mergeScriptMessages } from "./mergeScriptMessages";

function message(nsec: number, topic = "/input", sec = 1): MessageEvent {
  return {
    topic,
    receiveTime: { sec, nsec },
    schemaName: "pose",
    sizeInBytes: 64,
    message: { orientation: { x: 0, y: 0, z: 0.6, w: 0.8 } },
  };
}

describe("mergeScriptMessages", () => {
  it("reuses sorted input without losing duplicate samples or modifying payloads", () => {
    const first = message(1);
    const second = message(1, "/other");
    const input = Object.freeze([first, second, first, message(2)]);
    expect(mergeScriptMessages(input, [], [])).toBe(input);
    expect(input[0]?.message).toBe(first.message);
    expect(input).toHaveLength(4);
  });

  it("reuses empty and singleton frames", () => {
    const empty = Object.freeze([]);
    const single = Object.freeze([message(7)]);
    expect(mergeScriptMessages(empty, [], [])).toBe(empty);
    expect(mergeScriptMessages(single, [], [])).toBe(single);
  });

  it("sorts a copy of unordered input and preserves equal-time order", () => {
    const late = message(9);
    const first = message(1, "/first");
    const second = message(1, "/second");
    const input = Object.freeze([late, first, second, first]);
    const result = mergeScriptMessages(input, [], []);
    expect(result).toEqual([first, second, first, late]);
    expect(result).not.toBe(input);
    expect(input).toEqual([late, first, second, first]);
    expect(result[0]).toBe(first);
    expect(result[3]).toBe(late);
  });

  it("uses seconds and nanoseconds, including a one-nanosecond inversion", () => {
    const a = message(999_999_999, "/input", 1_000_000_000);
    const b = message(0, "/input", 1_000_000_001);
    const c = message(1, "/input", 1_000_000_001);
    expect(mergeScriptMessages([c, b, a], [], [])).toEqual([a, b, c]);
  });

  it("keeps source-before-recomputed-before-computed ties and all derived messages", () => {
    const source = message(5, "/source");
    const recomputed = message(5, "/recomputed");
    const computed = message(5, "/computed");
    const older = message(0, "/recomputed");
    const input = Object.freeze([source]);
    const replay = Object.freeze([recomputed, older]);
    const derived = Object.freeze([computed]);
    expect(mergeScriptMessages(input, replay, derived)).toEqual([
      older,
      source,
      recomputed,
      computed,
    ]);
    expect(replay).toEqual([recomputed, older]);
    expect(mergeScriptMessages([], replay, [])).toEqual([older, recomputed]);
  });

  it("matches the previous merge/sort for deterministic mixed frames", () => {
    let seed = 17;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let run = 0; run < 200; run++) {
      const input = Array.from({ length: run % 41 }, () => message(random() % 13));
      const replay = run % 3 === 0 ? [message(random() % 13, "/recomputed")] : [];
      const derived = run % 4 === 0 ? [message(random() % 13, "/computed")] : [];
      const expected = input
        .concat(replay)
        .concat(derived)
        .sort((a, b) => compare(a.receiveTime, b.receiveTime));
      const result = mergeScriptMessages(input, replay, derived);
      expect(result).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(result[i]).toBe(expected[i]);
      }
    }
  });

  it("handles a large frame without argument spreading or sample loss", () => {
    const input = Array.from({ length: 200_000 }, (_, i) => message(i));
    expect(mergeScriptMessages(input, [], [])).toBe(input);
    const derived = message(input.length, "/computed");
    const result = mergeScriptMessages(input, [], [derived]);
    expect(result).toHaveLength(input.length + 1);
    for (let i = 0; i < input.length; i++) {
      if (result[i] !== input[i]) {
        throw new Error(`Missing or reordered sample at ${i}`);
      }
    }
    expect(result[input.length]).toBe(derived);
  });
});
