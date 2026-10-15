#!/bin/bash
# Creates the key that MySSH releases are signed with. Run once, on the
# machine that builds releases:
#
#   scripts/updater-key.sh
#
# The private key is written outside the repository (default
# ~/.myssh/updater.key), encrypted with a password you choose here. Its
# public half goes into app.config.json, from where it is built into the
# app: an installed app accepts only updates signed with this key.
#
# Keep a copy of the key file and remember the password. Whoever has both
# can publish updates; if they are lost, installed apps can no longer be
# updated and everyone has to reinstall by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${MYSSH_UPDATER_KEY:-$HOME/.myssh/updater.key}"

if [ -e "$KEY" ]; then
  echo "A key already exists at $KEY; it is not replaced." >&2
  echo "Apps built with it would stop accepting updates signed by a new one." >&2
  exit 1
fi

read -r -s -p "Password for the release key: " PASSWORD; echo
read -r -s -p "Once more: " AGAIN; echo
if [ "$PASSWORD" != "$AGAIN" ]; then
  echo "The passwords differ." >&2
  exit 1
fi
if [ "${#PASSWORD}" -lt 10 ]; then
  echo "Use at least 10 characters." >&2
  exit 1
fi

mkdir -p "$(dirname "$KEY")"
chmod 700 "$(dirname "$KEY")"
(cd "$ROOT" && npx tauri signer generate --ci -w "$KEY" -p "$PASSWORD" > /dev/null)
chmod 600 "$KEY"

python3 - "$ROOT/app.config.json" "$KEY.pub" <<'PY'
import json, sys
path, pub = sys.argv[1], open(sys.argv[2]).read().strip()
config = json.load(open(path))
config.setdefault("updates", {})["pubkey"] = pub
open(path, "w").write(json.dumps(config, indent=2, ensure_ascii=False) + "\n")
PY

echo
echo "Private key: $KEY (back it up, together with the password)"
echo "Public key:  written to app.config.json; commit that change."
echo "Apps built from now on update themselves; publish with scripts/release.sh."
