# Line-strip frame stability: candidate and acceptance gates

## Scope

This change removes allocation/lifecycle defects in `RenderableLineStrip`, used by
ROS `LINE_STRIP` markers and the line component of `PoseArrays` / `nav_msgs/Path`,
including calibrated image overlays. It does not change subscriptions, publishing
rates, TF history, pose/quaternion data, joint updates, saved layouts, path sampling,
visible point counts, or the two-pass line rendering technique.

Baseline: product branch `xgc2` at `4c55c4b0e8a98ee630dc205527a2550013deec09`.

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

In an isolated environment with Node 22.16.0 and TypeScript 5.8.3:

- Strict compilation with `noUncheckedIndexedAccess` of the dependency-free
  `LineStripBuffers.ts` passed. This was not a whole-workspace type check and did
  not use the repository's pinned TypeScript 6.0.3.
- Syntax transpilation of the four changed/new TypeScript files passed.
- Seven native Node assertion checks against the compiled buffer owner passed:
  empty/singleton, duplicate points, immutable input/in-place updates, shrink and
  regrow, 1,000 deterministic varying paths, 4,096 incremental growth updates,
  and large arbitrary growth with Float32 rounding equivalence.
- The incremental case retained 4,097 points and changed buffer capacity 13 times.
  This is an allocation counter, not an FPS measurement or a speedup multiplier.

## Committed regression coverage (execution pending)

`LineStripBuffers.test.ts` covers positions, cumulative Float32 distances, bounds,
input preservation and amortized growth. `RenderableLineStrip.test.ts` covers
shared Three.js attributes, active segments/bounds, RGBA, timestamps/pose metadata,
empty recovery, picking width and geometry/material disposal.

Run in the complete workspace using the pinned Yarn version:

```sh
yarn test --runInBand \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/markers/LineStripBuffers.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/renderables/markers/RenderableLineStrip.test.ts
yarn run tsc --noEmit
yarn lint:ci
```

The isolated environment did not have the complete workspace, Three.js/Jest,
a browser/GPU rendering session or the production ROS data plane. Repository
Jest, full typecheck/lint, desktop/web visuals and actual GL resource behavior
have NOT been reported as passed.

## Deployment acceptance remains open

Compare baseline and candidate on the same hardware, production build mode,
layout and recorded input. Keep 3D and camera/AR active simultaneously. Include
cold start, steady playback, message bursts, growing/shrinking paths, seek,
resize, panel removal/re-addition and reconnect. Record renderer `endFrame`
interval p50/p95/p99/max and counts above 25/50 ms separately from page rAF,
video decode/presentation and actual display cadence. Record allocation/heap,
GPU resources and input/output message counts; verify path points, quaternion
axes, TF alignment, colors/alpha, labels, camera overlays and picking visually.

Do not close the integration issue based solely on average FPS, unit tests,
a main-page rAF counter, or a test with the camera/viewer stopped. The candidate
must still be built, packaged and consumed by the product before a source fix
can be described as an installed fix.
