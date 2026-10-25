#!/bin/bash
# Builds MySSH for Android by hand. Releases build it from the menu of
# scripts/release.sh; this is for the times in between.
#
#   scripts/android-build.sh          the release: the .aab for Google Play, into release/android/
#   scripts/android-build.sh debug    a development .apk to install on a phone, signed by Android's debug key
#   scripts/android-build.sh dev      runs the app on a connected phone or a started
#                                     emulator, its window reloading as the sources change
#
# The tools it needs, and how to get them, are in scripts/android-env.sh;
# the release key is made once with scripts/android-key.sh.
#
# Environment:
#   MYSSH_ANDROID_KEYSTORE           the key (default ~/.myssh/android-release.jks)
#   MYSSH_ANDROID_KEYSTORE_PASSWORD  its password; asked for when not set
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "android-build: $*" >&2; exit 1; }

# shellcheck source=android-env.sh
source scripts/android-env.sh
if [ "${#ANDROID_MISSING[@]}" -gt 0 ]; then
  echo "android-build: first install what is missing:" >&2
  printf '  %s\n' "${ANDROID_MISSING[@]}" >&2
  exit 1
fi
[ -d node_modules ] || npm install

case "${1:-}" in
  dev)
    exec npx tauri android dev
    ;;
  debug)
    npx tauri android build --debug --apk
    echo "android-build: $ANDROID_OUTPUTS/apk/universal/debug/app-universal-debug.apk"
    exit 0
    ;;
esac

export MYSSH_ANDROID_KEYSTORE="${MYSSH_ANDROID_KEYSTORE:-$HOME/.myssh/android-release.jks}"
[ -f "$MYSSH_ANDROID_KEYSTORE" ] || fail "no key at $MYSSH_ANDROID_KEYSTORE: make it once with scripts/android-key.sh"
if [ -z "${MYSSH_ANDROID_KEYSTORE_PASSWORD+set}" ]; then
  read -r -s -p "Password for the Android key: " MYSSH_ANDROID_KEYSTORE_PASSWORD; echo
fi
export MYSSH_ANDROID_KEYSTORE_PASSWORD

VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
npx tauri android build --aab

OUT="release/android"
mkdir -p "$OUT"
cp "$ANDROID_OUTPUTS/bundle/universalRelease/app-universal-release.aab" "$OUT/MySSH_${VERSION}_android.aab"
echo "android-build: MySSH $VERSION for Google Play: $OUT/MySSH_${VERSION}_android.aab"
