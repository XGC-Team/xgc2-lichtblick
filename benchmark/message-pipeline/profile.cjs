// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const fs = require("node:fs");
const inspector = require("node:inspector");
const path = require("node:path");
const { promisify } = require("node:util");

const { route } = require("./baseline.cjs");
const { load, queuePath, queueBlob } = require("./load.cjs");

const { compileMessageDispatch, dispatchMessages } = load(
  "packages/suite-base/src/components/MessagePipeline/messageDispatch.ts",
);
const before = process.argv.includes("--before");
const Queue = load(queuePath, before ? queueBlob : undefined).LiveMessageQueue;
const entries = Array.from({ length: 10000 }, (_, i) => ({
  value: i,
  sizeInBytes: 64,
  retention: "protected",
}));
const messages = entries.map((entry, i) => ({ topic: `/topic/${i % 16}`, message: entry }));
const subscriptions = new Map(
  Array.from({ length: 48 }, (_, i) => [
    String(i),
    Array.from({ length: 16 }, (_, j) => ({ topic: `/topic/${j}` })),
  ]),
);
const ids = new Map(
  Array.from({ length: 16 }, (_, i) => [`/topic/${i}`, [...subscriptions.keys()]]),
);
const plan = compileMessageDispatch(subscriptions);
function workload() {
  const queue = new Queue(640000);
  for (const entry of entries) {
    queue.enqueue(entry);
  }
  queue.drain();
  if (before) {
    route(messages, ids, new Map());
  } else {
    dispatchMessages(messages, plan, new Map());
  }
}
async function main() {
  for (let i = 0; i < 3; i++) {
    workload();
  }
  global.gc?.();
  const session = new inspector.Session();
  session.connect();
  const post = promisify(session.post.bind(session));
  await post("Profiler.enable");
  await post("HeapProfiler.enable");
  await post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await post("Profiler.start");
  // Same number of batches in both captures; after profiles will naturally contain fewer samples.
  for (let i = 0; i < 20; i++) {
    workload();
  }
  const { profile: cpu } = await post("Profiler.stop");
  const { profile: heap } = await post("HeapProfiler.stopSampling");
  session.disconnect();
  const out = path.resolve(process.env.PERFORMANCE_RESULTS_DIR ?? "performance-results");
  fs.mkdirSync(out, { recursive: true });
  const tag = before ? "before" : "after";
  fs.writeFileSync(path.join(out, `${tag}.cpuprofile`), JSON.stringify(cpu));
  fs.writeFileSync(path.join(out, `${tag}.heapprofile`), JSON.stringify(heap));
  console.log(
    JSON.stringify({
      tag,
      iterations: 20,
      cpuSamples: cpu.samples.length,
      durationMs: (cpu.endTime - cpu.startTime) / 1000,
      output: out,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
