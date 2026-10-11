#!/usr/bin/env bash
set -euo pipefail

package_name="xgc2-lichtblick-web"
launcher="/usr/bin/xgc2-lichtblick-web"
node="/usr/lib/xgc2/lichtblick-web/node/bin/node"
tests="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../xgc2/tests" && pwd)"
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
  rm -rf "${smoke_dir}"
}
trap cleanup EXIT

cat > "${smoke_dir}/view-input.json" <<'JSON'
{"layoutMode":"3d","runMode":"simulation","visualizationTopics":[],"robots":[]}
JSON
"${launcher}" --view-input-stdin --control-socket "${smoke_dir}/control.sock" \
  --host 127.0.0.1 --port 0 --control-plane-url ws://127.0.0.1:9 \
  <"${smoke_dir}/view-input.json" >"${smoke_dir}/server.log" 2>&1 &
server_pid=$!
"${node}" - "${smoke_dir}" "${tests}/raw_call.cjs" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { rawCall } = require(process.argv[3]);
(async () => {
  const root = process.argv[2];
  const socketPath = path.join(root, "control.sock");
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(socketPath)) {
    const log = fs.readFileSync(path.join(root, "server.log"), "utf8");
    assert.ok(!/startup failed|cannot prepare web entrypoint/.test(log), log);
    assert.ok(Date.now() < deadline, log);
    await delay(50);
  }
  const response = await rawCall(socketPath, "GET", "/v1/describe?wait_ready_ms=30000", { timeoutMs: 15000 });
  assert.equal(response.status, 200);
  const described = response.json;
  assert.equal(described.service, "xgc2.lichtblick.v1");
  assert.equal(described.ready, true);
  assert.deepEqual(described.facts.capabilities, ["view.v1"]);
  const origin = `http://127.0.0.1:${described.facts.http_port}`;
  fs.writeFileSync(path.join(root, "origin"), origin);
  fs.writeFileSync(path.join(root, "actual-describe.json"), JSON.stringify(described));
  const call = (method, target, body) => rawCall(socketPath, method, target, { instance: described.instance_id, body });
  assert.equal((await rawCall(socketPath, "GET", "/v1/view")).status, 409);
  assert.equal((await call("GET", "/v1/view")).json.revision, "0");
  assert.equal((await call("GET", "/v1/health")).json.status, "ok");
  const view = { layoutId: "installed-camera", followRobot: "uav1", perspective: true, visibleSurfaces: ["3d-tools"] };
  const stated = await call("PUT", "/v1/view", { view, expectedRevision: "0" });
  assert.equal(stated.status, 200);
  assert.equal(stated.json.revision, "1");
  const page = await fetch(`${origin}/xgc2/view`, { headers: { Origin: origin }, signal: AbortSignal.timeout(3000) });
  assert.deepEqual(await page.json(), { revision: "1", view });
  const layout = await fetch(`${origin}/layout.json`, { signal: AbortSignal.timeout(3000) });
  assert.equal((await layout.json()).layout, "3D!xgc2");
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
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
[[ ! -e "${smoke_dir}/control.sock" ]]

echo "xgc2-lichtblick-web installed view input, control socket, in-memory desired view and shutdown smoke passed on port ${port}."
