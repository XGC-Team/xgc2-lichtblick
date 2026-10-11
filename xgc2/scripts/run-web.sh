#!/usr/bin/env bash
set -euo pipefail

# Pass the Run's high-level view document on stdin with --view-input-stdin.
# Example: ./xgc2/scripts/run-web.sh --view-input-stdin --control-socket /absolute/private/control.sock < view-input.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! -f "$REPO_ROOT/web/.webpack/index.html" || ! -f "$REPO_ROOT/web/build-info.json" ]]; then
  "$SCRIPT_DIR/build-web.sh" >/dev/null
fi

exec node "$REPO_ROOT/xgc2/launcher/xgc2-lichtblick-web.js" "$@"
