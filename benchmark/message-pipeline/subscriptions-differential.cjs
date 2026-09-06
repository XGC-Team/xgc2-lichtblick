// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");

const { load } = require("./load.cjs");

const file = "packages/suite-base/src/components/MessagePipeline/subscriptions.ts";
const before = load(file, "c874733d6436db3581334257aa47457b7de4aa14").mergeSubscriptions;
const after = load(file).mergeSubscriptions;
let rng = 17;
const next = () => {
  rng ^= rng << 13;
  rng ^= rng >>> 17;
  rng ^= rng << 5;
  return rng >>> 0;
};
const topics = ["/a", "/b", "2", "1", "/a,b", "constructor"];
const fields = [undefined, [], [""], ["  "], ["a", " b ", "a"], ["b", "c"], ["x"]];
for (let trial = 0; trial < 10000; trial++) {
  const input = Array.from({ length: next() % 40 }, () => ({
    topic: topics[next() % topics.length],
    fields: fields[next() % fields.length],
    preloadType: ["full", "partial", undefined][next() % 3],
    samplingRequest: next() % 2 ? { mode: "latest-per-render-tick" } : undefined,
    samplingAuthorized: next() % 2 ? true : undefined,
  }));
  const snapshot = JSON.stringify(input);
  assert.deepEqual(after(input), before(input), `trial ${trial}`);
  assert.equal(JSON.stringify(input), snapshot, "mutated input");
}
const samples = [];
for (const count of [100, 1000]) {
  const input = Array.from({ length: count }, (_, i) => ({
    topic: "/fields",
    fields: [`field${i}`],
    preloadType: "full",
  }));
  const timing = (fn) => {
    for (let i = 0; i < 3; i++) {
      fn(input);
    }
    const times = [];
    for (let i = 0; i < 9; i++) {
      const t = performance.now();
      fn(input);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return { medianMs: times[4], samplesMs: times };
  };
  assert.deepEqual(after(input), before(input));
  samples.push({ count, before: timing(before), after: timing(after) });
}
console.log(
  JSON.stringify(
    {
      test: "subscription differential",
      cases: 10000,
      status: "passed",
      node: process.version,
      samples,
    },
    null,
    2,
  ),
);
