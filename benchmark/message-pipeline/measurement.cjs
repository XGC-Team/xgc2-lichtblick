// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");

function parseOptions(args) {
  const options = {
    warmups: 5,
    sampleCount: 15,
    first: "before",
    only: undefined,
    stress: false,
    check: false,
  };
  const seen = new Set();
  for (const arg of args) {
    const [name, value, extra] = arg.split("=");
    assert(!seen.has(name), `duplicate option: ${name}`);
    seen.add(name);
    if (name === "--stress" || name === "--check") {
      assert(value == undefined, `${name} does not take a value`);
      options[name.slice(2)] = true;
    } else if (name === "--samples" || name === "--warmups") {
      assert(extra == undefined && /^\d+$/.test(value ?? ""), `invalid integer: ${arg}`);
      const count = Number(value);
      const minimum = name === "--samples" ? 1 : 0;
      const maximum = name === "--samples" ? 1000 : 100;
      assert(
        Number.isSafeInteger(count) && count >= minimum && count <= maximum,
        `out of range: ${arg}`,
      );
      options[name === "--samples" ? "sampleCount" : "warmups"] = count;
    } else if (name === "--only" || name === "--first") {
      assert(
        extra == undefined && (value === "before" || value === "after"),
        `invalid variant: ${arg}`,
      );
      options[name.slice(2)] = value;
    } else {
      assert.fail(`unknown option: ${arg}`);
    }
  }
  // Never silently skip the existing routing/batch budgets in a narrower measurement mode.
  assert(
    !options.check || (!options.only && !options.stress),
    "--check requires the full before/after suite",
  );
  return options;
}

function summarize(samples, cpuMicroseconds) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted[sorted.length - 1],
    cpuMicroseconds,
    // Keep the old sorted field and also retain temporal order for tail/GC investigation.
    samplesMs: sorted,
    samplesInOrderMs: samples,
  };
}

function measurePair(before, after, options, hooks = {}) {
  const now = hooks.now ?? (() => performance.now());
  const collect = hooks.gc ?? (() => global.gc?.());
  const cpuUsage = hooks.cpuUsage ?? ((previous) => process.cpuUsage(previous));
  const functions = { before, after };
  const order = (index) => {
    if (options.only) {
      return [options.only];
    }
    const first = index % 2 === 0 ? options.first : options.first === "before" ? "after" : "before";
    return first === "before" ? ["before", "after"] : ["after", "before"];
  };
  for (let index = 0; index < options.warmups; index++) {
    for (const variant of order(index)) {
      functions[variant]();
    }
  }
  // One explicit collection after both warmups, never between paired timed samples.
  // Natural GC remains part of the workload; this is not a GC-free latency claim.
  collect();
  const samples = { before: [], after: [] };
  const cpu = { before: 0, after: 0 };
  const sampleOrder = [];
  for (let index = 0; index < options.sampleCount; index++) {
    const variants = order(index);
    sampleOrder.push(variants.join(","));
    for (const variant of variants) {
      const cpuStart = cpuUsage();
      const start = now();
      functions[variant]();
      samples[variant].push(now() - start);
      const elapsed = cpuUsage(cpuStart);
      cpu[variant] += elapsed.user + elapsed.system;
    }
  }
  return {
    before: samples.before.length ? summarize(samples.before, cpu.before) : undefined,
    after: samples.after.length ? summarize(samples.after, cpu.after) : undefined,
    sampleOrder,
  };
}

module.exports = { measurePair, parseOptions };
