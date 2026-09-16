# Line-strip frame stability: candidate and acceptance gates

## Scope

This change removes allocation/lifecycle defects in `RenderableLineStrip`, used by
ROS `LINE_STRIP` markers and the line component of `PoseArrays` / `nav_msgs/Path`,
including calibrated image overlays. It does not change subscriptions, publishing
rates, TF history, pose/quaternion data, joint updates, saved layouts, path sampling,
visible point counts, or the two-pass line rendering technique.

Baseline: product branch `xgc2` at `4c55c4b0e8a98ee630dc205527a2550013deec09`.
Integration tracking: XGC-Team/xgc2-harness#104 (remains open).

## Source-confirmed defects

The previous implementation recreated geometry on every increase in point count,
called `LineGeometry.setPositions` on every update (replacing interleaved position
storage), and called `computeLineDistances` twice on the same shared geometry.
Final disposal released the materials but not the owned geometry. After shrink,
unused tail positions could still affect bounds. Picking width was not updated
with the visible width, and empty updates could leave material transparency stale.

The candidate manages capacity independently from active segment count. It writes
all positions and colors in place, calculates one shared distance buffer, updates
only active GPU ranges, and calculates bounds from active points. Attribute counts
remain at capacity because Three r156 caches the instanced capacity; `instanceCount`
controls what is drawn. Growth releases old storage; final disposal releases the
remaining shared geometry exactly once.

## Executed checks

### Local isolated checks

Node 22.16.0 and TypeScript 5.8.3 strict compilation with
`noUncheckedIndexedAccess` of the dependency-free `LineStripBuffers.ts` passed.
Syntax transpilation of the four TypeScript files passed. Seven native Node
assertion checks against the compiled buffer owner passed, including 1,000
deterministic varying paths and 4,096 incremental growth updates retaining all
4,097 points with 13 buffer capacity changes. This is an allocation counter,
not an FPS measurement or speedup multiplier.

### Repository CI for implementation commit 787573dc

GitHub Actions run `35052373132`, PR merge test ref
`682015113b6febe167510b379e3143f0d8a90ee5` (not an actual product merge):

- `test (ubuntu-latest)`, job `104655329392`: success. 552/552 suites,
  9,228 tests passed, 7 skipped, and 89/89 snapshots passed. Both newly added
  regression files passed. The log also includes a worker force-exit warning;
  this is not evidence of a leak-free complete application.
- In `lint (ubuntu-latest)`, job `104655329363`, license check, dedupe and
  the full `yarn run tsc --noEmit` step passed using the installed workspace
  dependencies. Formatting then failed in 23 files: the two new test files
  and 21 files not modified by this PR. This follow-up applies the formatter's
  requested changes to our two test files; later lint/dependency checks were
  not reached in that run. Do not treat the whole lint job as passed.
- `npm audit (ubuntu-latest)`, job `104655329411`, failed on high-severity
  findings in the unchanged dependency graph (`@xmldom/xmldom`, `js-yaml`,
  `svgo`). No manifest or lockfile is modified here. Do not disable the audit
  or mix an unvalidated dependency upgrade into this rendering change.

The formatting/documentation follow-up does not alter production code. Its new
head still requires the normal CI rerun; the results above identify the precise
implementation commit tested rather than claiming all checks are green.

## Regression coverage

`LineStripBuffers.test.ts` covers positions, cumulative Float32 distances, bounds,
input preservation and amortized growth. `RenderableLineStrip.test.ts` covers
shared Three.js attributes, active segments/bounds, RGBA, timestamps/pose metadata,
empty recovery, picking width and geometry/material disposal.

```sh
yarn test --runInBand \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/markers/LineStripBuffers.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/markers/RenderableLineStrip.test.ts
yarn run tsc --noEmit
yarn format:ci
yarn lint:ci
```

## Deployment acceptance remains open

Compare baseline and candidate on the same hardware, production build mode,
layout and recorded input. Keep 3D and camera/AR active simultaneously. Include
cold start, steady playback, message bursts, growing/shrinking paths, seek,
resize, panel removal/re-addition and reconnect. Record renderer `endFrame`
interval p50/p95/p99/max and counts above 25/50 ms separately from page rAF,
video decode/presentation and actual display cadence. Record allocation/heap,
GPU resources and input/output message counts; verify path points, quaternion
axes, TF alignment, colors/alpha, labels, camera overlays and picking visually.

Browser/GPU and production ROS acceptance has not been executed here. Do not
close the integration issue based solely on average FPS, unit tests, a main-page
rAF counter, or a test with the camera/viewer stopped. The candidate must still
be built, packaged and consumed by the product before a source fix can be
described as an installed fix.
