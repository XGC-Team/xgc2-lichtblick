#!/usr/bin/env bash
set -euo pipefail

# First-party products are installed at build/install-check time, never baked
# into the toolchain image. Third-party build tools remain image-owned.
: "${PACKAGE_DISTRIBUTION:?}"
base_url=https://xgc2.apt.xiaokang.ink
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --location --retry 5 \
  "${base_url}/xgc2-archive-keyring.gpg" -o /etc/apt/keyrings/xgc2-archive-keyring.gpg
chmod 0644 /etc/apt/keyrings/xgc2-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/xgc2-archive-keyring.gpg] %s %s main\n' \
  "$(dpkg --print-architecture)" "${base_url}" "${PACKAGE_DISTRIBUTION}" \
  > /etc/apt/sources.list.d/xgc2.list
if [[ -n "${XGC2_APT_OVERLAY_URL:-}" ]]; then
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/xgc2-archive-keyring.gpg] %s %s main\n' \
    "$(dpkg --print-architecture)" "${XGC2_APT_OVERLAY_URL%/}" "${PACKAGE_DISTRIBUTION}" \
    > /etc/apt/sources.list.d/xgc2-overlay.list
fi
apt-get update
