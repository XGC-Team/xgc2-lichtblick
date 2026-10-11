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

Install the formal `node-xgc2-xrpc` build/runtime dependency (at least `0.2.0-1~`)
first. Its installed types and Node library live at
`/usr/lib/xgc2/node_modules/@xgc2/xrpc`; desktop keeps the whole SDK external so
its diagnostic worker retains native paths.
The SDK is supplied by the build image, independently of this repository's
immutable Yarn dependencies.

```bash
corepack yarn install --immutable
./xgc2/scripts/build-web.sh
./xgc2/scripts/run-web.sh --startup-input /absolute/private/startup-input.json \
  --control-socket /absolute/private/runtime/control.sock --port 8080 \
  --control-plane-url ws://127.0.0.1:8765
```

The source-owned launcher provides the same-origin WebSocket proxy, Origin and
CSP controls, `/healthz`, and `/version`. Local development uses
`web/.webpack` and `web/build-info.json` from this working tree. The production
process definition, [process-definitions/xgc2-lichtblick-web.json](process-definitions/xgc2-lichtblick-web.json),
runs the packaged `/usr/bin/xgc2-lichtblick-web` launcher and is installed to
`/usr/share/xgc2/process-definitions` for XGC Core.
Core allocates the service socket named by `endpointParameter`; its parameter is
`fixedOnly`. The `port` and `bridgePort` integer parameters keep their defaults of
18081 and 8765; Core does not allocate the page listener. Readiness uses `describe`,
and `stop.graceMs` is 20000.

Both web and desktop require one private startup input file from the owning
deployment. It declares a live storage reference, scope (and, for the web
launcher, the scope of the desired view), the file that holds its credential, a
separate asset grant and access mode, and the operator time zone;
see [the persistence contract](contracts/persistence-v1.md) and
[startup input schema](contracts/startup-input.schema.json).
The web launcher hosts the XRPC service `xgc2.lichtblick.v1` on the Unix socket
given by `--control-socket`: describe with readiness, document persistence,
extension assets and the desired view of the pages. See the
[control service](contracts/control-service-v1.md) and
[desired view](contracts/view-v1.md) contracts. The desktop hosts no service.
A read-write asset root permits one live writer; independent read-only grants can
load immutable archives. Linux `util-linux` provides the bounded startup `flock`
helper. Browser caches and former Electron datastores are never read as
persistent state.

## Focused checks

```bash
NODE_PATH=/usr/lib/xgc2/node_modules node --test xgc2/tests/test_lichtblick_web.js \
  xgc2/tests/test_view_state.cjs xgc2/tests/test_startup_input.cjs \
  xgc2/tests/test_control_service.cjs xgc2/tests/test_launcher_view.cjs \
  xgc2/tests/test_launcher_drain.cjs xgc2/tests/test_process_definition.cjs
corepack yarn test packages/suite-base/src/components/EmbeddedDesiredView.test.ts \
  packages/suite-base/src/components/EmbeddedWorkspaceBridge.test.tsx --runInBand
corepack yarn test packages/suite-base/src/panels/ThreeDeeRender/transforms/TransformTree.test.ts --runInBand
```

The storage-backed tests (`test_storage_native.cjs`, `test_view_native.cjs`,
`test_browser_native.cjs`) also need `XGC2_STORAGE_TEST_BINARY` (a built
`xgc2-storage`); the browser test needs a built web bundle
(`XGC2_LICHTBLICK_TEST_WEB_ROOT`), `playwright` and an installed browser
(`XGC2_BROWSER_TEST_BINARY`).

## Design notes

- [Automatic view control](docs/automatic-view-control.md): how Core could change
  the desired view on its own (design only, not implemented).

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
