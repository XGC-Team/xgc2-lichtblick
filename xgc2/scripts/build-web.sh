#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/xgc2/upstream.lock"

actual_version="$(node -p "require('$REPO_ROOT/package.json').version")"
actual_yarn="$(cd "$REPO_ROOT" && corepack yarn --version)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"

[[ "$actual_version" == "$LICHTBLICK_UPSTREAM_VERSION" ]] || {
  echo "Expected Lichtblick $LICHTBLICK_UPSTREAM_VERSION, found $actual_version." >&2
  exit 1
}
[[ "$actual_yarn" == "$LICHTBLICK_YARN_VERSION" ]] || {
  echo "Expected Yarn $LICHTBLICK_YARN_VERSION, found $actual_yarn." >&2
  exit 1
}
(( node_major >= LICHTBLICK_NODE_MAJOR )) || {
  echo "Node $LICHTBLICK_NODE_MAJOR or newer is required." >&2
  exit 1
}
git -C "$REPO_ROOT" merge-base --is-ancestor "$LICHTBLICK_UPSTREAM_SHA" HEAD || {
  echo "Current branch does not contain the locked official v1.27.0 baseline." >&2
  exit 1
}

if [[ "${XGC2_LICHTBLICK_SKIP_INSTALL:-0}" != "1" ]]; then
  (cd "$REPO_ROOT" && corepack yarn install --immutable)
fi
(cd "$REPO_ROOT" && corepack yarn web:build:prod)
[[ -f "$REPO_ROOT/web/.webpack/index.html" ]] || {
  echo "Web build did not produce web/.webpack/index.html." >&2
  exit 1
}

revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
dirty=false
git -C "$REPO_ROOT" diff --quiet --ignore-submodules -- || dirty=true
python3 - "$REPO_ROOT/web/build-info.json" "$actual_version" "$revision" "$dirty" <<'PY'
import json
import pathlib
import sys

output, version, revision, dirty = sys.argv[1:]
payload = {
    "schema": "xgc2.lichtblick-web.build.v1",
    "package": "xgc2-lichtblick-web",
    "version": f"{version}-xgc2-source",
    "upstreamVersion": version,
    "upstreamSha": revision,
    "sourceDirty": dirty == "true",
}
pathlib.Path(output).write_text(
    json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
    encoding="utf-8",
)
PY

printf '%s\n' "$REPO_ROOT/web/.webpack"
