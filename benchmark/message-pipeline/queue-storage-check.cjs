// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// SPDX-FileCopyrightText: Copyright (C) 2026 XGC-Team
// SPDX-License-Identifier: MPL-2.0
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { load, queuePath, queueBlob } = require("./load.cjs");

const Before = load(queuePath, queueBlob).LiveMessageQueue;
const After = load(queuePath).LiveMessageQueue;

function pairedQueue(initialCap) {
  let cap = initialCap;
  const before = new Before(cap);
  const after = new After(cap);
  return {
    after,
    act(method, ...args) {
      const actual = after[method](...args);
      assert.deepEqual(actual, before[method](...args), method);
      if (method === "setMaximumSize") {
        cap = args[0];
      }
      assert.equal(after.getSizeInBytes(), before.getSizeInBytes(), `${method}: bytes`);
      assert(Number.isSafeInteger(after.getSizeInBytes()));
      assert(after.getSizeInBytes() >= 0 && after.getSizeInBytes() <= cap);
      const stats = after.getStorageStats();
      assert(stats.allocatedSlots <= Math.max(1024, stats.queuedEntries * 2));
      return actual;
    },
  };
}

function protectedEntry(value, sizeInBytes, protectedPriority) {
  return { value, sizeInBytes, retention: "protected", protectedPriority };
}

test("normal pressure preserves FIFO across holes, zero bytes and repeated compaction", () => {
  for (const cap of [0, 1, 8, 64, 256]) {
    const { act, after } = pairedQueue(cap);
    for (let index = 0; index < 5000; index++) {
      act("enqueue", {
        ...protectedEntry(index, index % 11 === 0 ? 0 : 1, index % 2 ? "normal" : undefined),
        key: `/key/${index % 7}`,
      });
      if (index % 73 === 0) {
        act("removeKey", "/key/3");
      }
      if (index % 97 === 0) {
        act("shift");
      }
    }
    act("drain");
    assert.equal(after.getStorageStats().allocatedSlots, 0);
    act("enqueue", protectedEntry("after drain", 0));
    act("shift");
  }
});

test("mixed protected priorities and critical drop reports keep the original policy", () => {
  for (const queuedPriority of [undefined, "normal", "high", "critical"]) {
    for (const incomingPriority of [undefined, "normal", "high", "critical"]) {
      const { act } = pairedQueue(10);
      act("enqueue", protectedEntry("zero", 0, queuedPriority));
      act("enqueue", protectedEntry("old", 6, queuedPriority));
      act("enqueue", protectedEntry("other", 4, "high"));
      act("enqueue", protectedEntry("new", 7, incomingPriority));
      act("setMaximumSize", 2);
      act("drain");
      act("enqueue", protectedEntry("oversized", 3, "critical"));
      act("clear");
      act("enqueue", protectedEntry("fresh", 2, incomingPriority));
      act("enqueue", protectedEntry("last", 2));
      act("drain");
    }
  }
});

test("adopted plans rebuild replaceable indices and preserve failed replacement rollback", () => {
  const { act } = pairedQueue(20);
  act("enqueue", protectedEntry("p1", 6));
  act("enqueue", { value: "a", sizeInBytes: 4, retention: "replaceable", key: "a" });
  act("enqueue", { value: "b", sizeInBytes: 4, retention: "replaceable", key: "b" });
  act("enqueue", protectedEntry("p2", 6));
  act("enqueue", protectedEntry("p3", 4));
  assert.deepEqual(
    act(
      "enqueue",
      { value: "too large b", sizeInBytes: 6, retention: "replaceable", key: "b" },
      { supersedeReplaceable: true },
    ),
    { accepted: false, droppedEntries: 1, sizeLimitExceeded: true },
  );
  act(
    "enqueue",
    { value: "smaller b", sizeInBytes: 2, retention: "replaceable", key: "b" },
    { supersedeReplaceable: true },
  );
  act("removeKey", "a");
  assert.deepEqual(act("drain"), ["p1", "p2", "p3", "smaller b"]);
});

test("plan adoption keeps metadata copies distinct without cloning payload identity", () => {
  const { act } = pairedQueue(12);
  const payload = Object.freeze({ sequence: 1 });
  const entry = protectedEntry(payload, 4, "critical");
  act("enqueue", entry);
  act("enqueue", entry);
  act("enqueue", protectedEntry("rejected", 6));
  entry.sizeInBytes = 100;
  const first = act("shift");
  const second = act("shift");
  assert.notEqual(first, second);
  assert.notEqual(first, entry);
  assert.equal(first.value, payload);
  assert.equal(second.value, payload);
  assert.equal(first.sizeInBytes, 4);
  act("clear");
  act("enqueue", protectedEntry("next", 12));
  act("enqueue", protectedEntry("replacement", 12));
  assert.deepEqual(act("drain"), ["replacement"]);
});

test("safe integer limits hold in both FIFO and mixed transactional pressure paths", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const { act } = pairedQueue(maximum);
  act("enqueue", protectedEntry("large", maximum - 1));
  act("enqueue", protectedEntry("zero", 0));
  act("enqueue", protectedEntry("last byte", 1));
  assert.equal(act("enqueue", protectedEntry("full", maximum)).droppedEntries, 3);
  act("setMaximumSize", maximum - 1);
  act("enqueue", protectedEntry("oversized", maximum, "critical"));
  act("setMaximumSize", maximum);
  act("enqueue", protectedEntry("normal", maximum - 2));
  act("enqueue", protectedEntry("high", 2, "high"));
  assert.deepEqual(act("enqueue", protectedEntry("critical", maximum - 1, "critical")), {
    accepted: true,
    droppedEntries: 2,
    sizeLimitExceeded: false,
  });
  assert.deepEqual(act("drain"), ["critical"]);
});

test("video recovery survives pressure and drain until an existing reset boundary", () => {
  const { act } = pairedQueue(10);
  const video = (value, sizeInBytes, isVideoRecoveryPoint) => ({
    value,
    sizeInBytes,
    retention: "video",
    key: "video",
    isVideoRecoveryPoint,
  });
  act("enqueue", video("recovery", 4, true));
  act("enqueue", video("delta", 4, false));
  act("enqueue", protectedEntry("normal", 6));
  for (let index = 0; index < 20; index++) {
    act("enqueue", protectedEntry(index, 6));
  }
  act("drain");
  assert.equal(act("enqueue", video("still blocked", 1, false)).accepted, false);
  act("enqueue", video("new recovery", 4, true));
  act("enqueue", video("new delta", 4, false));
  act("setMaximumSize", 4);
  act("removeKey", "video");
  assert.equal(act("enqueue", video("after removal", 1, false)).accepted, true);
  act("clear");
  act("enqueue", video("oversized recovery", 5, true));
  act("clear");
  assert.equal(act("enqueue", video("after clear", 1, false)).accepted, true);
  act("drain");
});

test("resize, sparse snapshots and new appends retain every surviving key", () => {
  const { act } = pairedQueue(100);
  for (let index = 0; index < 10; index++) {
    act("enqueue", { value: index, sizeInBytes: 10, retention: "replaceable", key: `${index}` });
  }
  act("shift");
  act("removeKey", "5");
  act("setMaximumSize", 45);
  for (let index = 0; index < 10; index++) {
    act(
      "enqueue",
      { value: index + 10, sizeInBytes: 7, retention: "replaceable", key: `${index}` },
      { supersedeReplaceable: true },
    );
  }
  act("setMaximumSize", 0);
  act("setMaximumSize", 100);
  act("enqueue", protectedEntry("new generation", 100));
  act("drain");
});

test("96,000 seeded mixed operations match the pinned reference after every operation", () => {
  const priorities = [undefined, "normal", "high", "critical"];
  const retentions = ["protected", "replaceable", "video"];
  const sizes = [0, 1, 3, 8, 32, 64, 129];
  const caps = [0, 1, 8, 32, 64, 128];
  for (let seed = 1; seed <= 64; seed++) {
    let state = seed;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 8;
    };
    const { act } = pairedQueue(64);
    for (let index = 0; index < 1500; index++) {
      const operation = next() % 20;
      if (operation < 14) {
        const key = next() % 8;
        act(
          "enqueue",
          {
            value: index,
            sizeInBytes: sizes[next() % sizes.length],
            key: key === 0 ? undefined : key === 1 ? "" : `key/${key}`,
            retention: retentions[next() % retentions.length],
            protectedPriority: priorities[next() % priorities.length],
            isVideoRecoveryPoint: next() % 3 === 0,
          },
          { supersedeReplaceable: next() % 2 === 0 },
        );
      } else if (operation < 16) {
        act("shift");
      } else if (operation === 16) {
        act("removeKey", `key/${next() % 8}`);
      } else if (operation === 17) {
        act("setMaximumSize", caps[next() % caps.length]);
      } else if (operation === 18) {
        act("drain");
      } else {
        act("clear");
      }
    }
    act("drain");
  }
});

test("invalid byte counts fail without modifying existing queue data", () => {
  for (const Queue of [Before, After]) {
    for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const queue = new Queue(10);
      queue.enqueue(protectedEntry("preserved", 10));
      assert.throws(() => queue.enqueue(protectedEntry("invalid", size)), RangeError);
      assert.throws(() => queue.setMaximumSize(size), RangeError);
      assert.equal(queue.getSizeInBytes(), 10);
      assert.deepEqual(queue.drain(), ["preserved"]);
    }
  }
});
