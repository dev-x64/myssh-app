#!/bin/bash
# Makes a certificate of your own to sign the Windows installer with.
#
#   scripts/windows-cert.sh ["Publisher name"]
#
# The certificate is self-made. It seals the installer against tampering
# and says whose it is to anyone who looks, but Windows trusts only
# certificates issued by a certificate authority: it will still warn before
# running the installer, and name no publisher. This one is a stand-in until
# there is an issued certificate. That one goes in the same place, as a .pfx
# file, and nothing else has to change.
#
# It is kept outside the repository, under a password:
#   ~/.myssh/windows-cert.pfx   the certificate with its key
#   ~/.myssh/windows-cert.cer   the certificate alone, to give to a Windows
#                               machine that should trust the installer
#
# Environment:
#   MYSSH_WINDOWS_CERT           where the .pfx goes (default as above)
#   MYSSH_WINDOWS_CERT_PASSWORD  its password; asked for when not set
set -euo pipefail

CERT="${MYSSH_WINDOWS_CERT:-$HOME/.myssh/windows-cert.pfx}"
NAME="${1:-MySSH}"
YEARS=3

fail() { echo "windows-cert: $*" >&2; exit 1; }

[ ! -e "$CERT" ] || fail "there is a certificate at $CERT already; move it away first if it is to be replaced"
[[ "$NAME" =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]] || fail "the name may have letters, digits, spaces, dots and dashes"
# The system's own OpenSSL is an old LibreSSL; Homebrew's is what makes a file Windows tools read.
OPENSSL="$(brew --prefix openssl@3 2> /dev/null)/bin/openssl"
[ -x "$OPENSSL" ] || OPENSSL="$(command -v openssl)"

if [ -z "${MYSSH_WINDOWS_CERT_PASSWORD+set}" ]; then
  read -r -s -p "Password for the certificate: " MYSSH_WINDOWS_CERT_PASSWORD; echo
  read -r -s -p "Once more: " AGAIN; echo
  [ "$MYSSH_WINDOWS_CERT_PASSWORD" = "$AGAIN" ] || fail "the two do not match"
fi
export MYSSH_WINDOWS_CERT_PASSWORD

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
"$OPENSSL" req -x509 -newkey rsa:3072 -sha256 -days $((YEARS * 365)) -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -subj "/CN=$NAME/O=$NAME" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" 2> /dev/null || fail "the certificate could not be made"
mkdir -p "$(dirname "$CERT")"
(umask 077 && "$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$CERT" -passout env:MYSSH_WINDOWS_CERT_PASSWORD) || fail "the certificate could not be stored"
"$OPENSSL" x509 -in "$WORK/cert.pem" -outform DER -out "${CERT%.pfx}.cer"

echo "windows-cert: made a certificate for \"$NAME\", good for $YEARS years:"
echo "  $CERT"
echo "  ${CERT%.pfx}.cer"
echo "Releases sign the Windows installer with it from now on. Windows does not trust it:"
echo "people will still be warned before the installer runs."
