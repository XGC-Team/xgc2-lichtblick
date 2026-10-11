#!/usr/bin/env bash
set -euo pipefail

package_name="xgc2-lichtblick-web"
launcher="/usr/bin/xgc2-lichtblick-web"
node="/usr/lib/xgc2/lichtblick-web/node/bin/node"
fixture="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../xgc2/tests" && pwd)/installed_fixture.cjs"
unset NODE_PATH

[[ "$(dpkg-query -W -f='${db:Status-Abbrev}' "${package_name}")" == ii* ]]
[[ -x "${launcher}" ]]
[[ -x "${node}" ]]
[[ -f /usr/lib/xgc2/lichtblick-web/web/index.html ]]
[[ -f /usr/lib/xgc2/lichtblick-web/build-info.json ]]
[[ -f /etc/xgc2/lichtblick-web.env ]]
definition=/usr/share/xgc2/process-definitions/xgc2-lichtblick-web.json
[[ -f "${definition}" ]]
"${node}" -e '
  const document = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const [definition] = document.definitions;
  if (document.apiVersion !== "xgc.execution.process/v1" || definition.command.executable !== "/usr/bin/xgc2-lichtblick-web" || definition.services[0].service !== "xgc2.lichtblick.v1") process.exit(1);
' "${definition}"
[[ -x /usr/bin/xgc2-storage ]] || { echo "Installed /usr/bin/xgc2-storage is required." >&2; exit 1; }
[[ -f /usr/lib/xgc2/node_modules/@xgc2/xrpc/package.json ]] || { echo "Installed Node xRPC SDK is required." >&2; exit 1; }
for prerequisite in curl; do
  command -v "${prerequisite}" >/dev/null || { echo "Installed smoke requires ${prerequisite}." >&2; exit 1; }
done

smoke_dir="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]]; then
    kill -TERM "${server_pid}" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "${server_pid}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  "${node}" "${fixture}" stop "${smoke_dir}" || true
  rm -rf "${smoke_dir}"
}
trap cleanup EXIT

"${node}" "${fixture}" prepare "${smoke_dir}"
"${launcher}" --startup-input "${smoke_dir}/startup-input.json" \
  --control-socket "${smoke_dir}/control.sock" \
  --host 127.0.0.1 --port 0 --control-plane-url ws://127.0.0.1:9 \
  >"${smoke_dir}/server.log" 2>&1 &
server_pid=$!
"${node}" "${fixture}" verify-web "${smoke_dir}" "${smoke_dir}/server.log"
origin="$(cat "${smoke_dir}/origin")"
port="${origin##*:}"
cat "${smoke_dir}/actual-describe.json"
printf '\n'

curl --fail --silent --show-error "http://127.0.0.1:${port}/healthz" \
  | grep -Fq '"status":"ok"'
curl --fail --silent --show-error "http://127.0.0.1:${port}/version" \
  > "${smoke_dir}/version.json"
grep -Fq '"schema":"xgc2.lichtblick-web.build.v1"' "${smoke_dir}/version.json"
grep -Fq '"package":"xgc2-lichtblick-web"' "${smoke_dir}/version.json"
grep -Fq '"version":' "${smoke_dir}/version.json"
curl --fail --silent --show-error "http://127.0.0.1:${port}/" \
  > "${smoke_dir}/index.html"
grep -Fq 'foxglove-websocket' "${smoke_dir}/index.html"
grep -Fq '/ws' "${smoke_dir}/index.html"
curl --fail --silent --show-error --dump-header "${smoke_dir}/headers" \
  --output /dev/null "http://127.0.0.1:${port}/"
grep -Fiq "content-security-policy: frame-ancestors 'self'" "${smoke_dir}/headers"
if grep -Fiq 'x-frame-options:' "${smoke_dir}/headers"; then
  echo "X-Frame-Options must not block the supported iframe integration." >&2
  exit 1
fi

kill -TERM "${server_pid}"
for _ in $(seq 1 100); do
  kill -0 "${server_pid}" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "${server_pid}" 2>/dev/null; then
  echo "Installed web launcher did not drain after SIGTERM." >&2
  exit 1
fi
wait "${server_pid}"
server_pid=""
"${node}" "${fixture}" verify-closed "${smoke_dir}"
"${node}" "${fixture}" stop "${smoke_dir}"

echo "xgc2-lichtblick-web installed startup input, control socket, desired view, gateway FULL/restart and shutdown smoke passed on port ${port}."
