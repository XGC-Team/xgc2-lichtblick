#!/usr/bin/env bash

set -euo pipefail

package_name="xgc2-lichtblick"
binary="/opt/Lichtblick/lichtblick"
launcher="/usr/bin/lichtblick"
fixture="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../xgc2/tests" && pwd)/installed_fixture.cjs"
unset NODE_PATH

status="$(dpkg-query -W -f='${db:Status-Abbrev}' "${package_name}")"
[[ "${status}" == ii* ]]
[[ -x "${binary}" ]]
[[ -L "${launcher}" ]]
[[ "$(readlink -f "${launcher}")" == "${binary}" ]]
[[ -u /opt/Lichtblick/chrome-sandbox ]]
[[ -f /usr/share/applications/lichtblick.desktop ]]
[[ -f /usr/share/mime/packages/lichtblick.xml ]]
[[ -f /opt/Lichtblick/LICENSE.electron.txt ]]
[[ -f /opt/Lichtblick/LICENSES.chromium.html ]]
[[ ! -e /opt/Lichtblick/resources/package-type ]]
[[ ! -e /opt/Lichtblick/resources/app-update.yml ]]
[[ -f /usr/share/doc/xgc2-lichtblick/README.md ]]
[[ -f /usr/share/doc/xgc2-lichtblick/upstream.lock ]]
[[ -f /usr/share/doc/xgc2-lichtblick/LICENSE.upstream ]]
[[ -f /usr/share/doc/xgc2-lichtblick/copyright ]]
[[ -x /usr/bin/xgc2-storage ]] || { echo "Installed /usr/bin/xgc2-storage is required." >&2; exit 1; }
[[ -f /usr/lib/xgc2/node_modules/@xgc2/xrpc/package.json ]] || { echo "Installed Node xRPC SDK is required." >&2; exit 1; }
for prerequisite in openssl xvfb-run dbus-run-session setsid; do
  command -v "${prerequisite}" >/dev/null || { echo "Installed smoke requires ${prerequisite}." >&2; exit 1; }
done
if dpkg-query -L "${package_name}" | grep -q '^/usr/share/doc/lichtblick/'; then
  echo "Legacy upstream documentation directory remains installed." >&2
  exit 1
fi

if [[ -n "${TARGET_ARCH:-}" ]]; then
  [[ "$(dpkg-query -W -f='${Architecture}' "${package_name}")" == "${TARGET_ARCH}" ]]
fi
if [[ -n "${PACKAGE_DISTRIBUTION:-}" ]]; then
  installed_version="$(dpkg-query -W -f='${Version}' "${package_name}")"
  [[ "${installed_version}" == *"~${PACKAGE_DISTRIBUTION}" ]]
fi

ldd_output="$(mktemp)"
smoke_dir="$(mktemp -d)"
launcher_pid=""
# The control client uses the release's maintained Node runtime. Electron owns
# the application listener and renderer, not the external SDK test client.
fixture_runtime="/usr/lib/xgc2/lichtblick-web/node/bin/node"
[[ -x "${fixture_runtime}" ]]
fixture_node() { "${fixture_runtime}" "${fixture}" "$@"; }
cleanup() {
  if [[ -n "${launcher_pid}" ]]; then
    kill -TERM -- "-${launcher_pid}" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "${launcher_pid}" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-${launcher_pid}" 2>/dev/null || true
    wait "${launcher_pid}" 2>/dev/null || true
  fi
  fixture_node stop "${smoke_dir}" || true
  rm -f "${ldd_output}"
  rm -rf "${smoke_dir}"
}
trap cleanup EXIT

ldd "${binary}" | tee "${ldd_output}"
if grep -Fq 'not found' "${ldd_output}"; then
  echo "Unresolved shared library dependency detected." >&2
  exit 1
fi

case "$(dpkg-query -W -f='${Architecture}' "${package_name}")" in
  amd64) file "${binary}" | grep -Eq 'x86-64|x86_64' ;;
  arm64) file "${binary}" | grep -Eq 'aarch64|ARM aarch64' ;;
esac

dpkg --verify "${package_name}"

launch_seconds="${LICHTBLICK_SMOKE_LAUNCH_SECONDS:-25}"
fixture_node prepare "${smoke_dir}"
setsid xvfb-run -a dbus-run-session -- \
  "${launcher}" \
    --bootstrap-input "${smoke_dir}/bootstrap.json" \
    --user-data-dir="${smoke_dir}/electron" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=0 \
    --no-sandbox \
    --enable-unsafe-swiftshader \
    --disable-dev-shm-usage \
    >"${smoke_dir}/lichtblick.log" 2>&1 &
launcher_pid=$!
fixture_node verify-desktop "${smoke_dir}" "${smoke_dir}/lichtblick.log" "${launch_seconds}"
cat "${smoke_dir}/actual-service-ref.json"
printf '\n'

kill -TERM -- "-${launcher_pid}"
for _ in $(seq 1 100); do
  kill -0 "${launcher_pid}" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "${launcher_pid}" 2>/dev/null; then
  echo "Installed desktop process group did not stop after SIGTERM." >&2
  exit 1
fi
set +e
wait "${launcher_pid}"
launch_status=$?
set -e
launcher_pid=""
[[ "${launch_status}" == 0 || "${launch_status}" == 143 ]]
fixture_node verify-closed "${smoke_dir}"
fixture_node stop "${smoke_dir}"

echo "xgc2-lichtblick installed Bootstrap, actual mTLS ServiceRef, renderer restore and shutdown smoke passed."
