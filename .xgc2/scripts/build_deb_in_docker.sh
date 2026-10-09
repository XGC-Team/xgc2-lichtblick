#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
# shellcheck disable=SC1090
source "${repo_root}/xgc2/upstream.lock"

ubuntu_version="${UBUNTU_VERSION:-20.04}"
architecture="${TARGET_ARCH:-$(dpkg --print-architecture)}"
docker_image=""
docker_network="${DOCKER_NETWORK:-}"
work_dir="${WORK_DIR:-${repo_root}/.work/docker-${ubuntu_version}-${architecture}}"
output_dir="${OUTPUT_DIR:-${repo_root}/debs}"

usage() {
  cat <<'EOF'
usage: build_deb_in_docker.sh [options]

  --ubuntu-version <20.04|22.04|24.04>
  --architecture <amd64|arm64>
  --image <container-image>
  --network <docker-network>
  --work-dir <path>
  --output-dir <path>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ubuntu-version) ubuntu_version="$2"; shift 2 ;;
    --architecture) architecture="$2"; shift 2 ;;
    --image) docker_image="$2"; shift 2 ;;
    --network) docker_network="$2"; shift 2 ;;
    --work-dir) work_dir="$2"; shift 2 ;;
    --output-dir) output_dir="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "${ubuntu_version}" in
  20.04) distribution=focal ;;
  22.04) distribution=jammy ;;
  24.04) distribution=noble ;;
  *) echo "Unsupported Ubuntu version: ${ubuntu_version}" >&2; exit 2 ;;
esac
case "${architecture}" in
  amd64) docker_platform=linux/amd64 ;;
  arm64) docker_platform=linux/arm64 ;;
  *) echo "Unsupported architecture: ${architecture}" >&2; exit 2 ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

approved_image="ghcr.io/xgc-team/xgc2-images/xgc2-build-${distribution}-dev:${LICHTBLICK_BUILD_IMAGE_TAG}"
if [[ -n "${docker_image}" && "${docker_image}" != "${approved_image}" ]]; then
  echo "--image must match the approved XGC2 build image: ${approved_image}" >&2
  exit 1
fi
docker_image="${approved_image}"
mkdir -p "${work_dir}" "${output_dir}"
work_dir="$(cd "${work_dir}" && pwd -P)"
source_sha="$(git -C "${repo_root}" rev-parse HEAD)"
source_epoch="$(git -C "${repo_root}" show -s --format=%ct HEAD)"
# Build the committed checkout, never a second clone or concurrent editor WIP.
build_root="$(mktemp -d "${work_dir}/build.XXXXXXXX")"
trap 'rm -rf -- "${build_root}"' EXIT
mkdir -p "${build_root}/source" "${build_root}/work"
git -C "${repo_root}" archive "${source_sha}" | tar -x -C "${build_root}/source"
work_dir="$(cd "${work_dir}" && pwd -P)"
output_dir="$(cd "${output_dir}" && pwd -P)"

docker pull --platform "${docker_platform}" "${docker_image}"
docker_run_args=(--rm --platform "${docker_platform}")
if [[ -n "${docker_network}" ]]; then
  docker_run_args+=(--network "${docker_network}")
fi
if [[ "${docker_network}" == host ]]; then
  proxy_forwarded=false
  for proxy_variable in \
    HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY \
    http_proxy https_proxy all_proxy no_proxy; do
    if [[ -n "${!proxy_variable:-}" ]]; then
      docker_run_args+=(-e "${proxy_variable}")
      case "${proxy_variable}" in
        HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy)
          proxy_forwarded=true
          ;;
      esac
    fi
  done
  if [[ "${proxy_forwarded}" == true ]]; then
    docker_run_args+=(-e "ELECTRON_GET_USE_PROXY=1")
  fi
fi
# The final argument is a script intentionally passed as a single string to
# `bash -c`; its continuations are interpreted inside the container.
# shellcheck disable=SC1004
docker run "${docker_run_args[@]}" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -w /workspace/source \
  -e XGC2_SOURCE_SHA="${source_sha}" -e SOURCE_DATE_EPOCH="${source_epoch}" \
  -e XGC2_APT_OVERLAY_URL="${XGC2_APT_OVERLAY_URL:-}" \
  -e DEBIAN_FRONTEND=noninteractive \
  -e PACKAGE_DISTRIBUTION="${distribution}" \
  -e TARGET_ARCH="${architecture}" \
  -e LICHTBLICK_BUILD_WORK_DIR=/workspace/work/repack \
  -e LICHTBLICK_WEB_BUILD_WORK_DIR=/workspace/work/web-repack \
  -e OUTPUT_DIR=/workspace/out \
  -v "${build_root}/source:/workspace/source" \
  -v "${build_root}/work:/workspace/work" \
  -v "${output_dir}:/workspace/out" \
  "${docker_image}" \
  bash -c '
    set -euo pipefail

    # shellcheck disable=SC1091
    source /workspace/source/xgc2/upstream.lock
    for command in bsdtar corepack curl dpkg-deb fakeroot file git node python3 \
      xvfb-run; do
      if ! command -v "${command}" >/dev/null; then
        echo "XGC2 build image is missing Lichtblick tool: ${command}" >&2
        exit 1
      fi
    done
    if [[ "$(node --version)" != "v${LICHTBLICK_NODE_VERSION}" ]]; then
      echo "XGC2 build image Node mismatch: expected v${LICHTBLICK_NODE_VERSION}, found $(node --version)" >&2
      exit 1
    fi

    case "${TARGET_ARCH}" in
      amd64)
        fpm_archive="${LICHTBLICK_FPM_AMD64_ARCHIVE}"
        fpm_sha256="${LICHTBLICK_FPM_AMD64_SHA256}"
        ;;
      arm64)
        fpm_archive="${LICHTBLICK_FPM_ARM64_ARCHIVE}"
        fpm_sha256="${LICHTBLICK_FPM_ARM64_SHA256}"
        ;;
    esac
    fpm_url="https://github.com/electron-userland/electron-builder-binaries/releases/download/fpm%40${LICHTBLICK_FPM_RELEASE}/${fpm_archive}"
    curl --fail --location --retry 5 --retry-connrefused --retry-delay 2 \
      --output "/tmp/${fpm_archive}" \
      "${fpm_url}"
    printf "%s  %s\n" "${fpm_sha256}" "/tmp/${fpm_archive}" \
      | sha256sum --check --strict
    install -d /tmp/xgc2-fpm
    bsdtar -xf "/tmp/${fpm_archive}" -C /tmp/xgc2-fpm
    rm -f "/tmp/${fpm_archive}"
    test -x /tmp/xgc2-fpm/fpm
    test -x "/tmp/xgc2-fpm/ruby-${LICHTBLICK_FPM_RUBY_VERSION}-portable/bin/ruby"
    case "${TARGET_ARCH}" in
      amd64)
        file "/tmp/xgc2-fpm/ruby-${LICHTBLICK_FPM_RUBY_VERSION}-portable/bin/ruby" \
          | grep -Eq "x86-64|x86_64"
        ;;
      arm64)
        file "/tmp/xgc2-fpm/ruby-${LICHTBLICK_FPM_RUBY_VERSION}-portable/bin/ruby" \
          | grep -Eq "aarch64|ARM aarch64"
        ;;
    esac
    export PATH="/tmp/xgc2-fpm:${PATH}"
    export USE_SYSTEM_FPM=true
    if [[ "$(fpm --version)" != "${LICHTBLICK_FPM_VERSION}" ]]; then
      echo "Pinned FPM mismatch: expected ${LICHTBLICK_FPM_VERSION}, found $(fpm --version)" >&2
      exit 1
    fi
    if [[ "$(corepack yarn --version)" != "${LICHTBLICK_YARN_VERSION}" ]]; then
      echo "XGC2 build image Yarn mismatch: expected ${LICHTBLICK_YARN_VERSION}" >&2
      exit 1
    fi

    if [[ "$(dpkg --print-architecture)" != "${TARGET_ARCH}" ]]; then
      echo "Container architecture does not match ${TARGET_ARCH}." >&2
      exit 1
    fi

    /workspace/source/.xgc2/scripts/build_deb.sh
    /workspace/source/.xgc2/scripts/build_web_deb.sh

  '

# Installation needs root only inside this disposable container. All host
# mounts are read-only here; the build above owns its outputs as the caller.
docker run "${docker_run_args[@]}" \
  -e DEBIAN_FRONTEND=noninteractive \
  -e PACKAGE_DISTRIBUTION="${distribution}" -e TARGET_ARCH="${architecture}" \
  -v "${build_root}/source:/workspace/source:ro" \
  -v "${output_dir}:/workspace/out:ro" \
  "${docker_image}" bash -c '
    set -euo pipefail
    product_version="$(sed -n "s/^version:[[:space:]]*//p" /workspace/source/.xgc2/product.yml | head -n 1)"
    desktop_deb="/workspace/out/xgc2-lichtblick_${product_version}~${PACKAGE_DISTRIBUTION}_${TARGET_ARCH}.deb"
    web_deb="/workspace/out/xgc2-lichtblick-web_${product_version}~${PACKAGE_DISTRIBUTION}_${TARGET_ARCH}.deb"
    for built_deb in "${desktop_deb}" "${web_deb}"; do
      if [[ ! -f "${built_deb}" ]]; then
        echo "Expected exact package is missing: ${built_deb}" >&2
        exit 1
      fi
    done

    # Official Ubuntu container images discard /usr/share/doc by default.
    # Re-include this package only so the installed-package smoke test checks
    # the documentation that a normal Ubuntu installation receives.
    printf "%s\n" \
      "path-include=/usr/share/doc/xgc2-lichtblick/" \
      "path-include=/usr/share/doc/xgc2-lichtblick/*" \
      "path-include=/usr/share/doc/xgc2-lichtblick-web/" \
      "path-include=/usr/share/doc/xgc2-lichtblick-web/*" \
      > /etc/dpkg/dpkg.cfg.d/zz-xgc2-lichtblick-smoke-docs
    apt-get install -y --no-install-recommends "${desktop_deb}" "${web_deb}"
    NODE_PATH=/usr/lib/xgc2/node_modules node --test /workspace/source/xgc2/tests/test_lichtblick_web.js
    /workspace/source/.xgc2/scripts/smoke_test_installed.sh
    /workspace/source/.xgc2/scripts/smoke_test_web_installed.sh
    apt-get purge -y xgc2-lichtblick xgc2-lichtblick-web
    for package in xgc2-lichtblick xgc2-lichtblick-web; do
      if dpkg-query -W -f="\${db:Status-Abbrev}" "${package}" 2>/dev/null | grep -q "^ii"; then
        echo "${package} is still installed after purge." >&2
        exit 1
      fi
    done
    test ! -e /usr/bin/lichtblick
    test ! -L /usr/bin/lichtblick
    test ! -e /opt/Lichtblick
    test ! -e /usr/bin/xgc2-lichtblick-web
    test ! -e /usr/lib/xgc2/lichtblick-web
  '

echo "Validated Debian artifact(s):"
find "${output_dir}" -maxdepth 1 -type f -name '*.deb' -print | sort
