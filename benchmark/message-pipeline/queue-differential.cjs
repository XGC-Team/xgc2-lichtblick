// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");

const { load, queuePath, queueBlob } = require("./load.cjs");

const Before = load(queuePath, queueBlob).LiveMessageQueue;
const After = load(queuePath).LiveMessageQueue;
let operations = 0;
for (let seed = 1; seed <= 150; seed++) {
  let rng = seed;
  const next = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return rng >>> 0;
  };
  const limits = [0, 1, 128, 1000, Number.MAX_SAFE_INTEGER];
  const sizes = [0, 1, 20, 64, 128, 1001, Number.MAX_SAFE_INTEGER];
  let cap = limits[seed % limits.length];
  const before = new Before(cap),
    after = new After(cap);
  for (let i = 0; i < 1500; i++) {
    const op = next() % 16;
    const key = ["", "/tf", "/camera", "/telemetry", undefined][next() % 5];
    let args, result, actual;
    if (op < 10) {
      const entry = {
        value: { seed, i },
        key,
        sizeInBytes: sizes[next() % sizes.length],
        retention: ["video", "protected", "replaceable"][next() % 3],
        protectedPriority: ["normal", "high", "critical", undefined][next() % 4],
        isVideoRecoveryPoint: next() % 3 === 0,
      };
      args = [entry, { supersedeReplaceable: next() % 2 === 0 }];
      result = before.enqueue(...args);
      actual = after.enqueue(...args);
      // Entries are copied; a caller changing accounting fields must not corrupt the queue.
      entry.sizeInBytes = 17;
      entry.key = "mutated";
    } else if (op === 10) {
      result = before.shift();
      actual = after.shift();
    } else if (op === 11) {
      result = before.drain();
      actual = after.drain();
    } else if (op === 12) {
      result = before.clear();
      actual = after.clear();
    } else if (op === 13) {
      result = before.removeKey(key ?? "");
      actual = after.removeKey(key ?? "");
    } else {
      cap = limits[next() % limits.length];
      result = before.setMaximumSize(cap);
      actual = after.setMaximumSize(cap);
    }
    assert.deepEqual(actual, result, `seed ${seed} operation ${i} (${op})`);
    assert.equal(after.getSizeInBytes(), before.getSizeInBytes());
    assert(after.getSizeInBytes() <= cap);
    const stats = after.getStorageStats();
    assert(stats.allocatedSlots <= Math.max(1024, stats.queuedEntries * 2));
    operations++;
  }
  assert.deepEqual(after.drain(), before.drain());
}
// Exercise compaction thresholds with a large queue and many tombstones.
for (const retention of ["protected", "replaceable", "video"]) {
  const before = new Before(1000000),
    after = new After(1000000);
  for (let i = 0; i < 8000; i++) {
    const entry = {
      value: i,
      sizeInBytes: 1,
      key: String(i % 77),
      retention,
      isVideoRecoveryPoint: true,
    };
    assert.deepEqual(
      after.enqueue(entry, { supersedeReplaceable: i % 3 === 0 }),
      before.enqueue(entry, { supersedeReplaceable: i % 3 === 0 }),
    );
    if (i % 2 === 0) {
      assert.deepEqual(after.shift(), before.shift());
    }
    if (i % 31 === 0) {
      assert.equal(after.removeKey(String(i % 77)), before.removeKey(String(i % 77)));
    }
  }
  assert.deepEqual(after.drain(), before.drain());
  assert.equal(after.getSizeInBytes(), 0);
}
console.log(
  JSON.stringify({
    test: "live queue differential",
    operations,
    compactionWorkloads: 3,
    status: "passed",
  }),
);
