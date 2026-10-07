#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
deb_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deb-dir) deb_dir="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "${repo_root}"

required_files=(
  xgc2/README.md xgc2/upstream.lock .xgc2/product.yml
  .xgc2/scripts/build_deb.sh .xgc2/scripts/build_deb_in_docker.sh
  .xgc2/scripts/build_web_deb.sh .xgc2/scripts/check_package_compliance.sh
  .xgc2/scripts/smoke_test_installed.sh .xgc2/scripts/smoke_test_web_installed.sh
  .xgc2/scripts/xgc2_artifact_manifest.py
  .github/workflows/apt-ci.yml .github/workflows/ci-bootstrap-gate.yml
  .github/workflows/apt-release.yml xgc2/tests/test_artifact_manifest.py
  xgc2/tests/test_lichtblick_web.js xgc2/launcher/lichtblick-web.env
  xgc2/launcher/reverse-proxy-examples.md xgc2/launcher/xgc2-lichtblick-web
  xgc2/launcher/xgc2-lichtblick-web.js
)
for file in "${required_files[@]}"; do
  [[ -f "${file}" ]] || { echo "Missing required file: ${file}" >&2; exit 1; }
done
grep -Fq 'XGC-Team/xgc2-images/.github/workflows/reusable-check-ci-bootstrap.yml@master' \
  .github/workflows/ci-bootstrap-gate.yml

for script in .xgc2/scripts/*.sh; do
  [[ -x "${script}" ]] || { echo "Script is not executable: ${script}" >&2; exit 1; }
  bash -n "${script}"
done

# shellcheck disable=SC1091
source xgc2/upstream.lock
[[ "${LICHTBLICK_UPSTREAM_REPOSITORY}" == "https://github.com/lichtblick-suite/lichtblick.git" ]]
[[ "${LICHTBLICK_UPSTREAM_REF}" == "refs/tags/v${LICHTBLICK_UPSTREAM_VERSION}" ]]
[[ "${LICHTBLICK_UPSTREAM_SHA}" =~ ^[0-9a-f]{40}$ ]]
[[ "${LICHTBLICK_UPSTREAM_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_BUILD_IMAGE_TAG}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_NODE_MAJOR}" =~ ^[0-9]+$ ]] && (( LICHTBLICK_NODE_MAJOR >= 20 ))
[[ "${LICHTBLICK_NODE_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_YARN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]
[[ "${LICHTBLICK_FPM_RELEASE}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_FPM_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_FPM_RUBY_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "${LICHTBLICK_FPM_AMD64_ARCHIVE}" == \
  "fpm-${LICHTBLICK_FPM_VERSION}-ruby-${LICHTBLICK_FPM_RUBY_VERSION}-linux-amd64.7z" ]]
[[ "${LICHTBLICK_FPM_ARM64_ARCHIVE}" == \
  "fpm-${LICHTBLICK_FPM_VERSION}-ruby-${LICHTBLICK_FPM_RUBY_VERSION}-linux-arm64v8.7z" ]]
[[ "${LICHTBLICK_FPM_AMD64_SHA256}" =~ ^[0-9a-f]{64}$ ]]
[[ "${LICHTBLICK_FPM_ARM64_SHA256}" =~ ^[0-9a-f]{64}$ ]]
[[ "${LICHTBLICK_FPM_RELEASE}" == 2.2.1 ]]
[[ "${LICHTBLICK_FPM_VERSION}" == 1.17.0 ]]
[[ "${LICHTBLICK_FPM_RUBY_VERSION}" == 3.4.3 ]]
grep -Fq 'ghcr.io/xgc-team/xgc2-images/xgc2-build-${distribution}-dev:${LICHTBLICK_BUILD_IMAGE_TAG}' \
  .xgc2/scripts/build_deb_in_docker.sh
grep -Fq 'export USE_SYSTEM_FPM=true' .xgc2/scripts/build_deb_in_docker.sh
grep -Fq 'fpm --version' .xgc2/scripts/build_deb_in_docker.sh
grep -Fq 'electron-builder-binaries/releases/download' \
  .xgc2/scripts/build_deb_in_docker.sh
grep -Fq 'sha256sum --check --strict' .xgc2/scripts/build_deb_in_docker.sh
grep -Fq 'bsdtar -xf' .xgc2/scripts/build_deb_in_docker.sh
if grep -Eq 'apt-get -o Acquire::Retries=5 update|nodejs\.org/dist' \
    .xgc2/scripts/build_deb_in_docker.sh; then
  echo "Lichtblick build must keep distro packages and Node in the XGC2 image." >&2
  exit 1
fi

# libasound2 is a virtual package on Noble. Keep both the replacement and
# fallback relationship versioned so the unversioned OSS shim cannot satisfy
# the desktop package. This source-level guard catches release-time rewrites
# before the six expensive package builds start.
alsa_relation_count="$(grep -Foc 'libasound2 (>= 1.0.16)' .xgc2/scripts/build_deb.sh || true)"
if [[ "${alsa_relation_count}" != 2 ]]; then
  echo "build_deb.sh must emit the versioned libasound2 relationship in both paths." >&2
  exit 1
fi

product_version="$(sed -n 's/^version:[[:space:]]*//p' .xgc2/product.yml | head -n 1)"
case "${product_version}" in
  "${LICHTBLICK_UPSTREAM_VERSION}-"*) product_revision="${product_version#${LICHTBLICK_UPSTREAM_VERSION}-}" ;;
  *)
    echo "Product version ${product_version} must be ${LICHTBLICK_UPSTREAM_VERSION}-<revision>." >&2
    exit 1
    ;;
esac
if [[ ! "${product_revision}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid product package revision: ${product_revision}." >&2
  exit 1
fi
if ! awk '
  /^apt:[[:space:]]*$/ { in_apt = 1; next }
  in_apt && /^[^[:space:]]/ { exit(found ? 0 : 1) }
  in_apt && /^[[:space:]]+depends:[[:space:]]*$/ { in_depends = 1; next }
  in_depends && /^[[:space:]]*-[[:space:]]*libasound2[[:space:]]*$/ { found = 1 }
  END { exit(found ? 0 : 1) }
' .xgc2/product.yml; then
  echo "apt.depends must include libasound2." >&2
  exit 1
fi

apt_version_for() {
  local distribution="$1"
  awk -v distribution="${distribution}" '
    /^release:[[:space:]]*$/ { in_release = 1; next }
    in_release && /^  apt_versions:[[:space:]]*$/ { in_versions = 1; next }
    in_versions && $0 ~ "^    " distribution ":[[:space:]]*" {
      sub("^    " distribution ":[[:space:]]*", "")
      print
      exit
    }
    in_versions && !/^    / { exit }
  ' .xgc2/product.yml
}

for distribution in focal jammy noble; do
  expected="${product_version}~${distribution}"
  actual="$(apt_version_for "${distribution}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "release.apt_versions.${distribution} must be ${expected}; found ${actual:-<missing>}." >&2
    exit 1
  fi
done

if git ls-files | grep -E '(^|/)(\.work|\.ci|debs|node_modules)(/|$)|\.deb$' >/dev/null; then
  echo "Generated build or upstream source artifacts are tracked." >&2
  exit 1
fi
if rg -n 'apt@example\.com|StrictHostKeyChecking=(no|accept-new)' .xgc2 .github/workflows/apt-*.yml xgc2/launcher --glob '!check_package_compliance.sh'; then
  echo "Placeholder maintainer or insecure SSH host-key policy found." >&2
  exit 1
fi

validate_deb() {
  local deb="$1"
  local package version architecture maintainer relation value distribution control_dir contents_file
  package="$(dpkg-deb -f "${deb}" Package)"
  version="$(dpkg-deb -f "${deb}" Version)"
  architecture="$(dpkg-deb -f "${deb}" Architecture)"
  maintainer="$(dpkg-deb -f "${deb}" Maintainer)"
  [[ "${package}" == xgc2-lichtblick || "${package}" == xgc2-lichtblick-web ]]
  [[ "${architecture}" == amd64 || "${architecture}" == arm64 ]]
  [[ "${maintainer}" == 'XGC2 Packaging <lxk36@users.noreply.github.com>' ]]
  distribution="${version##*~}"
  [[ "${distribution}" == focal || "${distribution}" == jammy || "${distribution}" == noble ]]
  [[ "${version}" == "${product_version}~${distribution}" ]]
  if [[ "${package}" == xgc2-lichtblick ]]; then
    for relation in Provides Conflicts Replaces; do
      value="$(dpkg-deb -f "${deb}" "${relation}")"
      [[ ",${value// /}," == *",lichtblick,"* ]]
    done
    value="$(dpkg-deb -f "${deb}" Depends)"
    [[ ",${value// /}," == *",libasound2(>=1.0.16),"* ]]
    for dependency in libgtk-3-0 libnotify4 libnss3 libxtst6 xdg-utils libatspi2.0-0 libdrm2 libgbm1 libxcb-dri3-0; do
      value="$(dpkg-deb -f "${deb}" Depends)"
      [[ ",${value// /}," == *",${dependency},"* ]]
    done
    control_dir="$(mktemp -d)"
    dpkg-deb --control "${deb}" "${control_dir}"
    [[ -x "${control_dir}/postinst" && -x "${control_dir}/postrm" ]]
    grep -Fq "/opt/Lichtblick/lichtblick" "${control_dir}/postinst"
    grep -Fq "/usr/bin/lichtblick" "${control_dir}/postinst"
    grep -Fq 'rm -f /usr/bin/lichtblick' "${control_dir}/postrm"
    contents_file="${control_dir}/contents"
    dpkg-deb --contents "${deb}" > "${contents_file}"
    grep -Fq './opt/Lichtblick/LICENSE.electron.txt' "${contents_file}"
    grep -Fq './opt/Lichtblick/LICENSES.chromium.html' "${contents_file}"
    if grep -Eq '\./opt/Lichtblick/resources/(package-type|app-update\.yml)$' "${contents_file}"; then
      echo "Electron self-update metadata remains in ${deb}." >&2
      exit 1
    fi
    for doc_file in README.md upstream.lock LICENSE.upstream copyright; do
      grep -Fq "./usr/share/doc/xgc2-lichtblick/${doc_file}" "${contents_file}"
    done
    if grep -Fq './usr/share/doc/lichtblick/' "${contents_file}"; then
      echo "Legacy upstream documentation directory remains in ${deb}." >&2
      exit 1
    fi
    rm -rf "${control_dir}"
    return
  fi

  value="$(dpkg-deb -f "${deb}" Depends)"
  for dependency in ca-certificates libc6 libgcc-s1 libstdc++6; do
    [[ ",${value// /}," == *",${dependency},"* ]]
  done
  value="$(dpkg-deb -f "${deb}" Recommends)"
  case "${distribution}" in
    focal) expected_bridge="ros-noetic-foxglove-bridge" ;;
    jammy) expected_bridge="ros-humble-foxglove-bridge" ;;
    noble) expected_bridge="ros-jazzy-foxglove-bridge" ;;
  esac
  [[ ",${value// /}," == *",${expected_bridge},"* ]]
  control_dir="$(mktemp -d)"
  contents_file="${control_dir}/contents"
  dpkg-deb --control "${deb}" "${control_dir}"
  dpkg-deb --contents "${deb}" > "${contents_file}"
  grep -Fq './usr/bin/xgc2-lichtblick-web' "${contents_file}"
  grep -Fq './usr/lib/xgc2/lichtblick-web/node/bin/node' "${contents_file}"
  grep -Fq './usr/lib/xgc2/lichtblick-web/web/index.html' "${contents_file}"
  grep -Fq './usr/lib/xgc2/lichtblick-web/build-info.json' "${contents_file}"
  grep -Fq './etc/xgc2/lichtblick-web.env' "${contents_file}"
  [[ "$(cat "${control_dir}/conffiles")" == '/etc/xgc2/lichtblick-web.env' ]]
  if grep -Eq '\./(usr/)?lib/systemd/' "${contents_file}"; then
    echo "The web package must be managed by XGC Process Supervisor, not systemd." >&2
    exit 1
  fi
  rm -rf "${control_dir}"
}

if [[ -n "${deb_dir}" ]]; then
  mapfile -t debs < <(find "${deb_dir}" -maxdepth 1 -type f -name '*.deb' -print | sort)
  (( ${#debs[@]} == 2 )) || { echo "Expected desktop and web Debs in ${deb_dir}." >&2; exit 1; }
  for deb in "${debs[@]}"; do
    validate_deb "${deb}"
  done
fi

git diff --check
python3 -m unittest discover -s xgc2/tests -p 'test_*.py' -v
node --test xgc2/tests/test_lichtblick_web.js
echo "xgc2-lichtblick package compliance checks passed."
