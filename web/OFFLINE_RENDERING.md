# XGC2 offline AR entry

This is a separate build, not a flag on the live app. It complements the
`tools/video-renderer` worker in `XGC-Team/xgc2` PR #56. It adds native adapter
implementation; full repository build and real-bag GPU acceptance are still gates.

With existing approved dependencies, from the Lichtblick repository root:

```sh
yarn webpack --mode production --config web/webpack.offline.config.ts
```

Output: `web/.webpack-offline`. Do not check this generated directory into git.
The worker privately copies it into its composition's static assets and creates
a same-origin iframe. The iframe uses `?xgcTfHistorySeconds=600` to override the normal two-second live
TF window for this page only. `history.ts` validates the actual native capacity
and time bounds, refusing histories that would be trimmed, mixed static/dynamic
sources for one frame, or more than 4096 frames. Long bags beyond this bounded
window require a validated checkpoint builder, not silent truncation.
The URL fragment carries a snapshot URL and its expected
SHA-256. There is no ROS player, live websocket, GCS publishing listener or scene
editor. External asset fetching is denied; V1 intentionally rejects URDF/mesh.

`index.ts` installs the frame listener before asynchronous initialization, verifies
origin/source Window, resolves a hashed snapshot and event history, and delegates
to `OfflineRenderer`. A failed request requires a new dedicated page. Iframe load
is never treated as a frame-completion signal.

`renderer.ts` reuses native Renderer, ImageMode, PoseArrays (including nav_msgs/Path)
and Markers. Only configured, known message schemas are dispatched. Real-time
queue coalescing is bypassed without changing native geometry/projection handlers.
Reverse time clears and rebuilds state. Static TF uses record-time availability;
dynamic TF accepts a declared lookahead; algorithm data is bounded by the selected
camera sample time. Source camera bytes are immutable JPEG/PNG, native 3840x2160.

`OfflineImageMode` resubmits the selected native image at its original width and
waits for the native decode callback. The normal ImageMode decode cap remains
1920 and the regular app entry is unchanged. This intentionally incurs an initial
preview decode in V1; optimize that extra decode only after correctness evidence.
Final native errors (including missing calibration/TF) fail instead of silently
exporting a blank or incomplete scene.

The native scratch canvas stays layout-active offscreen. After decoding, resources
and draw, `capture.ts` performs synchronous WebGL readback, restores framebuffer
and pixel-pack state, flips rows once, and updates a visible persistent 2D canvas.
Only then does the page send `frame-ready`. Late native draws cannot mutate the
captured surface. Device pixel ratio must be 1. Fonts/browser/platform differences
still require an approved render environment; byte-identical cross-GPU output is
not promised.

## Tests

```sh
yarn node web/offline-tests/run.cjs
# Optional real browser readback test (not a full native-app render):
XGC2_CHROMIUM=/approved/chromium yarn node web/offline-tests/run.cjs
```

The wrapper strictly compiles the dependency-free state/readback production modules
into a temporary directory, runs Node tests and removes that directory. The
optional browser fixture uses a software WebGL2 context with a synthetic two-color
3840x2160 image and checks orientation plus persistence. Its `--no-sandbox` flag is
limited to this test harness; do not infer production isolation from that test.

Full Yarn typecheck/lint/build, actual ImageMode/Marker behavior, original image
quality, camera alignment, random-order state restoration, cancellation and end-to-
end Remotion encoding with a real bag remain separate acceptance gates. No live
entry, dependency lockfile, deployment or harness submodule pointer is changed.
