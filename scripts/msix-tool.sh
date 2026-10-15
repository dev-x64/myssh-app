#!/bin/bash
# Builds the tool that packs the Windows version for the Microsoft Store.
#
#   scripts/msix-tool.sh
#
# The package the store takes (.msix) is made by Microsoft's makemsix. It
# is not offered ready-made for the Mac, so it is built here from
# Microsoft's sources, once: a few minutes, and it needs CMake
# (brew install cmake). What is kept is the tool and its library, in
# ~/.myssh/msix; the sources are removed afterwards.
#
# Environment:
#   MYSSH_MSIX_DIR     where the tool goes (default ~/.myssh/msix)
#   MYSSH_MSIX_SOURCE  a copy of the sources already built with
#                      "./makemac.sh --pack", to install from instead
set -euo pipefail

DEST="${MYSSH_MSIX_DIR:-$HOME/.myssh/msix}"
SOURCE="${MYSSH_MSIX_SOURCE:-}"

fail() { echo "msix-tool: $*" >&2; exit 1; }

BUILT=""
if [ -z "$SOURCE" ]; then
  command -v cmake > /dev/null || fail "CMake is needed: brew install cmake"
  SOURCE="$(mktemp -d)/msix-packaging"
  BUILT="yes"
  echo "msix-tool: fetching Microsoft's sources"
  git clone -q --depth 1 https://github.com/microsoft/msix-packaging.git "$SOURCE"
  echo "msix-tool: building (a few minutes)"
  (cd "$SOURCE" && ./makemac.sh --pack -arch "$(uname -m)" --skip-samples --skip-tests -sb > "$SOURCE/build.log" 2>&1) \
    || fail "the build failed; see $SOURCE/build.log"
fi
[ -x "$SOURCE/.vs/bin/makemsix" ] && [ -f "$SOURCE/.vs/lib/libmsix.dylib" ] || fail "no built tool in $SOURCE"

rm -rf "$DEST"
mkdir -p "$DEST/bin" "$DEST/lib"
cp "$SOURCE/.vs/bin/makemsix" "$DEST/bin/makemsix"
cp "$SOURCE/.vs/lib/libmsix.dylib" "$DEST/lib/libmsix.dylib"
# The tool looks for its library where it was built; point it at where it now is.
OLD_PATH="$(otool -l "$DEST/bin/makemsix" | awk '/LC_RPATH/ { found = 1 } found && /path / { print $2; exit }')"
install_name_tool -rpath "$OLD_PATH" "@executable_path/../lib" "$DEST/bin/makemsix"
# Changing a program undoes its signature, and macOS runs none without one.
codesign --force --sign - "$DEST/lib/libmsix.dylib" "$DEST/bin/makemsix" 2> /dev/null
# Asked nothing, it lists what it can do, and says so with a failure of its own.
SAID="$("$DEST/bin/makemsix" 2>&1 || true)"
grep -q "pack" <<< "$SAID" || fail "the tool was built but does not run"
[ -z "$BUILT" ] || rm -rf "$(dirname "$SOURCE")"
echo "msix-tool: ready at $DEST/bin/makemsix"
