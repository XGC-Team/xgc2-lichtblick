# Real-time 3D / AR: pose-axis instancing and hot-path subtraction

Tracking: XGC-Team/xgc2-harness#104. PR: XGC-Team/xgc2-lichtblick#13.
This is independent of line-strip PR #10.
Baseline: `xgc2@4c55c4b0e8a98ee630dc205527a2550013deec09`.

## Source-confirmed debt and replacement

`PoseArrays` constructed an `Axis` per pose. Each Axis instantiated only its
three directions internally, with two independent meshes and two independent
materials. N visible poses therefore meant 2N uncullable meshes/materials and
N object hierarchies in each 3D/calibrated-image scene. This is an implementation
cost, not a requirement to remove authored orientation.

The candidate uses one Axis batch per topic: two meshes and two materials,
with 3N instances in each mesh. All N positions and quaternions are used.
CPU instance-matrix updates remain O(N), and the GPU still draws the same
geometry. Scene traversal and normal-pass mesh submissions no longer scale
with pose count. Selection/picking/shadow passes remain; two meshes is not a
measurement of the entire panel's draw calls, latency or FPS.

Capacity grows amortized. Ordinary updates, shrink, empty and regrow preserve
mesh/buffer identity. Active counts exclude stale capacity without excluding
valid input. Colors initialize on allocation instead of every message. The
batch rebases near its input positions before Float32 conversion, preserving
small local differences near large map coordinates. The parent Renderable
continues to own timestamped TF; no new pose authority or latest-TF shortcut
is introduced.

## Resource ownership and interaction

Growth disposes the previous InstancedMesh instance buffers, not renderer-shared
geometry or materials transferred to replacement meshes. Final disposal is
idempotent. Selection layers survive growth and are inherited when new
representations are created. CPU raycast bounds are invalidated on updates.
Picking remains at the same PoseArrayRenderable level; pickableInstances is
still false. Legacy single-Axis users, including individual poses and TF axes,
retain their original API.

Shaft/head geometry, subdivisions, RGB colors, lighting and axis-length
conversion are unchanged. No trajectory, quaternion, TF or joint rates,
histories, subscriptions, existing filterQueue policies, schemas, layouts,
camera calibration, image quality or video queues are changed.

## Subtraction actually made

- Replace the per-pose Axis/object/material hierarchy with one batch.
- Remove deep comparisons of style settings irrelevant to representation
  cleanup; only representation changes retire inactive children.
- Skip unused gradient parsing for fixed-RGB axes.
- Remove the duplicate first line-strip update and its per-message closure;
  the constructor already applies the marker.
- Correct singleton gradient interpolation from 0/0 to zero progress so
  one-pose arrow and line colors are finite.

This removes redundant implementation work, not required product views.
The recorded contract includes optional Plot and explicit saved layouts.
Plot, replay/seek, picking, camera calibration, TF and video GOP/reset handling
are not presumed unnecessary. Broad feature deletion requires an actual
consumer inventory and product capability decision; no unverified live-only
profile is introduced here.

## Regression coverage

`Axis.instancing.test.ts` has eight cases: legacy axes; all N RGB directions;
world-matrix parity against individual axes under a transformed parent;
authored quaternions and large-coordinate precision; immutable inputs;
buffer identity through update/empty/regrow; amortized capacity growth;
selection layers, resource ownership and raycast bounds. Some cases cover
multiple properties.

`PoseArrays.instancing.test.ts` has nine cases including three schema variants:
PoseArray, NavPath and PosesInFrame metadata; empty initialization; style and
representation transitions; singleton colors; initial update count; selected
layer inheritance; and successive messages. The combined new case count is 17.

## Validation evidence, pinned to actual tested commits

Local original-file reconstruction was verified against Git blob hashes:
Axis `ef04edb4f60adc334b12440ed0b396104069972b` and PoseArrays
`4218e5d890c5eb638a53af0f6adf14e9e2bc377b`. Syntax transpilation of four
TypeScript files passed with local TypeScript 5.8.3. That is not a workspace
typecheck or test execution. No local Jest, WebGL, GPU or ROS performance
result is claimed.

The implementation is `01f8e4840313e27967f2cea99fff3eb34f75ae70`.
The tested formatting/documentation follow-up is
`55fc7f9f7a0425f5a8e3b30453a095a5d1093b59`; its production code is identical.
The earlier CI summary was inconsistent with later check results, so the
previous blanket statement about successful desktop shards is withdrawn.
Use the following commit-specific evidence instead:

- For `55fc7f9f`, Actions run `35103845735`, test job `104819507690` completed
  successfully. Its decoded log reports 552 suites passed, 9,234 tests passed,
  7 skipped, and 89 snapshots passed. Both new files passed, with 8 and 9 cases.
  The checkout was PR merge-test ref `3d9d90f7e2468b7907942c2e788ba4a541e36e68`,
  not a product merge. Job URL:
  https://github.com/XGC-Team/xgc2-lichtblick/actions/runs/35103845735/job/104819507690
- The same head's check records report failures for lint (`104819507641`),
  dependency audit (`104819507548`), and desktop E2E shard 1 (`104819507632`).
  Subsequent attempts to read the lint and desktop-shard logs returned 404.
  The desktop failure has therefore not been attributed or resolved. Do not
  assert that all remaining failures are unrelated to this change.
- At implementation commit `01f8e484`, lint job `104815966422` did execute and
  pass full workspace `yarn run tsc --noEmit`, license and dedupe checks.
  Formatting then failed in two new tests and 21 unmodified files. The
  follow-up applied the requested changes to the new tests; no unrelated
  files or CI policies were changed. This is not an overall lint pass.
- The earlier decoded audit job `104815966540` reported high-severity findings
  for `@xmldom/xmldom`, `js-yaml` and `svgo` in the unchanged dependency graph.
  No dependency manifest, lockfile or audit policy is modified by this PR.

This final evidence correction changes documentation only. Any new commit
created by that correction still requires normal CI; do not relabel the
verified `55fc7f9f` run as a later head's result. The PR remains Draft pending
review, unresolved checks and runtime acceptance.

With the repository's pinned Yarn dependencies:

```sh
yarn test --runInBand --runTestsByPath \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/Axis.instancing.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/PoseArrays.instancing.test.ts
yarn run tsc --noEmit
yarn format:ci
yarn lint:ci
```

## Real-time ground-station acceptance remains open

Run the packaged baseline and candidate on the same target hardware/browser,
input, saved layout, display rate and viewport, with 3D and camera/AR active
together. Include motion, large-coordinate frames, original quaternions,
dynamic TF, resize, selected-path growth, representation changes, clear/seek,
reconnect and repeated teardown. Verify every predicted axis and line,
lighting/colors, picking, TF/AR registration and timestamps.

Measure fresh-state presentation latency, renderer endFrame intervals and
p50/p95/p99/max plus long frames separately from page rAF. Record CPU/GC/heap,
actual draw calls and GPU resources/duration where available. Repainting stale
state is not fresh telemetry. The acceptance target is stable simultaneous
3D/AR with bounded display age, not universal fixed FPS inferred from object
counts. No product installation, production branch or Harness/devops pin is
changed by this PR. Keep the integration issue open until this gate passes.
