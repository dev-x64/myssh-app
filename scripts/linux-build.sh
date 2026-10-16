#!/bin/bash
# Builds MySSH for Linux (x86_64) in a Docker container on this Mac: an
# AppImage, run from wherever it is saved and what copies update from (the
# app offers to put itself in the applications menu). No .deb: a copy
# installed that way could not update itself.
#
#   scripts/linux-build.sh <out dir> [tauri config JSON]
#
# The container is amd64; on Apple Silicon Docker runs it through Rosetta
# (OrbStack, or Docker Desktop with Rosetta turned on). The sources are
# shared with it as they are; its node_modules, its cargo cache and what it
# builds stay in volumes of their own, so nothing of the Mac's is touched
# but dist/, which the front end is built into as on the Mac.
#
# With TAURI_SIGNING_PRIVATE_KEY (and its password) in the environment, the
# AppImage is signed for updates, as the other systems' archives are.

set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:?where to put what is built}"
CONFIG="${2:-}"
IMAGE="myssh-linux-build"

command -v docker > /dev/null || { echo "linux: нужен Docker (OrbStack или Docker Desktop)" >&2; exit 1; }
docker info > /dev/null 2>&1 || { echo "linux: Docker не запущен" >&2; exit 1; }

docker build --quiet --platform linux/amd64 -t "$IMAGE" scripts/linux > /dev/null

ARGS=()
[ -z "$CONFIG" ] || ARGS=(-c "$CONFIG")
mkdir -p "$OUT"
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src -w /src \
  -v myssh-linux-node:/src/node_modules \
  -v myssh-linux-cargo:/root/.cargo/registry \
  -v myssh-linux-target:/target \
  -v "$(cd "$OUT" && pwd)":/out \
  -e CARGO_TARGET_DIR=/target \
  -e TAURI_SIGNING_PRIVATE_KEY -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD -e MYSSH_UPDATE_PUBKEY \
  "$IMAGE" bash -c '
    set -euo pipefail
    npm ci --no-audit --no-fund --loglevel=error
    npx tauri build --bundles appimage "$@"
    find /target/release/bundle/appimage -maxdepth 1 -type f \
      \( -name "*.AppImage" -o -name "*.AppImage.sig" \) -exec cp {} /out/ \;
  ' bash ${ARGS[@]+"${ARGS[@]}"}
ls -1 "$OUT"
