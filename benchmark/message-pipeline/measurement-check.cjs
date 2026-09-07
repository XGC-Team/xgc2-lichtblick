// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { measurePair, parseOptions } = require("./measurement.cjs");

function fixture(args, beforeDuration = () => 2, afterDuration = () => 1) {
  const options = parseOptions(args);
  const events = [];
  let time = 0;
  const result = measurePair(
    () => {
      events.push("before");
      time += beforeDuration();
    },
    () => {
      events.push("after");
      time += afterDuration();
    },
    options,
    {
      now: () => time,
      gc: () => {
        events.push("gc");
        time += 1000;
      },
      cpuUsage: () => ({ user: 2, system: 1 }),
    },
  );
  return { events, result };
}

test("alternates both warmups and paired samples; GC stays outside timings", () => {
  const { events, result } = fixture(["--samples=4", "--warmups=2"]);
  assert.deepEqual(events, [
    "before",
    "after",
    "after",
    "before",
    "gc",
    "before",
    "after",
    "after",
    "before",
    "before",
    "after",
    "after",
    "before",
  ]);
  assert.deepEqual(result.sampleOrder, ["before,after", "after,before", "before,after", "after,before"]);
  assert.deepEqual(result.before.samplesInOrderMs, [2, 2, 2, 2]);
  assert.deepEqual(result.after.samplesInOrderMs, [1, 1, 1, 1]);
  assert.equal(result.before.cpuMicroseconds, 12);
});

test("reverses the first pair without changing counts", () => {
  const { result } = fixture(["--samples=4", "--warmups=0", "--first=after"]);
  assert.deepEqual(result.sampleOrder, ["after,before", "before,after", "after,before", "before,after"]);
  assert.equal(result.before.samplesMs.length, 4);
  assert.equal(result.after.samplesMs.length, 4);
});

test("retains raw order and computes nearest-rank p95 without dropping outliers", () => {
  let duration = 101;
  const { result } = fixture(["--samples=100", "--warmups=0"], () => --duration);
  assert.deepEqual(
    result.before.samplesInOrderMs,
    Array.from({ length: 100 }, (_, i) => 100 - i),
  );
  assert.deepEqual(
    result.before.samplesMs,
    Array.from({ length: 100 }, (_, i) => i + 1),
  );
  assert.equal(result.before.p95Ms, 95);
  assert.equal(result.before.maxMs, 100);
  assert.equal(result.before.medianMs, 51);
});

test("the legacy 15-sample nearest-rank p95 is explicitly still the maximum", () => {
  let duration = 0;
  const { result } = fixture(["--samples=15", "--warmups=0"], () => ++duration);
  assert.equal(result.before.p95Ms, 15);
  assert.equal(result.before.maxMs, 15);
});

test("single-variant profiles do not invoke the other timed function", () => {
  for (const variant of ["before", "after"]) {
    const { events, result } = fixture([`--only=${variant}`, "--samples=3", "--warmups=1"]);
    assert.deepEqual(events, [variant, "gc", variant, variant, variant]);
    assert.equal(result[variant === "before" ? "after" : "before"], undefined);
  }
});

test("rejects malformed, duplicate, unbounded and budget-skipping options", () => {
  for (const args of [
    ["--samples=0"],
    ["--samples=-1"],
    ["--samples=1.5"],
    ["--samples=1001"],
    ["--warmups=101"],
    ["--samples=NaN"],
    ["--samples"],
    ["--only=typo"],
    ["--first=other"],
    ["--samples=3=4"],
    ["--samples=3", "--samples=4"],
    ["--stress=false"],
    ["--check", "--stress"],
    ["--check", "--only=before"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseOptions(args), undefined, args.join(" "));
  }
  assert.equal(parseOptions(["--samples=1000", "--warmups=0"]).sampleCount, 1000);
});

test("propagates workload failures instead of returning a successful measurement", () => {
  assert.throws(
    () =>
      measurePair(
        () => {
          throw new Error("workload failure");
        },
        () => {},
        parseOptions(["--warmups=0"]),
        { gc: () => {} },
      ),
    /workload failure/,
  );
});
