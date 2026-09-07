// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const os = require("node:os");

const { route } = require("./baseline.cjs");
const { load, queuePath, queueBlob } = require("./load.cjs");

const { compileMessageDispatch, dispatchMessages } = load(
  "packages/suite-base/src/components/MessagePipeline/messageDispatch.ts",
);
const Before = load(queuePath, queueBlob).LiveMessageQueue;
const After = load(queuePath).LiveMessageQueue;
const only = process.argv.find((arg) => arg.startsWith("--only="))?.split("=")[1];
const warmups = 5,
  sampleCount = 15;
function measure(fn) {
  for (let i = 0; i < warmups; i++) {
    fn();
  }
  global.gc?.();
  const samples = [];
  const cpu = process.cpuUsage();
  for (let i = 0; i < sampleCount; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  const cpuTime = process.cpuUsage(cpu);
  samples.sort((a, b) => a - b);
  return {
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
    cpuMicroseconds: cpuTime.user + cpuTime.system,
    samplesMs: samples,
  };
}
function pair(before, after) {
  return {
    before: only === "after" ? undefined : measure(before),
    after: only === "before" ? undefined : measure(after),
  };
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
for (const panels of [2, 12, 48]) {
  routing.push(routingCase(panels, "identical"));
}
routing.push(routingCase(48, "distinct"), routingCase(12, "sparse"));
function queueCase(count, kind) {
  const cap = kind === "pressure" ? 512 : count * 64;
  const entries = Array.from({ length: count }, (_, i) => ({
    value: i,
    sizeInBytes: 64,
    key: kind === "supersede" ? "/latest" : `/key/${i % 16}`,
    retention: kind === "supersede" ? "replaceable" : "protected",
  }));
  const fn = (Queue) => () => {
    const queue = new Queue(cap);
    let dropped = 0;
    for (const entry of entries) {
      dropped += queue.enqueue(entry, {
        supersedeReplaceable: kind === "supersede",
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
  return { count, kind, ...pair(before, after) };
}
const queue = [
  queueCase(1000, "batch"),
  queueCase(5000, "batch"),
  queueCase(10000, "batch"),
  queueCase(10000, "supersede"),
  queueCase(2000, "pressure"),
];
const result = {
  baselineCommit: "b3cd154046d0ad17596faacb6db244b6bb32c3dd",
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
if (process.argv.includes("--check")) {
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
