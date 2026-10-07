# XGC2 Lichtblick product maintenance

This repository is the XGC2 product boundary for Lichtblick. It contains the
complete upstream source plus the XGC2 browser runtime and product-specific
performance changes. The starting point is official Lichtblick v1.27.0 at
`c40602b77dfe5c90f67dbd5ac4e394f044a6fbc2`; `xgc2/upstream.lock` records the
baseline and build toolchain.

## Repository policy

- `origin` is `XGC-Team/xgc2-lichtblick`; `upstream` is the official Lichtblick
  repository.
- Product changes are developed on `xgc2` and must retain the locked
  upstream commit as an ancestor.
- Upstream upgrades are source merges or rebases reviewed together with XGC2
  patches and tests.
- This repository also owns `.xgc2/product.yml`, Debian recipes and APT CI.
  Source and both packages are built from the same commit of `xgc2`.
  The former `xgc2-lichtblick-packaging` repository is retired.
- `xgc2/launcher/` is the sole launcher implementation for source and installed
  operation. The installed shell entry only selects the packaged paths.
- `apt-ci.yml` produces the existing desktop and web packages for Focal, Jammy
  and Noble on amd64/arm64. Production publication remains the central devops
  release orchestrator; this repository does not publish an APT index.

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
CSP controls, `/healthz`, and `/version`. Local development uses
`web/.webpack` and `web/build-info.json` from this working tree. The production
process definition runs the packaged `/usr/bin/xgc2-lichtblick-web` launcher.

## Focused checks

```bash
node --test xgc2/tests/test_lichtblick_web.js
corepack yarn test packages/suite-base/src/panels/ThreeDeeRender/transforms/TransformTree.test.ts --runInBand
```

## Debian build

```bash
./.xgc2/scripts/check_package_compliance.sh
./.xgc2/scripts/build_deb_in_docker.sh --ubuntu-version 20.04 --architecture amd64
```

The build entry exports the current committed source to a private writable
build directory and runs as the caller UID/GID. It does not fetch or pin a
second copy of this repository. Installation and purge checks run in a separate
disposable container with read-only host mounts. The upstream baseline and
build tool versions remain in `xgc2/upstream.lock`.
