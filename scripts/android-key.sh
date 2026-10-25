#!/bin/bash
# Makes the key Android releases of MySSH are signed with.
#
#   scripts/android-key.sh
#
# Android installs an update only when it is signed with the same key as
# the copy already installed, and Google Play binds an app to its key (or,
# with Play App Signing, to this upload key). Lose it, and installed copies
# can no longer be updated: keep a copy of the file and its password apart.
#
# It is kept outside the repository, under a password:
#   ~/.myssh/android-release.jks
#
# Environment:
#   MYSSH_ANDROID_KEYSTORE         where it goes (default as above)
#   MYSSH_ANDROID_KEYSTORE_PASSWORD  its password; asked for when not set
set -euo pipefail

KEYSTORE="${MYSSH_ANDROID_KEYSTORE:-$HOME/.myssh/android-release.jks}"
ALIAS=myssh
YEARS=30

fail() { echo "android-key: $*" >&2; exit 1; }

[ ! -e "$KEYSTORE" ] || fail "there is a key at $KEYSTORE already; move it away first if it is to be replaced"
# The JDK's own keytool: /usr/bin/keytool on a Mac is a stand-in that works
# only with a JDK installed for the whole system.
KEYTOOL=""
for candidate in "${JAVA_HOME:-}/bin/keytool" /opt/homebrew/opt/openjdk@17/bin/keytool \
  "$(/usr/libexec/java_home 2> /dev/null)/bin/keytool"; do
  if [ -x "$candidate" ]; then KEYTOOL="$candidate"; break; fi
done
[ -n "$KEYTOOL" ] || fail "keytool is not found: install a JDK (brew install openjdk@17)"

if [ -z "${MYSSH_ANDROID_KEYSTORE_PASSWORD+set}" ]; then
  read -r -s -p "Password for the key (6 characters or more): " MYSSH_ANDROID_KEYSTORE_PASSWORD; echo
  read -r -s -p "Once more: " AGAIN; echo
  [ "$MYSSH_ANDROID_KEYSTORE_PASSWORD" = "$AGAIN" ] || fail "the two do not match"
fi
[ ${#MYSSH_ANDROID_KEYSTORE_PASSWORD} -ge 6 ] || fail "the password must have 6 characters or more"
export MYSSH_ANDROID_KEYSTORE_PASSWORD

mkdir -p "$(dirname "$KEYSTORE")"
(umask 077 && "$KEYTOOL" -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity $((YEARS * 365)) -dname "CN=MySSH, O=MySSH" \
  -storepass:env MYSSH_ANDROID_KEYSTORE_PASSWORD > /dev/null) || fail "the key could not be made"

echo "android-key: made the key Android releases are signed with, good for $YEARS years:"
echo "  $KEYSTORE"
echo "scripts/android-build.sh signs with it from now on. Keep a copy of it, and of its password, somewhere safe."
