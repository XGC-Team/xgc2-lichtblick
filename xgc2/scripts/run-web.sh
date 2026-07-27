#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! -f "$REPO_ROOT/web/.webpack/index.html" || ! -f "$REPO_ROOT/web/build-info.json" ]]; then
  "$SCRIPT_DIR/build-web.sh" >/dev/null
fi

exec node "$REPO_ROOT/xgc2/launcher/xgc2-lichtblick-web.js" "$@"
