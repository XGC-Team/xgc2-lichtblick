# XGC experiment view capture

The embedded workspace accepts a separate versioned, same-origin capture protocol (`xgc-lichtblick-view-capture`, version 1). It does not change the existing embedded-tools protocol. Only the actual parent window can request captures; there is no desktop recording prompt and no filesystem or Core credential access in the renderer.

Mounted 3D and Image (AR) renderers register their real layout panel IDs. A request chooses `3d` or `ar`, with an optional `viewPanelId` when multiple matching panes exist. Ambiguous, missing, hidden/parked, context-lost, camera-not-ready and disposed panes fail explicitly. Keep the experiment viewer and desired pane visible for this version. The capture does not reveal hidden panes, change the saved layout, seek the player or pause the simulation.

The renderer flushes scene messages, awaits in-flight video decoding, forces a fresh draw, and copies the canvas synchronously inside `endFrame` before PNG encoding. Image mode uses the existing composite camera/overlay renderer. DOM controls and separate HTML overlays are not part of the PNG. The result contains PNG bytes, the actual panel ID and `renderedTimeNs` from the renderer frame. That timestamp is in the viewer's time domain: it is not asserted to be ROS `/clock` time.

Requests have cancellation and bounded deadlines, at most eight concurrent requests and sixteen MiB per PNG. Replayed request IDs do not capture twice; a connection accepts at most 4096 distinct IDs before requiring reload. Disposing a renderer or embedded bridge aborts pending work. Host-side persistence and workflow nodes live in the paired XGC2 change (`sim.wait-until` followed by `visualization.capture`). The two-node chain triggers after the clock reaches the threshold; it does not promise an exact simulation-tick screenshot while the simulation continues running.

## Verification

Use the repository's pinned `yarn@4.17.0` commands. The capture tests exercise same-parent/origin/version admission, actual panel identity, ambiguous/missing views, replay, timeout, disposal, decode-to-draw ordering and cancellation cleanup. The existing workspace bridge, Tools forwarding and 3D tests check the integration boundary:

```sh
corepack yarn test --runInBand packages/suite-base/src/components/EmbeddedViewCapture.test.ts \
  packages/suite-base/src/panels/ThreeDeeRender/captureView.test.ts \
  packages/suite-base/src/components/EmbeddedWorkspaceBridge.test.tsx \
  packages/suite-base/src/context/EmbeddedWorkspaceControlsContext.test.tsx \
  packages/suite-base/src/components/ForwardEmbeddedWorkspaceControls.test.tsx \
  packages/suite-base/src/panels/ThreeDeeRender/ThreeDeeRender.test.tsx
corepack yarn build:packages
corepack yarn web:build:prod
```

Apply the existing CI ESLint configuration and Biome format checks to the changed source/test files. The paired XGC2 repository also retains three `web/tests/lichtblick-*.contract.cjs` suites that run the pure host and viewer protocol modules together; compilation and execution commands are in XGC2 `docs/automation/view-capture.md`.

These tests use fake windows/renderers and do not establish real WebGL pixels, AR camera decoding, actual ROS simulation timing, workflow branch bubbles or production consumption. Those remain independent acceptance gates in an owned runtime window. Desktop packaging is outside this embedded web change's validation.
