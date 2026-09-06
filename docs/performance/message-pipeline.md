# Lichtblick data-path performance refactor

Tracking: [Harness #78](https://github.com/XGC-Team/xgc2-harness/issues/78).
Target: `XGC-Team/xgc2-lichtblick:xgc2` (the Harness submodule's configured branch).
Baseline: `b3cd154046d0ad17596faacb6db244b6bb32c3dd`.

## Findings and decisions

The review followed live input through worker admission, playback state, subscription aggregation,
message dispatch, extension render-state construction and 3D rendering, and inspected iterable-source
caching, panel loading and dependency declarations. The measured scope is CPU/allocations in the live
queue and main-thread message pipeline. This is not an end-to-end browser/GPU performance report.

| Boundary inspected | Finding / decision |
| --- | --- |
| `players/FoxgloveWebSocketPlayer/liveMessageQueue.ts`, worker `enqueue`/`shift` call sites | Every enqueue copied all queued entries and recovery state, used BigInt even below capacity, scanned acceptance and recopied all survivors. Repeated admission plus `Array.shift()` was quadratic. Replace routine storage; keep transactional pressure policy. |
| `components/MessagePipeline/store.ts`, provider and mocks | Delivery duplicated identical arrays per panel and performed an ID Map lookup per message/recipient. Subscriber updates rebuilt state even when unchanged. Compile equivalent topic interests once and stabilize effective player requests. |
| `components/MessagePipeline/subscriptions.ts` | Ramda's repeated field union revisited previously accumulated fields. An unlimited moize identity cache was constructed but unused. Use one native accumulator; delete the dead cache rather than bounding an unnecessary cache. |
| `components/PanelExtensionAdapter` and `messageProcessing.ts` | Consumers expose readonly frames; watched-field render-state memoization and WeakMap conversion caches already exist. Sharing readonly delivery arrays respects that contract. No speculative converter caching or framework replacement. |
| `panels/ThreeDeeRender/Renderer.ts` and renderables | Existing pools, temporary vectors, model/shared-geometry caches and patched shader keys are meaningful. Retain Three.js and its patch. GPU draw calls, picking, video decode and real-canvas frame latency require a hardware/browser trace. |
| `players/IterablePlayer/CachingIterableSource.ts` | Bounded block caching and topic invalidation already exist. Stable effective player subscriptions avoid unnecessary downstream reconfiguration, but no file/range-I/O speedup is claimed. |
| `panels/index.ts`, web webpack entry/configuration | Panels already load via dynamic imports. Retain this split; cold-start bundle/network timing was not measured. |
| Harness integration and saved layouts | No changes to iframe ownership/parking, session closure contracts, stored layout schemas, transport protocols, sampling policy or deployment/submodule pins. |

## Architecture changes

### Live queue: separate admission from eviction

The common below-capacity path now appends an entry without building a detached trim plan. A key
index visits only replaceable samples actually being superseded. Head-indexed slots avoid shifting
all surviving entries. Removed slots immediately release their payload references; geometric
compaction bounds slot overhead to `max(1024, 2 * queuedEntries)` after public mutations. Drain and
clear release the array and index entirely. `getStorageStats()` exposes counts, not payloads, for
on-demand profiling and deterministic memory-structure regression tests.

The pressure path still plans against detached active entries and commits only a bounded result.
This preserves ordered protected messages, priority tiers, complete video dependency chains,
recovery gating and rollback when a replacement loses to protected traffic. Subtraction-based fast
admission cannot overflow the safe-integer byte range; pressure planning retains BigInt arithmetic.
The cap is a payload-byte accounting limit, not a promise about the entire JavaScript heap.

### Dispatch: arrays belong to interest groups, not panels

Subscription-time compilation canonicalizes each panel's **topic set** and maps topics to unique
interest groups. Field/preload/sampling metadata still flows through subscription aggregation;
it never changed topic-based frame routing. Per-frame work builds one ordered array per active
interest group and assigns it to all equivalent subscribers. No serialization, message sampling,
message-object copies or cross-frame array reuse is introduced. The plan retains no frame payloads.

Unchanged subscriber requests return the exact existing store state, producing no notifications.
Adding/removing an equivalent panel reuses effective player subscriptions. Unsubscribing removes a
stale per-panel delivery entry. New-topic last-message backfill, repeated-frame suppression and
player reset semantics remain covered by existing and new tests. The unused subscriber bookkeeping,
`seenTopics` Set and unbounded memoizer are removed, including their mock-provider counterparts.

### Aggregation and lifecycle

A native accumulator visits each requested field once rather than repeatedly copying growing
unions. It preserves full-implies-partial behavior, topic ordering, singleton field behavior,
trim/deduplication, legacy empty-union semantics and the internal sampling authorization guard.
No authorization is inferred from an untrusted sampling request.

Provider teardown cancels its pending frame timer and settles the outstanding player emission,
instead of throwing away its resolver and leaving the old player waiting indefinitely. Pending
frame references are discarded on teardown; late emissions are ignored.

## Dependency changes

Removed `moize@6.1.6` from suite-base and removed its now-exclusive lockfile dependencies
`micro-memoize@4.2.0` and `fast-equals@3.0.3`. Other consumers still require `fast-equals@5.4.0`.
Ramda is removed from the message-pipeline aggregation path but retained for live chart and
UserScriptPlayer code. React, Zustand, lodash, Chart.js and Three.js remain: replacing them without
measured evidence would add migration risk and would not address these measured algorithms.
The benchmark workspace explicitly declares the already-used TypeScript 6.0.3 toolchain; no new
runtime framework or service is introduced.

## Reproduction

Use the package-manager version in root `package.json`, not the older AGENTS quick-start version.

```sh
corepack enable yarn
yarn install --immutable
# Baseline source blobs are loaded from git, not copied into production source.
git fetch --no-tags --depth=1 origin b3cd154046d0ad17596faacb6db244b6bb32c3dd
mkdir -p performance-results
yarn test --runInBand --testPathPatterns='components/MessagePipeline|players/FoxgloveWebSocketPlayer|components/PanelExtensionAdapter'
yarn node benchmark/message-pipeline/queue-differential.cjs
yarn node benchmark/message-pipeline/subscriptions-differential.cjs
yarn node --expose-gc benchmark/message-pipeline/run.cjs --check > performance-results/routing.json
yarn node --expose-gc benchmark/message-pipeline/profile.cjs --before
yarn node --expose-gc benchmark/message-pipeline/profile.cjs
```

The runner loads current TypeScript with the installed compiler. Queue baseline blob:
`a7fa8172641ce2e7f0af9c920c7d57135e385206`; aggregation baseline blob:
`c874733d6436db3581334257aa47457b7de4aa14`. The latter's unused moize import/factory is excluded
from benchmark module loading; its aggregation functions are unchanged. `baseline.cjs` is the
original dispatch loop from store blob `67bce14f5be93b7b681bca3b9117ca63255c36ff`, isolated from
React/Zustand setup. These are component benchmarks, not full reducer/render measurements.

Each timing comparison uses the same process/fixtures, five warmups and fifteen samples, reporting
median, p95, all samples and aggregate CPU time. Subscription-union timing uses three warmups/nine
samples. Queue workloads cover growing protected batches, single-key supersession and a small
saturated queue; routing covers repeated interests, distinct overlapping interests and sparse
subscriptions. Order, object identity and retained-array/reference counts are checked separately
from wall time. The deliberately wide CI timing gates require 2x repeated-interest routing and
2x large-batch queue improvement; absolute milliseconds are not a portable CI contract.

The queue differential test executes 225,000 deterministic mixed operations plus compaction
workloads against the baseline, comparing returns, values, byte accounting, recovery and priorities.
Subscription differential tests compare 10,000 generated request sets against the baseline.
Ordinary Jest tests cover identities, unsubscribe/reset, normalization, sampling and teardown.

The profiler warms up before enabling V8 CPU and allocation sampling. It runs the same twenty
queue/routing batches in each capture, emitting Chrome-compatible `.cpuprofile` and `.heapprofile`
files. Sampling includes subsequently collected allocations: allocated bytes are cumulative
estimates, **not peak heap, retained heap, or resident memory**. The much shorter after capture
naturally has fewer CPU samples; percentages are not a throughput comparison.

## Initial local evidence

Node 22.16.0, Linux x64, AMD EPYC 9V74; development measurements before CI validation:

| Component workload | Before median | After median | Ratio |
| --- | ---: | ---: | ---: |
| Route 20k messages, 12 identical subscribers | 4.417 ms | 0.561 ms | 7.9x |
| Route 20k messages, 48 identical subscribers | 18.018 ms | 0.539 ms | 33.5x |
| Route 20k messages, 48 distinct interests | 2.720 ms | 1.609 ms | 1.7x |
| Route 20k messages, 12 sparse interests | 0.653 ms | 0.441 ms | 1.5x |
| Enqueue/shift 10k protected entries below capacity | 769.710 ms | 0.685 ms | 1122.9x |
| Supersede 10k entries on one key | 2.367 ms | 1.838 ms | 1.3x |
| Saturated 8-entry queue, 2k protected admissions | 0.765 ms | 0.795 ms | 0.96x |

Large-batch speedup removes a quadratic algorithm; it is not representative of every live batch.
For 48 equivalent subscribers, retained delivery arrays fall from 48 to 1 and references from
960,000 to 20,000 (97.9% fewer). The original payload objects were already shared, so this does not
mean a 97.9% reduction in whole-app memory. CPU sampling attributed 52.6% to the old `#commitPlan`
and 36.6% to old `enqueue` in the queue-heavy capture. Full dependency-backed test/benchmark results
are attached to the implementation PR and workflow artifacts; the pre-change CI checkpoint passed
4 pipeline suites / 39 tests.

## Limits and follow-up validation

The queue's rare pressure planner still scans/splices entries and can be quadratic during large
forced evictions. Genuine subscription changes still rebuild the compiled plan and aggregate all
active requests; no-op churn is eliminated, not every configuration-time cost. The last-message
backfill cache retains its established semantics, including messages received before subscriptions.

No production MCAP/ROS traffic corpus, live Harness session, GPU renderer, image/video decoding,
network latency or cold-start timing was profiled here. Before deployment, capture browser traces
on representative saved 3D/AR layouts in desktop and embedded web modes: first useful frame,
input-to-paint p50/p95, long tasks, decoder queue depth, GPU time and heap after repeated source swaps.
Check slow-consumer pressure, seeks/backfill, reconnects, hidden iframe parking and protected/video
traffic under realistic rates. No FPS, startup, network or end-to-end Harness improvement is claimed
from the component results. Existing dependency peer warnings and unrelated architectural cycles
remain separate debt, not silently "fixed" by a bulk upgrade.
