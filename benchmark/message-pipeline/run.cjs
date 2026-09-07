// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const { route } = require("./baseline.cjs");
const { load, queuePath, queueBlob } = require("./load.cjs");
const { measurePair, parseOptions } = require("./measurement.cjs");

const options = parseOptions(process.argv.slice(2));
const { warmups, sampleCount } = options;

const { compileMessageDispatch, dispatchMessages } = load(
  "packages/suite-base/src/components/MessagePipeline/messageDispatch.ts",
);
const Before = load(queuePath, queueBlob).LiveMessageQueue;
const After = load(queuePath).LiveMessageQueue;
function pair(before, after) {
  return measurePair(before, after, options);
}
function routingCase(panels, kind) {
  const topics = Array.from({ length: 16 }, (_, i) => `/topic/${i}`);
  const subscriptions = new Map();
  const ids = new Map();
  for (let i = 0; i < panels; i++) {
    const interested =
      kind === "identical"
        ? topics
        : topics.filter((_, j) => (kind === "sparse" ? j === i % 16 : (i & (1 << j)) !== 0));
    subscriptions.set(
      String(i),
      interested.map((topic) => ({ topic })),
    );
    for (const topic of interested) {
      if (!ids.has(topic)) {
        ids.set(topic, []);
      }
      ids.get(topic).push(String(i));
    }
  }
  const messages = Array.from({ length: 20000 }, (_, i) => ({
    topic: topics[i % topics.length],
    value: i,
  }));
  const plan = compileMessageDispatch(subscriptions);
  const previous = new Map(),
    current = new Map();
  const a = route(messages, ids, previous),
    b = dispatchMessages(messages, plan, current);
  assert.deepEqual(b, a);
  assert.deepEqual(current, previous);
  for (const [id, values] of a) {
    values.forEach((v, i) => assert.equal(b.get(id)[i], v));
  }
  function retained(result) {
    const arrays = new Set(result.values());
    return {
      arrays: arrays.size,
      messageReferences: [...arrays].reduce((sum, array) => sum + array.length, 0),
    };
  }
  const timing = pair(
    () => route(messages, ids, previous),
    () => dispatchMessages(messages, plan, current),
  );
  return {
    panels,
    kind,
    messages: messages.length,
    ...timing,
    beforeRetained: retained(a),
    afterRetained: retained(b),
  };
}
const routing = [];
if (!options.stress) {
  for (const panels of [2, 12, 48]) {
    routing.push(routingCase(panels, "identical"));
  }
  routing.push(routingCase(48, "distinct"), routingCase(12, "sparse"));
}
function queueCase(count, kind, cap = kind === "pressure" ? 512 : count * 64) {
  const replaceable = kind.startsWith("supersede");
  const entries = Array.from({ length: count }, (_, i) => ({
    value: i,
    sizeInBytes: 64,
    key: kind === "supersede" ? "/latest" : `/key/${i % 16}`,
    retention: replaceable ? "replaceable" : "protected",
  }));
  const fn = (Queue) => () => {
    const queue = new Queue(cap);
    let dropped = 0;
    for (const entry of entries) {
      dropped += queue.enqueue(entry, {
        supersedeReplaceable: replaceable,
      }).droppedEntries;
    }
    let sum = 0;
    for (let entry; (entry = queue.shift()) != undefined; ) {
      sum += entry.value;
    }
    return { dropped, sum, bytes: queue.getSizeInBytes() };
  };
  const before = fn(Before),
    after = fn(After);
  assert.deepEqual(after(), before());
  return { count, kind, capacityBytes: cap, ...pair(before, after) };
}
function mixedQueueCase() {
  // Synthetic compressed-video/transform/telemetry traffic with a slower consumer. The byte
  // counts are accounting weights, not real camera buffers or a hardware throughput claim.
  const capacityBytes = 65536;
  const entries = Array.from({ length: 4000 }, (_, i) => {
    const frame = Math.floor(i / 4);
    switch (i % 4) {
      case 0:
        return {
          value: i,
          sizeInBytes: 4096,
          key: "/camera",
          retention: "video",
          isVideoRecoveryPoint: frame % 30 === 0,
        };
      case 1:
        return {
          value: i,
          sizeInBytes: 256,
          key: "/tf",
          retention: "protected",
          protectedPriority: "high",
        };
      case 2:
        return { value: i, sizeInBytes: 128, key: "/imu", retention: "protected" };
      default:
        return {
          value: i,
          sizeInBytes: 64,
          key: `/state/${frame % 16}`,
          retention: "replaceable",
        };
    }
  });
  const run = (Queue, capture = false) => {
    const queue = new Queue(capacityBytes);
    const trace = capture ? [] : undefined;
    let dropped = 0;
    let sum = 0;
    let delivered = 0;
    const consume = () => {
      const entry = queue.shift();
      if (entry != undefined) {
        sum += entry.value;
        delivered++;
        trace?.push(["shift", entry.value]);
      }
      return entry;
    };
    for (let index = 0; index < entries.length; index++) {
      const result = queue.enqueue(entries[index], { supersedeReplaceable: true });
      dropped += result.droppedEntries;
      trace?.push(["enqueue", result, queue.getSizeInBytes()]);
      if (capture) {
        assert(queue.getSizeInBytes() <= capacityBytes);
      }
      if ((index + 1) % 16 === 0) {
        for (let n = 0; n < 4; n++) {
          consume();
        }
      }
    }
    while (consume() != undefined) {
      // Drain after the last burst; retain the exact order in the untimed differential trace.
    }
    return { dropped, sum, delivered, bytes: queue.getSizeInBytes(), trace };
  };
  assert.deepEqual(run(After, true), run(Before, true));
  return {
    count: entries.length,
    kind: "mixed-video-protected-telemetry",
    capacityBytes,
    consumer: "4 shifts per 16 arrivals, then drain",
    ...pair(
      () => run(Before),
      () => run(After),
    ),
  };
}
const queue = options.stress
  ? [
      queueCase(2000, "pressure", 512),
      queueCase(2000, "pressure", 4096),
      queueCase(2000, "pressure", 16384),
      queueCase(10000, "supersede"),
      queueCase(10000, "supersede-many"),
      mixedQueueCase(),
    ]
  : [
      queueCase(1000, "batch"),
      queueCase(5000, "batch"),
      queueCase(10000, "batch"),
      queueCase(10000, "supersede"),
      queueCase(2000, "pressure"),
    ];
const result = {
  measurementSchema: 2,
  baselineCommit: "b3cd154046d0ad17596faacb6db244b6bb32c3dd",
  candidateCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
  }).trim(),
  measurementMode: options.only ?? "paired",
  stress: options.stress,
  first: options.first,
  explicitGc: typeof global.gc === "function",
  percentileMethod: "nearest-rank; 15-sample p95 equals maximum",
  gcPolicy: "once after paired warmups; natural GC remains in timed samples",
  node: process.version,
  cpu: os.cpus()[0].model,
  platform: os.platform(),
  arch: os.arch(),
  warmups,
  sampleCount,
  routing,
  queue,
};
console.log(JSON.stringify(result, null, 2));
if (options.check) {
  for (const r of routing) {
    assert(r.afterRetained.messageReferences <= r.beforeRetained.messageReferences);
    if (r.kind === "identical") {
      assert.equal(r.afterRetained.arrays, 1);
    }
  }
  // Wide relative budgets avoid flaky absolute timing gates on shared runners. Exact ordering,
  // identity and allocation checks above are deterministic; publish all timings for review.
  for (const r of routing.filter((r) => r.kind === "identical" && r.panels >= 12)) {
    assert(r.after.medianMs < r.before.medianMs / 2, `routing budget: ${r.panels}`);
  }
  const batch = queue.find((r) => r.count === 10000 && r.kind === "batch");
  assert(batch.after.medianMs < batch.before.medianMs / 2, "queue batch budget");
}
