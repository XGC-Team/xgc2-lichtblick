# XGC2 Lichtblick product maintenance

This repository is the XGC2 product boundary for Lichtblick. It contains the
complete upstream source plus the XGC2 browser runtime and product-specific
performance changes. The starting point is official Lichtblick v1.27.0 at
`c40602b77dfe5c90f67dbd5ac4e394f044a6fbc2`; `xgc2/upstream.lock` records the
baseline and build toolchain.

## Repository policy

- `origin` is `lxk36/xgc2-lichtblick`; `upstream` is the official Lichtblick
  repository.
- Product changes are developed on `xgc2-product` and must retain the locked
  upstream commit as an ancestor.
- Upstream upgrades are source merges or rebases reviewed together with XGC2
  patches and tests. Packaging lock updates are no longer the upgrade method.
- The former Debian/FPM and APT release matrix is archived in
  `external/dev/xgc2-lichtblick-packaging`; it must not publish releases.

## Live TF retention

The 3D renderer defaults to at most 128 transforms and about two seconds of
history per dynamic frame. The limit applies independently to every 3D panel.
It preserves current-pose interpolation and all static transforms while
preventing high-rate `/tf` streams from retaining an effectively unbounded
history in the browser. Playback callers can still explicitly construct a
larger `TransformTree`.

## Build and run

```bash
corepack yarn install --immutable
./xgc2/scripts/build-web.sh
./xgc2/scripts/run-web.sh --port 8080 \
  --control-plane-url ws://127.0.0.1:8765
```

The source-owned launcher provides the same-origin WebSocket proxy, Origin and
CSP controls, `/healthz`, and `/version`. It uses `web/.webpack` and
`web/build-info.json` from this working tree and does not read `/usr/lib` or
require an APT-installed Lichtblick.

## Focused checks

```bash
node --test xgc2/tests/test_lichtblick_web.js
corepack yarn test packages/suite-base/src/panels/ThreeDeeRender/transforms/TransformTree.test.ts --runInBand
```
