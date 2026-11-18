#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$REPO_ROOT/xgc2/upstream.lock"

mkdir -p "$REPO_ROOT/.work"
exec {build_lock}>"$REPO_ROOT/.work/live-web-build.lock"
flock "$build_lock"

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
revision="$(git -C "$REPO_ROOT" rev-parse HEAD)"
source_before="$(python3 "$SCRIPT_DIR/live-web-source.py")"
web_output="${LICHTBLICK_WEB_OUTPUT_DIR:-.webpack}"
if [[ "$web_output" != /* ]]; then web_output="$REPO_ROOT/web/$web_output"; fi
web_output="$(realpath -m -- "$web_output")"
build_info="$REPO_ROOT/web/build-info.json"
if [[ "$web_output" != "$(realpath -m -- "$REPO_ROOT/web/.webpack")" ]]; then build_info="$web_output/build-info.json"; fi
# Webpack replaces the contents of its output directory. Once it starts, the
# previous receipt cannot identify that directory after an interrupted build.
rm -f -- "$build_info"
(cd "$REPO_ROOT" && corepack yarn web:build:prod)
[[ -f "$web_output/index.html" ]] || {
  echo "Web build did not produce $web_output/index.html." >&2
  exit 1
}

source_after="$(python3 "$SCRIPT_DIR/live-web-source.py")"
[[ "$source_before" == "$source_after" && "$revision" == "$(git -C "$REPO_ROOT" rev-parse HEAD)" ]] || {
  echo "Lichtblick live Web inputs changed during the build." >&2
  exit 1
}
dirty=false
[[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]] || dirty=true
python3 - "$build_info" "$actual_version" "$revision" "$dirty" "$source_after" <<'PY'
import json
import os
import pathlib
import sys
import tempfile

output, version, revision, dirty, live_source = sys.argv[1:]
payload = {
    "schema": "xgc2.lichtblick-web.build.v1",
    "package": "xgc2-lichtblick-web",
    "version": f"{version}-xgc2-source",
    "upstreamVersion": version,
    "upstreamSha": revision,
    "sourceDirty": dirty == "true",
    "liveSourceFingerprint": live_source,
}
with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=pathlib.Path(output).parent, delete=False) as temporary:
    json.dump(payload, temporary, sort_keys=True, separators=(",", ":"))
    temporary.write("\n")
    os.fchmod(temporary.fileno(), 0o644)
os.replace(temporary.name, output)
PY

printf '%s\n' "$web_output"
