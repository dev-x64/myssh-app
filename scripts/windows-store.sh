#!/bin/bash
# Packs the Windows build of MySSH into the package the Microsoft Store takes.
#
#   scripts/windows-store.sh <myssh.exe> <version> <out.msix>
#
# The store signs the package itself and keeps installed copies up to date,
# so the program packed here is one built without the release key: it does
# not look for updates on its own.
#
# The package has to carry the identity the store gave the app. It is on the
# app's "Product identity" page in Partner Center and goes into
# app.config.json:
#
#   "store": { "windows": {
#     "name": "12345Publisher.MySSH",          Package/Identity/Name
#     "publisher": "CN=01234567-89AB-...",      Package/Identity/Publisher
#     "publisherName": "Publisher",             Package/Properties/PublisherDisplayName
#     "displayName": "MySSH.app"                the name reserved for the app there
#   } }
#
# The store takes a package only if it is called by a name reserved for the
# app, so displayName has to be that name, letter for letter. Left out, it
# is "MySSH".
#
# Packing is done by Microsoft's own tool, built once by scripts/msix-tool.sh.
set -euo pipefail

EXE="${1:-}"
VERSION="${2:-}"
OUT="${3:-}"
# Paths are meant from where the script was called, not from where it works.
[ -z "$EXE" ] || [[ "$EXE" = /* ]] || EXE="$PWD/$EXE"
[ -z "$OUT" ] || [[ "$OUT" = /* ]] || OUT="$PWD/$OUT"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TOOL="${MYSSH_MAKEMSIX:-$HOME/.myssh/msix/bin/makemsix}"

fail() { echo "windows-store: $*" >&2; exit 1; }

[ -f "$EXE" ] || fail "no such program: $EXE"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "give a version like 0.2.0"
[ -n "$OUT" ] || fail "say where the package goes"
[ -x "$TOOL" ] || fail "the packing tool is not built yet; run scripts/msix-tool.sh"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/Assets"
cp "$EXE" "$STAGE/MySSH.exe"
# The pictures Windows shows for the app: in the Start menu, on the taskbar
# and in the store. Plain names only: sized variants would need an index
# that only Windows' own tools can make.
for PICTURE in "StoreLogo 50" "Square44x44Logo 44" "Square150x150Logo 150"; do
  set -- $PICTURE
  sips -s format png -z "$2" "$2" src-tauri/icons/icon.png --out "$STAGE/Assets/$1.png" > /dev/null
done

python3 - "$VERSION" "$STAGE/AppxManifest.xml" <<'PY'
import json, re, sys
from xml.sax.saxutils import quoteattr, escape

version, out = sys.argv[1:3]
given = json.load(open("app.config.json")).get("store", {}).get("windows", {})
name, publisher, shown = (str(given.get(key) or "").strip() for key in ("name", "publisher", "publisherName"))
called = str(given.get("displayName") or "MySSH").strip()
if not (name and publisher and shown):
    sys.exit("windows-store: app.config.json has no store.windows (name, publisher, publisherName); "
             "they are on the app's Product identity page in Partner Center")
if not re.fullmatch(r"[A-Za-z0-9.-]{3,50}", name):
    sys.exit(f"windows-store: store.windows.name does not look like a package name: {name}")
if not publisher.startswith("CN="):
    sys.exit(f"windows-store: store.windows.publisher should begin with CN=: {publisher}")

open(out, "w", encoding="utf-8").write(f"""<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name={quoteattr(name)} Publisher={quoteattr(publisher)} Version="{version}.0" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>{escape(called)}</DisplayName>
    <PublisherDisplayName>{escape(shown)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.22621.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
    <Resource Language="ru-ru" />
  </Resources>
  <Applications>
    <Application Id="MySSH" Executable="MySSH.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName={quoteattr(called)}
        Description="SSH client: terminals, files and keys, synced end to end"
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png" />
      <Extensions>
        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="myssh">
            <uap:DisplayName>MySSH invitation</uap:DisplayName>
          </uap:Protocol>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
""")
PY

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
"$TOOL" pack -d "$STAGE" -p "$OUT" > /dev/null || fail "the package could not be made"
# Read back by the same tool, which checks it as Windows would, bar the
# signature: that is the store's to add.
CHECK="$(mktemp -d)"
"$TOOL" unpack -p "$OUT" -d "$CHECK" -ss > /dev/null || { rm -rf "$CHECK"; fail "the package does not read back"; }
rm -rf "$CHECK"
echo "windows-store: packed $OUT"
