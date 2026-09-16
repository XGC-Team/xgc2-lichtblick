# XGC2 frame-stability source audit

Tracking: https://github.com/XGC-Team/xgc2-harness/issues/105

## Scope and baseline

Reviewed Lichtblick source: `495aed7e9898a8ebe3b47afe1606131651520c77`
(`develop`, read on 2026-09-16). The original `Renderer.ts` Git blob is
`e5f71e90da646304276f021da2c55185bedcb830`; the local reconstruction was verified
against this blob hash before editing. This identifies the reviewed source,
**not the operator's currently deployed build**.

The reported symptom is intermittent 3D/image-overlay frame-time variation.
The following defects are independently reproducible; their contribution to
the reported live-system stalls is not yet measured.

## Confirmed defects and changes

1. `animationFrame()` cleared the stored rAF handle without cancelling the
   pending callback. Synchronous selection/resize/hover renders could leave an
   orphan callback, allowing duplicate whole-scene work. `RenderScheduler`
   owns the handle and consumes it before an immediate render.
2. The rendering guard was only reset after a successful frame. An exception
   from a subscription, scene extension, or renderer left later frames
   disabled. A `finally` restores the guard; the original exception still
   propagates. There is no automatic retry loop.
3. `dispose()` did not cancel pending frames, and late asynchronous render
   requests could schedule work against released GPU resources. The scheduler
   is disposed before scene/GPU cleanup and ignores subsequent requests.
4. Immediate reentry during a render was silently discarded. It now requests
   one follow-up frame rather than recursively rendering or losing the update.
5. `addMessageEventBatch()` grouped messages into both topic and schema staging
   maps. Shared subscription objects could receive interleaved input in the
   wrong order. `push(...messageEvents)` also exceeded the JavaScript engine's
   argument limit for a large backfill. The batch now uses the single-message
   ingestion path in input order, eliminating both staging maps/arrays and
   unbounded argument spreading.

The queue change preserves per-subscription delivery multiplicity. It does
not deduplicate a subscription intentionally registered through both topic
and schema paths. Existing `filterQueue` policies are not changed.

## Fidelity and TF/Pose review

No ROS publication/subscription rates, trajectory samples, joint states,
quaternions, camera settings, TF history capacity, layout visibility, or image
quality settings are changed. Render-request coalescing is not message
coalescing. Explicit synchronous renders used for picking remain synchronous;
queued rendering follows the browser's next animation frame, without a new
numeric frequency cap.

In the reviewed renderer, TF topology notifications already differ from pose
updates: `addTransform()` rebuilds `coordinateFrameList` only when
`AddTransformResult.UPDATED` indicates a new frame or changed parent, while
ordinary same-parent TF samples still enter the history. Preserve that
separation. `TransformTree.apply()` carries source/destination times and a
maximum delta; do not replace historical lookups with latest-TF shortcuts.
`ImageMode` derives its follow frame from the selected calibration/image frame
and reuses an equal camera model. Those frame/calibration semantics are not
changed by this patch.

Harness shared-memory guidance at
`XGC-Team/xgc2-dev-memory@454ecf69cc25abc5f809e649140aabb5013437b8`,
`now/lichtblick.md`, distinguishes VRPN `{aircraft}/tracking` from fused
`drnn_{N}/base_link`, and specifies camera rigid extrinsics in `/tf_static`.
This is guidance, not proof of the current deployment. Rigid attachments should
reuse their authoritative TF chain; a historical trajectory, a measured-vs-
fused comparison, or authored orientation must not be replaced with a latest
Pose/TF approximation. Before removing a Pose topic, identify every consumer,
its source authority, frame, timestamp and history requirement.

The recorded active frontend is `xgc2-http`, but current connector reads of
that repository returned 404. Its current visualization defaults, publishers,
iframe identity and served bundle were therefore **not verified or changed**.
The deployed TF/Pose redundancy review remains an open part of issue #105.
The image decoder, texture upload and GPU costs also need live profiling;
this change does not claim to have proven or fixed every image-path bottleneck.

## Validation performed

- Strict TypeScript checking of `RenderScheduler.ts` passed locally.
- TypeScript parsing of both changed production files and both new test files
  passed.
- 16 deterministic cases passed in a local Node assertion adapter: 10 execute
  the actual scheduler; 6 execute queue methods extracted unchanged from the
  production Renderer AST, without constructing WebGL. The adapter runs the
  new test bodies, but is **not** the repository Jest/WebGL environment.
- Baseline probes reproduced: two renders from a queued request plus an
  immediate render; no second attempt after a render exception; input order
  `[0,1,2]` becoming `[0,2,1]` for shared schema aliases; and a `RangeError` on
  a 200,000-message batch. The patched queue retains all 200,000 object
  identities in order.

These are correctness/work-count checks, not measured browser FPS or GPU
performance improvements. Repository dependency installation was unavailable
in the local environment. Full Jest, repository type/lint checks, production
build, served-asset verification and hardware A/B are pending.

## Repository validation commands

With the repository's normal dependencies installed:

```sh
yarn test --runInBand --runTestsByPath \
  packages/suite-base/src/panels/ThreeDeeRender/RenderScheduler.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/Renderer.batch.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/Renderer.test.ts
yarn build:packages
yarn lint:ci
yarn web:build:prod
```

Deploy the resulting build through the normal integration process. Record the
served manifest/chunk hashes and source commit. Do not hand-edit generated
assets or assume a source commit proves the embedded runtime was rebuilt.

## Hardware-backed acceptance still required

Use baseline and patched builds with the same bag/live input, exact saved
layout, viewport, device pixel ratio, GPU/driver, browser, source rates,
trajectory history and full camera/AR workload. Warm both runs equally and
repeat the same interaction sequence (tracking motion, joints, hover, selection,
resize, camera switching and panel teardown/reopen). Include 0/1/2-aircraft
cases where the deployment supports them. Do not stop a workflow, hide an
overlay or unmount the viewer to pass the comparison.

Capture p50/p95/p99 frame intervals and frame CPU duration separately, long
frames relative to the actual display interval, main-thread long tasks,
render calls, GPU work where available, image decode/upload duration, decoded
frame age, worker/transport backlog and memory over time. JavaScript
`gl.render()` duration alone does not measure GPU completion or presentation.
An idle rAF counter must not be mistaken for fresh image/pose presentation.

Compare per-topic input and processed counts, trajectory sample order,
authored orientations, TF timestamps/interpolation, joint motion and camera
registration. The performance gate requires repeatable frame-tail improvement
without a fidelity regression, not a higher average FPS from less work being
shown. Keep issue #105 open until these deployment/runtime criteria are met.
