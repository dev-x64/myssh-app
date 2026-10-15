#!/bin/bash
# Signs one Windows program with the certificate; the build calls it for
# the app and for its installer.
#
#   scripts/windows-sign.sh <file.exe>
#
# Signing is done by osslsigncode (brew install osslsigncode), which does on
# a Mac what signtool does on Windows. The signature is stamped with the
# time by a public time-stamping service, so that it outlives the
# certificate; if the service cannot be reached the file is signed without.
#
# This is the one place to change when the certificate stops being a file:
# a certificate kept on a token or by a signing service is used with other
# options, or another tool.
#
# Environment:
#   MYSSH_WINDOWS_CERT           the .pfx (default ~/.myssh/windows-cert.pfx)
#   MYSSH_WINDOWS_CERT_PASSWORD  its password
set -euo pipefail

FILE="${1:-}"
CERT="${MYSSH_WINDOWS_CERT:-$HOME/.myssh/windows-cert.pfx}"
STAMP="${MYSSH_WINDOWS_TIMESTAMP:-http://timestamp.digicert.com}"

fail() { echo "windows-sign: $*" >&2; exit 1; }

[ -f "$FILE" ] || fail "no such file: $FILE"
[ -f "$CERT" ] || fail "no certificate at $CERT; scripts/windows-cert.sh makes one"
command -v osslsigncode > /dev/null || fail "osslsigncode is needed: brew install osslsigncode"

# What the signer said when it failed, to pass on.
SAID=""
sign() {
  # The password goes in through a pipe, not on a command line others can see.
  SAID="$(printf '%s' "${MYSSH_WINDOWS_CERT_PASSWORD:-}" | osslsigncode sign -pkcs12 "$CERT" -readpass - \
    -n "MySSH" -i "https://myssh.app" -h sha256 ${@+"$@"} -in "$FILE" -out "$FILE.signed" 2>&1)"
}
rm -f "$FILE.signed"
if ! sign -ts "$STAMP"; then
  rm -f "$FILE.signed"
  sign || fail "$(basename "$FILE") could not be signed (the signer said: $(grep -v '^$' <<< "$SAID" | tail -n 1)). Is the certificate's password right?"
  echo "windows-sign: $(basename "$FILE") is signed, but without a time stamp: $STAMP did not answer" >&2
fi
mv "$FILE.signed" "$FILE"
