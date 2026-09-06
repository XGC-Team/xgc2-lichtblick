# Performance refactor: validation evidence

Tracking: [Harness #78](https://github.com/XGC-Team/xgc2-harness/issues/78).
Architecture, compatibility decisions and reproduction commands: [review](message-pipeline.md).
Baseline: `b3cd154046d0ad17596faacb6db244b6bb32c3dd` on the Harness-tracked `xgc2` branch.

## Dependency-backed implementation checkpoint

[Actions run 34067574977](https://github.com/XGC-Team/xgc2-lichtblick/actions/runs/34067574977)
validated implementation `98a131436d11f1876ba16ab9eecf6c8c70591973` on Node 24.20.0, Ubuntu 24.04,
AMD EPYC 9V74. Immutable dependency installation, 16 targeted Jest suites / 208 tests, 225,000
queue differential operations plus three compaction workloads, 10,000 subscription differential
cases, and timing/structural checks passed. Seven lint findings remained in that checkpoint and
were corrected in the review branch; the workflow's overall conclusion was therefore failure,
not an all-green build. Consult PR-head checks for final lint, typecheck, full-suite and build status.
The review branch also adds 100 seeded routing workloads comparing exact ordered object identity.

| CI component workload | Before median | After median | Speedup |
| --- | ---: | ---: | ---: |
| Route 20k messages, 12 equivalent subscribers | 4.902 ms | 0.725 ms | 6.8x |
| Route 20k messages, 48 equivalent subscribers | 22.017 ms | 0.721 ms | 30.5x |
| Route 20k messages, 48 distinct interests | 3.165 ms | 1.727 ms | 1.8x |
| Route 20k messages, 12 sparse interests | 0.829 ms | 0.538 ms | 1.5x |
| Enqueue/shift 10k protected entries below capacity | 771.194 ms | 1.301 ms | 592.9x |
| Supersede 10k entries on one key | 2.388 ms | 1.888 ms | 1.3x |
| Saturated 8-entry queue, 2k protected admissions | 1.528 ms | 1.153 ms | 1.3x |
| Merge 100 unique requested fields on one topic | 2.012 ms | 0.032 ms | 62.6x |
| Merge 1,000 unique requested fields on one topic | 160.773 ms | 0.139 ms | 1159.5x |

These are synthetic component timings, not end-to-end UI latency or FPS. Growing queue/field-union
cases deliberately expose removed quadratic scaling, so the largest ratios are not representative
of every queue depth, message rate or layout. For 48 equivalent subscribers, delivery arrays fall
from 48 to 1 and retained message references from 960,000 to 20,000. Payload objects were already
shared; this is not a 97.9% whole-app heap reduction.

The median pressure case improved in CI but was 4% slower locally. CI pressure p95 was also worse
(3.591 ms before / 4.757 ms after). With only 15 samples, p95 here is the maximum observed sample;
this needs repeated representative pressure measurements, not a blanket speedup claim. The
transactional planner remains unchanged in policy and can still be quadratic under large evictions.

## Reproducible evidence and regression coverage

The committed [CI aggregate](../../benchmark/message-pipeline/results/ci-node24.json) contains
rounded medians/p95, CPU accounting, allocation structure and validation provenance. The
[checkpoint artifact](https://github.com/XGC-Team/xgc2-lichtblick/actions/runs/34067574977/artifacts/9999457548)
contains every raw sample, exact revision, Jest JSON and Chrome-compatible CPU/allocation profiles.
Local raw samples are also committed in `benchmark/message-pipeline/results/local-node22.json`.
The same-process benchmark uses five warmups / fifteen samples; field union uses three / nine.
Historical implementations are loaded from pinned git blobs, not hand-reimplemented alternatives.
The dispatch-only baseline is isolated from the original store loop; reducer/React costs are not
included in the reported routing times.

The permanent `Message pipeline performance` workflow has read-only repository permissions and
runs formatting/lint, pipeline/player/extension/sampling tests, both differential comparisons,
structural allocation assertions, wide relative timing budgets and warmed CPU/allocation profiles.
Artifacts are retained for 30 days. Profiling sampling includes allocations later collected by GC;
its bytes are cumulative estimates, not peak heap or RSS. No temporary delivery workflow or encoded
source payload is present in the review branch.

Required before deployment: representative Harness desktop/iframe sessions and ROS/MCAP traffic,
source swaps, hidden iframe parking, video dependency recovery, cold startup, input-to-paint
latency, long tasks, GPU time and retained heap. This implementation does not claim that unmeasured
browser, GPU, decoding, I/O, serialization or network costs have been solved. No deployment,
submodule-pin update, stored-layout migration or session/transport contract change is included.
