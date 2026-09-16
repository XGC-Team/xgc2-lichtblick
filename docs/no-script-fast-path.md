# Optional script work must not tax every live message

Tracking: XGC-Team/xgc2-harness#104.
Baseline: consumed product `xgc2@4c55c4b0e8a98ee630dc205527a2550013deec09`.
This is independent of the line-buffer and pose-axis rendering PRs.

## Confirmed behavior and scoped change

PlayerManager always installs UserScriptPlayer. With no registered scripts,
its message processor still iterated every input, allocated empty promise
arrays, awaited Promise.all([]), and filtered empty outputs. It also copied
source messages twice and sorted them even when nothing was generated.

The candidate returns before this per-message loop when registrations are
empty. Registered scripts that do not consume a topic or have no subscriber
also skip the empty Promise.all. The recomputation pass no longer traverses
all messages merely to delete from an empty topic set.

When no derived messages exist, mergeScriptMessages scans for timestamp
inversions and reuses the input array only when already ordered. Unordered
input is still stably sorted on a copy. When derived messages exist, the
old source -> recomputed -> computed tie order is preserved, using one concat
instead of two. Arrays are concat arguments, not spread into function arguments.
No input array or message payload is mutated and no samples are removed.

## Boundaries deliberately preserved

This is not a blanket embedded-mode ban on scripts. Existing saved layouts
can add, edit, remove and restore scripts without reconnecting. Keep script
registration, metadata resets, subscriptions, diagnostics, mutex serialization,
listener backpressure and batch iterators unchanged. Keep basic datatype
augmentation and source overrides. Keep the latest-message cache: a paused
script edit can need a message seen before any scripts existed.

Workers were already lazy in the no-script state; the patch does not claim
to newly eliminate their creation. The no-script wrapper still performs
necessary bookkeeping and an O(n) ordering check; this is not a zero-cost
or O(1) full-pipeline claim. No rates, TF/Pose authority, trajectory/quaternion/
joint/image content, layout visibility, camera calibration or GPU settings
change. Optional recents storage and autocomplete indexing are separate work.

## Regression coverage

Seven merge cases cover frozen/sorted/empty/singleton input, duplicates,
stable out-of-order sorting, seconds/nanoseconds, derived tie order, 200
reference comparisons and 200,000-message frames. Seven real-player Jest
cases cover no-script work counts, source identity/order, basic datatype
augmentation, metadata/seek, downstream acknowledgement, script add/remove/
restore, paused recomputation from pre-script cached inputs and unmatched
or unsubscribed script inputs. The existing mock worker now acknowledges
close requests so tests can use the real player cleanup path.

## Validation performed locally

Original index.ts reconstruction exactly matched Git blob
`5431d14fd194a284df67e06ad6e2ec384b97893e` before editing. The uploaded candidate
production blob matches the locally reviewed version.

Node 22.16.0 / TypeScript 5.8.3: syntax transpilation of the five TypeScript
files passed. Seven committed merge test bodies passed under a native Node
assertion adapter. Six additional checks run the actual #getMessages method
extracted from each production AST with dependency adapters, including
no-script/unsubscribed/unmatched input, subscribed sequential outputs and
error propagation. A 10,000-message no-script probe counts 10,000 empty
Promise.all calls before and zero after. The merge checks preserve every
object identity in a 200,000-message frame.

These are isolated correctness and operation counts, not the complete local
workspace environment or browser/GPU/ROS timing. The container cannot resolve
GitHub/install the workspace. Remote repository results below supersede the
submission-time pending CI state; no local full-workspace result is claimed.

## Verified repository CI for implementation commit d6208d29

Implementation: `d6208d29ac72146a8c63148338a79aca77a3b5c6`.
GitHub Actions run `35121462462`, synthetic PR merge-test checkout
`eb72d1cd175b818e1550fac9905e5fd502784e58` (not a product merge).

- Full Jest job `104880019573`: success. 552/552 suites, 9,231 tests passed,
  7 skipped, 89/89 snapshots passed. Both new files and the existing player
  suite passed, including all 14 new cases. A worker force-exit warning remains
  in the full log; this does not prove the whole application leak-free.
- Web production build job `104880019348`: success (`yarn web:build:prod`).
- Lint job `104880019371`: license, dedupe and full `tsc --noEmit` passed.
  Formatting then failed on fastPath.test.ts and 21 unmodified baseline files.
  This follow-up applies the requested two formatting changes to our test only.
  Later lint/unused-export/dependency-lint stages were not reached. The overall
  lint job is not green, and unrelated baseline files are not reformatted here.
- Dependency audit job `104880019126`: failed. No manifest or lockfile changes
  are included in this PR; the failure must not be bypassed or marked passed.
- Separate SonarCloud run `35121462389`, job `104880017713`: failed before
  scanning because SONAR_TOKEN is missing. The log explicitly requests the
  existing project token. No source-scan result was produced.

This follow-up changes test formatting and this evidence document only.
Production behavior and test assertions are unchanged, but the new head
requires the normal CI rerun. Previous-head results are not relabeled as
new-head results. No all-checks-green or end-to-end runtime claim is made.

## Required repository and deployment validation

```sh
yarn test --runInBand --runTestsByPath \
  packages/suite-base/src/players/UserScriptPlayer/mergeScriptMessages.test.ts \
  packages/suite-base/src/players/UserScriptPlayer/fastPath.test.ts \
  packages/suite-base/src/players/UserScriptPlayer/index.test.ts
yarn run tsc --noEmit
yarn format:ci
yarn lint:ci
```

Do not bypass CI or treat previous PR results as this candidate's results.
After review and build/package validation, compare identical hardware, input
and layout with 3D + camera/AR together. Measure message-processing duration,
fresh-state display age, queue/backpressure, CPU/GC and renderer frame tails;
verify input counts, timestamp order, orientations and scripted layouts.
No production branch, deployment or Harness/devops pin is changed here.
Keep the integration issue open until real-time acceptance is complete.
