#!/bin/bash
# Draws the installer window's background from src-tauri/dmg/background.html.
# Run it after changing that file; the result, background.tiff, is what the
# release script uses and is kept in the repository. Needs Google Chrome.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/dmg"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome is needed to draw the background" >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
for SCALE in 1 2; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$WORK/profile" \
    --window-size=660,440 --force-device-scale-factor="$SCALE" \
    --screenshot="$WORK/background@$SCALE.png" "file://$PWD/background.html" > /dev/null 2>&1
done
# One file with both sizes, so the picture is sharp on any display.
tiffutil -cathidpicheck "$WORK/background@1.png" "$WORK/background@2.png" -out background.tiff > /dev/null
cp "$WORK/background@2.png" background-preview.png
echo "written: src-tauri/dmg/background.tiff"
