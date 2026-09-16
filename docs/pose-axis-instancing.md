# Real-time 3D / AR: pose-axis instancing and hot-path subtraction

Tracking: XGC-Team/xgc2-harness#104. This is independent of line-strip PR #10.
Baseline: `xgc2@4c55c4b0e8a98ee630dc205527a2550013deec09`.

## Source-confirmed debt

`PoseArrays` constructed an `Axis` per pose. Each Axis instantiated only its
three directions internally, with two independent meshes and two independent
materials. For N visible poses this meant 2N uncullable meshes, 2N materials
and a per-pose Object3D hierarchy in each 3D/calibrated-image scene. This is
an implementation cost, not a requirement to remove authored orientation.

The candidate submits every pose through one Axis batch: two meshes and two
materials per topic, with 3N instances in each mesh. All N positions and
quaternions are used. CPU instance-matrix updates remain O(N), and the GPU
still draws the same geometry. Normal-pass mesh submissions and per-frame
scene traversal no longer scale with pose count. Extra scene passes such as
selection/picking/shadows remain; "two meshes" is not a measurement of the
entire panel's draw count, latency or FPS.

Capacity grows amortized, and ordinary update/shrink/regrow keeps mesh and
buffer identity. Active instance counts hide no valid input and exclude
stale capacity. Color buffers are initialized once per allocation, not every
message. Origin rebasing happens before Float32 conversion, preserving small
local differences near large map coordinates. This does not introduce TF
lookups or replace the parent Renderable's timestamped transform.

## Resource and interaction boundaries

Growth disposes only the old InstancedMesh instance buffers. Geometry belongs
to SharedGeometry; existing materials transfer to replacement meshes and are
disposed only at final teardown. Repeated disposal is idempotent. Selection
layers are copied during growth and inherited on representation creation.
CPU raycast bounds are invalidated on updates. Picking remains at the same
PoseArrayRenderable level (pickableInstances remains false).

The original single-axis API remains intact for TF axes and individual poses.
Shaft/head geometry, subdivisions, RGB colors, standard lighting and public
axis-length conversion are unchanged. No trajectory, quaternion, TF or joint
rates, histories, subscriptions, existing filterQueue policy, message schema,
layout visibility, camera calibration, image quality or video queue is changed.

## Subtraction actually made

- Remove the per-pose Axis/object/material hierarchy from array rendering.
- Remove irrelevant deep comparisons of gradient/scale settings in message
  processing; only representation changes retire inactive children.
- Skip gradient parsing for fixed-RGB axes.
- Remove the duplicate first line-strip update (the constructor already applies
  it), and remove the now-unnecessary per-message closure around that update.
- Correct singleton gradient interpolation: zero-based progress is zero for a
  one-pose path, not 0/0. Arrow and line colors remain finite.

This is subtraction of redundant work, not removal of required product views.
The recorded product contract includes optional Plot and explicit saved
layouts, so Plot is not presumed redundant. Picking, replay/seek, camera
calibration, TF and the existing video GOP/reset boundaries remain. Broad
feature removal requires a consumer/usage inventory and an explicit product
capability profile; no unverified "live-only" flags are introduced here.

## Regression coverage and validation status at submission

`Axis.instancing.test.ts` covers legacy axes, all N RGB directions, world-matrix
parity with individual axes under a transformed parent, authored quaternions,
large-coordinate precision, immutable inputs, buffer identity through empty
and regrow, amortized growth, selection layers, resource ownership and raycast
bounds. `PoseArrays.instancing.test.ts` covers all three source schemas,
metadata, representation/style transitions, singleton colors, first-update
count, selected-layer inheritance and successive messages.

Local source reconstruction was checked against original Git blob hashes:
Axis `ef04edb4f60adc334b12440ed0b396104069972b` and PoseArrays
`4218e5d890c5eb638a53af0f6adf14e9e2bc377b`. Syntax transpilation of all four
TypeScript files passed using local TypeScript 5.8.3. This is not full type
checking and does not execute the tests. The container cannot resolve GitHub
or install workspace dependencies; repository CI must run the real tests.
No local Jest, WebGL, GPU or ROS performance result is claimed at submission.

With the repository's pinned Yarn dependencies:

```sh
yarn test --runInBand --runTestsByPath \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/Axis.instancing.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/PoseArrays.instancing.test.ts
yarn run tsc --noEmit
yarn format:ci
yarn lint:ci
```

CI results should identify the actual tested commit. Do not treat baseline
format/dependency-audit failures as green and do not disable checks.

## Real-time ground-station acceptance still open

Run the actual packaged baseline and candidate on the same target GPU/browser,
input, layout, display rate and viewport, with 3D plus camera/AR concurrently
active. Include stationary and moving paths, large-coordinate frames, original
quaternions, dynamic TF, resizing, selected-path growth, representation changes,
clear/seek/reconnect and repeated teardown. Verify every predicted axis and
line, colors/lighting, picking, AR registration and message/frame timestamps.

Record fresh-state presentation latency, renderer endFrame intervals and
p50/p95/p99/max plus long-frame counts separately from main-page rAF. Record
CPU/heap/GC, geometry/material/instance-buffer counts, actual draw calls and
GPU duration when available. Repainting stale state is not fresh telemetry.
The target is stable simultaneous 3D/AR with bounded display age, not a claim
of a universal fixed FPS from a unit test or object-count reduction. No
installation, production branch or Harness/devops pin is changed by this PR.
