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
./xgc2/scripts/run-web.sh --view-input-stdin \
  --control-socket /absolute/private/runtime/control.sock --port 8080 \
  --control-plane-url ws://127.0.0.1:8765 < view-input.json
```

The source-owned launcher provides the same-origin WebSocket proxy, Origin and
CSP controls, `/healthz`, and `/version`. Local development uses
`web/.webpack` and `web/build-info.json` from this working tree. The production
process definition, [process-definitions/xgc2-lichtblick-web.json](process-definitions/xgc2-lichtblick-web.json),
has definition version `3.0.0`, runs the packaged `/usr/bin/xgc2-lichtblick-web`
launcher and is installed to
`/usr/share/xgc2/process-definitions` for XGC Core.
Core allocates the service socket named by `endpointParameter`; its parameter is
`fixedOnly`. The `port` and `bridgePort` integer parameters keep their defaults of
18081 and 8765; Core does not allocate the page listener. Readiness uses `describe`,
and `stop.graceMs` is 20000. The required string `viewInputJson` has no default;
`command.stdinParameter` passes it to `--view-input-stdin`. The definition has
no `startupInputPath` or prepared `layoutJson` parameter.

The web launcher hosts `xgc2.lichtblick.v1` on `--control-socket`: describe with
readiness, health and the desired view of its pages. Desired view state lives
only in memory; a restart starts at revision `"0"` with no view. See the
[control service](contracts/control-service-v1.md) and
[desired view](contracts/view-v1.md) contracts. Core alone owns Storage. The
browser page will persist layouts, settings and extension assets through Core's
`GET/PUT/DELETE /api/ui-documents/{app}/{kind}/{id}`, list
`GET /api/ui-documents/{app}/{kind}` and binary asset routes
`/api/ui-documents/lichtblick/assets/{name}`, under the user's browser session.
The launcher serves no Storage gateway, extension archives or operator time zone;
the page takes its time zone from settings.

This launcher cutover is intentionally not releasable until the later page
migration lands after Core's UI document API exists. Page persistence still
requests removed routes in this intermediate tree. The product version remains
unchanged. The desktop retains its own startup input and managed persistence
contract: the Storage client and the startup input parser it uses live in
`xgc2/desktop/` (moved out of the web launcher, with their tests) and are imported
only by `packages/suite-desktop`.

[The persistence contract](contracts/persistence-v1.md),
[startup input schema](contracts/startup-input.schema.json) and
[Storage manifest](contracts/storage-manifest.json) are **desktop only** and
remain in place. Desktop hosts no service and keeps its private startup input,
Storage grant, asset ownership and operator time zone.

## High-level view input

`--view-input-stdin` reads one JSON object, through EOF, of at most 8 MiB.
Unknown top-level members are refused with their names. A minimal 3D-only input is:

```json
{"layoutMode":"3d","runMode":"simulation","visualizationTopics":[],"robots":[]}
```

Required fields are `layoutMode`, `runMode`, `visualizationTopics` and `robots`.
The layout modes are `3d`, `3d-camera-ar`, `camera-ar-3d`, `3d-above-camera-ar`,
`camera-ar-above-3d` and `3d-above-camera-ar-plot`. Run mode is `simulation`,
`physical` or `hybrid`. Optional `worldBoundary` is the frozen boundary object
or null. Optional `camera` is `{imageTopic,infoTopic}` with distinct absolute ROS
topics; it is required for every layout with a camera panel.

The workflow passes `$session.visualizationTopics` as the frozen layer array
(at most 64) and `$session.robots` unchanged (at most 256). A RobotFact is
`{slotId,assetId,assetCommitId,name,kind,namespace,profile,binding,asset}`.
The layout takes pose, hybrid source, simulated sensors and optional Scout
settings from `binding`, and visualization from `asset.visualization`;
its ROS name comes from `namespace`, not the asset display name. Invalid or
missing robot layout facts are refused with the slot name. The current Scout
binding has no legacy `mocapRigidBodyName`; the existing layout rule is retained.

Optional `parameters` overrides viewer options. The single authoritative defaults
table is `VIEWER_DEFAULTS` in [prepare-layout.cjs](launcher/prepare-layout.cjs).
It contains grid and axes settings, model scales, palettes, prediction widths,
marker and label options, `sceneNamespace`, `plotPaths`, `transformTopics`,
`frameWorldBoundary` and simple-lidar display budgets. Run mode, layout mode,
boundary, camera topics and visualization declarations belong to the top-level
fields and cannot be overridden through parameters. Label options other than
marker background are carried through as before; robot label rendering belongs
to the visualizer. Display budgets select display topic copies in the layout;
Core's visualization workflow configures those copies and the bridge allowlist.
The launcher no longer produces `allowedTopics` or `displayRelays`.

The launcher maps this input and builds LayoutData in process. It embeds that
layout in `index.html` and serves the same document at `layout.json` under the
public URL prefix. The eight frozen fixtures retain their expected layouts and
hashes of the legacy serialized layout bytes.

## Focused checks

```bash
NODE_PATH=/usr/lib/xgc2/node_modules node --test xgc2/tests/test_lichtblick_web.js \
  xgc2/tests/test_prepared_layout.cjs xgc2/tests/test_view_state.cjs \
  xgc2/tests/test_control_service.cjs xgc2/tests/test_launcher_view.cjs \
  xgc2/tests/test_process_definition.cjs
./.xgc2/scripts/check_package_compliance.sh
```

These launcher checks need only Node 20+ and the formal Node XRPC SDK; no Yarn
install, Storage process, webpack bundle or browser is required. When the installed
SDK path is absent, point `NODE_PATH` at a private directory containing
`@xgc2/xrpc` linked to the SDK's `node` directory in the foundation or XRPC
checkout. Keep that checkout read-only. Tests use temporary private sockets,
random listener ports and stop and wait for the processes they start.

Browser behavior, bundles and actual Debian build/install checks are deferred
until the page migration is ready. Desktop's installed smoke fixture remains
separate from the web launcher checks.

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
