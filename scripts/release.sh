#!/bin/bash
# Builds, signs and publishes a release of MySSH.
#
#   scripts/release.sh                       asks, with menus
#   scripts/release.sh 0.2.0 [notes.txt]     asks nothing but the passwords
#   scripts/release.sh test                  a test build, asking nothing
#
# A test build ("Тестовая сборка" in the menu) is for trying the app out
# quickly: just MySSH Test.app, MySSH Test.exe and MySSH Test.apk (for
# phones and the emulator, 64-bit ARM) in release/test/, with
# no installers, no signatures, no version change and no commit, from the
# sources as they are, committed or not. It is a separate app (its own
# identifier, its own data, no updating itself), so it never touches the
# installed MySSH, and it talks either to the backend in Docker on this
# Mac, started for it from ../myssh-cloud (MYSSH_CLOUD_DIR), or to the real
# server. With Windows or Android in it, the backend is published on this
# Mac's address in the local network, which only test builds accept over
# plain HTTP; with the Mac alone it stays on 127.0.0.1.
#
# Run without arguments, it shows where things stand (the current version,
# what was committed since, whether the tools and keys are in place), then
# asks which version to make, for which systems (ticked in a list) and with
# what notes, sums it all up and builds once that is confirmed. Afterwards
# it offers the next steps: the panel to publish on, the files in Finder,
# git push.
#
# In order:
#   1. sets the version in Cargo.toml, tauri.conf.json and package.json;
#   2. builds the app for the Mac (one app for both Apple silicon and Intel)
#      and its update archive, signed with the release key, then the app for Windows, built here on the Mac, and,
#      when asked, for Linux, in Docker (scripts/linux-build.sh), and for
#      Android: the .aab uploaded to Google Play, signed with the Android
#      key (scripts/android-key.sh makes it; the menu offers to when it is
#      missing). Google Play is the one place the Android app comes from;
#      inside it nothing is sold (see SELLS_PRO in src/lib/platform.ts);
#   3. collects release/<version>/: the archive Macs update from and a .dmg
#      for first installs, the installer Windows both installs and updates
#      from, the AppImage Linux does the same with, and latest.json that
#      describes them all; the Android bundle goes to release/<version>/android/,
#      apart from what is uploaded to the panel (phones take their updates
#      from Google Play);
#   4. commits the version change and tags it v<version> (nothing is pushed
#      unless asked for in the menu at the end).
#
# The tags are the record of what was released: a new version has to be
# newer than the last tagged one, whatever the version files say. With the
# tags deleted, numbering starts over (it did, at 0.1.0, for the first
# public release).
#
# Afterwards it tidies up: the bundle the build left under target/ (its
# contents are in release/<version>/ by then), the built front end, and the
# cache of development builds. Earlier releases stay in release/. A run that
# fails puts the version files back as they were, so that nothing is left
# half done. A run during which the sources were edited fails too: what it
# built cannot be trusted.
#
# Publishing is done on the cloud server's panel. With the token made on
# its settings page ("Выпуски" tab) saved in ~/.myssh/panel-token, this
# script uploads release/<version>/ there itself (scripts/release-upload.py)
# and names the page to look it over on; without it, open
# <cloud server>/admin/updates and upload the files by hand. Either way the
# version reaches nobody until it is sent from that page: installed apps
# are offered it from that moment.
#
# The Mac app and its disk image are signed with the Apple Developer ID
# certificate in the keychain ("Developer ID Application: ..."), and then
# notarized by Apple and stapled, so that macOS opens them without warnings.
# Notarizing uses a profile notarytool keeps in the keychain, saved once:
#
#   xcrun notarytool store-credentials myssh-notary \
#     --apple-id <Apple ID> --team-id <team ID from the certificate's name>
#
# (it asks for an app-specific password, made at account.apple.com). With
# no certificate the app is signed ad hoc, as before; with no profile it is
# signed but not notarized.
#
# The Windows installer is signed with the certificate in
# ~/.myssh/windows-cert.pfx when there is one (scripts/windows-cert.sh makes
# a self-made one). Without it the installer is left unsigned; either way
# Windows warns before running it until the certificate is an issued one.
#
# The notes are what users read in the update dialog; they can also be
# typed in on the panel. The menu keeps them in notes.txt (not in git) and
# can open an editor on them, with the commits since the last release
# listed underneath as a reminder.
#
# Environment:
#   MYSSH_UPDATER_KEY     the key from scripts/updater-key.sh
#                         (default ~/.myssh/updater.key)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD
#                         its password; asked for when not set
#   MYSSH_RELEASE_WINDOWS "no" leaves Windows out. Building for it on a Mac
#                         takes tools this script names if they are missing.
#   MYSSH_WINDOWS_CERT    the certificate the installer is signed with
#                         (default ~/.myssh/windows-cert.pfx)
#   MYSSH_WINDOWS_CERT_PASSWORD
#                         its password; asked for when not set
#   MYSSH_RELEASE_LINUX   "no" leaves Linux out. By default Linux (x86_64) is
#                         built when Docker is running: an AppImage, which
#                         is also what copies update from, built in Docker.
#   MYSSH_RELEASE_ANDROID "no" leaves Android out. By default it is built
#                         when its tools (scripts/android-env.sh) and key are
#                         in place.
#   MYSSH_ANDROID_KEYSTORE
#                         the key Android builds are signed with
#                         (default ~/.myssh/android-release.jks)
#   MYSSH_ANDROID_KEYSTORE_PASSWORD
#                         its password; asked for when not set
#   MYSSH_RELEASE_STORE   "yes" also packs the Windows version for the
#                         Microsoft Store, into release/<version>/store/
#                         (see scripts/windows-store.sh). That one is built
#                         without the release key: the store updates it.
#   MYSSH_PANEL_TOKEN     the panel's token for uploading releases
#                         (default: the contents of ~/.myssh/panel-token)
#   MYSSH_RELEASE_GITHUB  "yes" also publishes the files as a release in
#                         the repository named by updates.repo in
#                         app.config.json (needs the GitHub CLI). Test
#                         builds made before numbering started over, up to
#                         the old 0.1.3, look for updates there and nowhere
#                         else.
#   MYSSH_MAC_IDENTITY    the certificate the Mac app is signed with (by
#                         default the first "Developer ID Application" one
#                         in the keychain); "no" signs it ad hoc
#   MYSSH_NOTARY_PROFILE  notarytool's saved profile (default myssh-notary);
#                         "no" leaves notarizing out
#   EDITOR / VISUAL       what the menu edits the notes in (default nano)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KEY="${MYSSH_UPDATER_KEY:-$HOME/.myssh/updater.key}"
# One Mac app for both kinds of processor: Apple silicon and Intel.
MAC_TARGET="universal-apple-darwin"
ARCH="universal"
TIMES="$HOME/.myssh/release-times"
# The panel's token for uploading a release: with it, this script uploads.
# The menu takes it pasted in and keeps it here.
PANEL_TOKEN_FILE="$HOME/.myssh/panel-token"
PANEL_TOKEN=""
[ -z "${MYSSH_PANEL_TOKEN:-}" ] && [ ! -s "$PANEL_TOKEN_FILE" ] || PANEL_TOKEN="yes"

case "${1:-}" in
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
esac

# Menus when nothing was given and someone is at the terminal.
MENU=""
TEST_ONLY=""
if [ "${1:-}" = "test" ]; then
  TEST_ONLY="yes"
  shift
fi
if [ $# -eq 0 ] && [ -z "$TEST_ONLY" ] && [ -t 0 ] && [ -t 1 ]; then
  MENU="yes"
  # The menus hide the cursor; it must come back however the script ends.
  trap 'printf "\033[?25h"' EXIT
fi
VERSION="${1:-}"
NOTES_FILE="${2:-}"

if [ -t 1 ]; then
  B=$'\033[1m' D=$'\033[2m' G=$'\033[32m' Y=$'\033[33m' RD=$'\033[31m' C=$'\033[36m' R=$'\033[0m'
else
  B="" D="" G="" Y="" RD="" C="" R=""
fi

fail() { echo "${RD}release:${R} $*" >&2; exit 1; }
ok() { echo "  ${G}✓${R} $*"; }
warn() { echo "  ${Y}!${R} $*"; }
bad() { echo "  ${RD}✗${R} $*"; }

# A notice in the corner of the screen: the build takes long enough to be
# left alone while it runs.
notify() {
  [ -n "$MENU" ] || return 0
  osascript -e "display notification \"$1\" with title \"MySSH\" sound name \"Glass\"" > /dev/null 2>&1 || true
}

# A menu worked with the arrows (or j/k, or the item's number) and Enter;
# q or Esc leaves the script. The item chosen is left in CHOICE, counted
# from 0.
CHOICE=0
# A menu line cut to the terminal's width, so that it never wraps: the
# menu redraws itself by moving up one line per item, and a wrapped item
# would leave copies of the menu behind. Colour codes take no room.
fit() {
  local text="$1" width="$2" plain out="" seen=0 i c
  # Counted in letters, not bytes, whatever the terminal's locale.
  local LC_ALL=en_US.UTF-8
  plain="$(printf '%s' "$text" | sed $'s/\033\\[[0-9;]*[A-Za-z]//g')"
  if [ "${#plain}" -le "$width" ]; then
    printf '%s' "$text"
    return
  fi
  for ((i = 0; i < ${#text}; i++)); do
    c="${text:i:1}"
    if [ "$c" = $'\033' ]; then
      while [ "$i" -lt "${#text}" ]; do
        c="${text:i:1}"
        out+="$c"
        [[ "$c" == [A-Za-z] ]] && break
        i=$((i + 1))
      done
      continue
    fi
    [ "$seen" -lt $((width - 1)) ] || break
    out+="$c"
    seen=$((seen + 1))
  done
  printf '%s…%s' "$out" "$R"
}

choose() {
  local title="$1" sel="$2"
  shift 2
  local items=() item width
  # Room left beside the marker ("  › "), with a column to spare.
  width=$(($(tput cols 2> /dev/null || echo 80) - 5))
  [ "$width" -ge 20 ] || width=20
  for item in "$@"; do items+=("$(fit "$item" "$width")"); done
  local n=$# i key rest
  echo
  echo "${B}$title${R}"
  printf '\033[?25l'
  while :; do
    for ((i = 0; i < n; i++)); do
      if [ "$i" -eq "$sel" ]; then
        printf '\r\033[K  %s› %s%s\n' "$C$B" "${items[$i]}" "$R"
      else
        printf '\r\033[K    %s\n' "${items[$i]}"
      fi
    done
    IFS= read -rsn1 key || key="q"
    case "$key" in
      $'\033')
        rest=""
        IFS= read -rsn2 -t 1 rest || true
        case "$rest" in
          '[A' | 'OA') [ "$sel" -eq 0 ] && sel=$((n - 1)) || sel=$((sel - 1)) ;;
          '[B' | 'OB') [ "$sel" -eq $((n - 1)) ] && sel=0 || sel=$((sel + 1)) ;;
          '') printf '\033[?25h'; echo; fail "отменено" ;;
        esac
        ;;
      k) [ "$sel" -eq 0 ] || sel=$((sel - 1)) ;;
      j) [ "$sel" -eq $((n - 1)) ] || sel=$((sel + 1)) ;;
      [1-9]) [ "$key" -gt "$n" ] || sel=$((key - 1)) ;;
      q | Q) printf '\033[?25h'; echo; fail "отменено" ;;
      '') break ;;
    esac
    printf '\033[%dA' "$n"
  done
  printf '\033[?25h'
  CHOICE=$sel
}

# A list of things to tick, worked like a menu: Enter on an item ticks it
# or unticks it, Enter on "Готово" (where the marker starts) goes on. It is
# drawn again in place after each tick. `label KEY` prints an item's line,
# `toggle KEY` ticks or unticks it, and may say why not with `say` (each
# line said is cleared with the list on the next draw); one that asks
# something itself sets CHECK_KEEP, and the list is then drawn below.
CHECK_SAID=0
CHECK_KEEP=""
say() {
  echo "  $*"
  CHECK_SAID=$((CHECK_SAID + 1))
}
checklist() {
  local title="$1" label="$2" toggle="$3"
  shift 3
  local keys=("$@") items key sel=$# drawn=""
  while :; do
    items=()
    for key in "${keys[@]}"; do items+=("$($label "$key")"); done
    items+=("${B}Готово${R}")
    if [ -n "$drawn" ] && [ -z "$CHECK_KEEP" ]; then
      printf '\033[%dA\033[J' $((${#items[@]} + 2 + CHECK_SAID))
    fi
    CHECK_SAID=0
    CHECK_KEEP=""
    choose "$title" "$sel" "${items[@]}"
    drawn="yes"
    [ "$CHOICE" -lt "${#keys[@]}" ] || break
    sel=$CHOICE
    $toggle "${keys[$CHOICE]}"
  done
}
# A box ticked or not, for checklist's lines.
tick() { if [ "$1" = "yes" ]; then printf '[%s✓%s]' "$G" "$R"; else printf '[ ]'; fi; }

# Android: what the list says is missing, and making the key from the menu.
android_ready() { [ "${#ANDROID_MISSING[@]}" -eq 0 ]; }
android_tools_said() {
  say "${Y}Для Android сначала установи:${R}"
  local command
  for command in "${ANDROID_MISSING[@]}"; do say "  $command"; done
}
make_android_key() {
  local password again
  CHECK_KEEP="yes"
  echo
  echo "${B}Ключа для Android ещё нет.${R} Им подписывается приложение: обновление встанет только"
  echo "поверх копии с тем же ключом, и Google Play привязывает приложение к нему — потеряешь,"
  echo "обновлять будет нечем. Он ляжет в $MYSSH_ANDROID_KEYSTORE; сохрани копию и пароль отдельно."
  choose "Создать ключ?" 0 "Создать сейчас" "Не сейчас  ${D}Android останется не отмечен${R}"
  [ "$CHOICE" -eq 0 ] || return 1
  while :; do
    read -r -s -p "  Пароль для ключа (от 6 символов; Enter — отмена): " password; echo
    [ -n "$password" ] || return 1
    if [ "${#password}" -lt 6 ]; then
      echo "  ${Y}Нужно хотя бы 6 символов${R}"
      continue
    fi
    read -r -s -p "  Ещё раз: " again; echo
    [ "$password" = "$again" ] && break
    echo "  ${Y}Не совпали — ещё раз${R}"
  done
  local said
  if said="$(MYSSH_ANDROID_KEYSTORE_PASSWORD="$password" scripts/android-key.sh 2>&1)"; then
    ANDROID_KEY="yes"
    # The build takes it from here instead of asking for it again.
    export MYSSH_ANDROID_KEYSTORE_PASSWORD="$password"
    ok "ключ создан: $MYSSH_ANDROID_KEYSTORE"
    return 0
  fi
  bad "ключ не создался: $(tail -n 1 <<< "$said")"
  return 1
}

# The phones and emulators connected, by their model's name.
android_names() {
  local serial
  for serial in $(android_devices); do
    adb -s "$serial" shell getprop ro.product.model 2> /dev/null | tr -d '\r' || echo "$serial"
  done | paste -sd, - | sed 's/,/, /g'
}
# The menu's line for putting the Android app onto them.
android_install_item() {
  local names
  names="$(android_names)"
  if [ -n "$names" ]; then
    echo "Установить на телефон  ${D}$names, по adb${R}"
  else
    echo "Установить на телефон  ${D}подключи его по USB (с отладкой по USB) или запусти эмулятор${R}"
  fi
}
# Puts an .apk onto every phone and emulator connected.
android_install() {
  local apk="$1" serial name answer any=""
  for serial in $(android_devices); do
    any="yes"
    name="$(adb -s "$serial" shell getprop ro.product.model 2> /dev/null | tr -d '\r')"
    if answer="$(adb -s "$serial" install -r "$apk" 2>&1)"; then
      ok "установлено на ${name:-$serial}"
    elif grep -q "UPDATE_INCOMPATIBLE\|signatures do not match" <<< "$answer"; then
      bad "на ${name:-$serial} стоит копия, подписанная другим ключом: удали её там (или adb -s $serial uninstall <пакет>) и повтори"
    else
      bad "на ${name:-$serial} не встало: $(tail -n 1 <<< "$answer")"
    fi
  done
  [ -n "$any" ] || warn "ни телефона, ни эмулятора не видно: подключи телефон по USB с включённой отладкой по USB или запусти эмулятор"
}

# Plain words for a span of seconds.
minutes() {
  local s="$1"
  if [ "$s" -lt 90 ]; then echo "${s} с"; else echo "$(((s + 30) / 60)) мин"; fi
}

newer() {
  python3 - "$1" "$2" <<'PY'
import sys
older, newer = (tuple(map(int, v.split("."))) for v in sys.argv[1:3])
sys.exit(0 if newer > older else 1)
PY
}

CURRENT="$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')"
PUBKEY="$(python3 -c 'import json; print(json.load(open("app.config.json")).get("updates", {}).get("pubkey", ""))')"
REPO="$(python3 -c 'import json; print(json.load(open("app.config.json")).get("updates", {}).get("repo", ""))')"
SERVER="$(python3 -c 'import json; print(json.load(open("app.config.json"))["cloud"]["server"].rstrip("/"))')"
GITHUB="${MYSSH_RELEASE_GITHUB:-no}"
WINDOWS="${MYSSH_RELEASE_WINDOWS:-yes}"
DOCKER=""
! docker info > /dev/null 2>&1 || DOCKER="yes"
# Linux is built when Docker is running, unless told otherwise.
LINUX="${MYSSH_RELEASE_LINUX:-$([ -n "$DOCKER" ] && echo yes || echo no)}"
STORE_TOO="${MYSSH_RELEASE_STORE:-no}"

# Windows is built on this Mac, which takes a compiler that speaks its
# dialect, its libraries, and the program that makes installers.
WIN_TARGET="x86_64-pc-windows-msvc"
WIN_PATH=""
WIN_CERT="${MYSSH_WINDOWS_CERT:-$HOME/.myssh/windows-cert.pfx}"
MAKEMSIX="${MYSSH_MAKEMSIX:-$HOME/.myssh/msix/bin/makemsix}"
SIGNED=""
[ ! -f "$WIN_CERT" ] || SIGNED="yes"
WIN_MISSING=()
# The Mac app is built for Intel too, which takes Rust's Intel library.
MAC_MISSING=""
rustup target list --installed 2> /dev/null | grep -x "x86_64-apple-darwin" > /dev/null \
  || MAC_MISSING="rustup target add x86_64-apple-darwin"
rustup target list --installed 2> /dev/null | grep -x "$WIN_TARGET" > /dev/null || WIN_MISSING+=("rustup target add $WIN_TARGET")
command -v cargo-xwin > /dev/null || WIN_MISSING+=("cargo install --locked cargo-xwin")
for FORMULA in llvm lld nsis nasm cmake; do
  brew --prefix "$FORMULA" > /dev/null 2>&1 && [ -d "$(brew --prefix "$FORMULA")" ] || WIN_MISSING+=("brew install $FORMULA")
done
[ -z "$SIGNED" ] || command -v osslsigncode > /dev/null || WIN_MISSING+=("brew install osslsigncode")
STORE_TOOL=""
[ ! -x "$MAKEMSIX" ] || STORE_TOOL="yes"

# Android: its tools (JDK, SDK and NDK, Rust's libraries for phones) and the
# key the app is signed with. Built by default when both are in place.
# shellcheck source=android-env.sh
source scripts/android-env.sh
export MYSSH_ANDROID_KEYSTORE="${MYSSH_ANDROID_KEYSTORE:-$HOME/.myssh/android-release.jks}"
ANDROID_KEY=""
[ ! -f "$MYSSH_ANDROID_KEYSTORE" ] || ANDROID_KEY="yes"
ANDROID_DEFAULT="no"
[ "${#ANDROID_MISSING[@]}" -gt 0 ] || [ -z "$ANDROID_KEY" ] || ANDROID_DEFAULT="yes"
ANDROID="${MYSSH_RELEASE_ANDROID:-$ANDROID_DEFAULT}"

# The Mac app is signed with a Developer ID when there is one, and
# notarized when notarytool has its profile (asking Apple takes a moment).
MAC_IDENTITY="${MYSSH_MAC_IDENTITY:-}"
if [ -z "$MAC_IDENTITY" ]; then
  MAC_IDENTITY="$(security find-identity -v -p codesigning 2> /dev/null \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
fi
[ "$MAC_IDENTITY" != "no" ] || MAC_IDENTITY=""
TEAM_ID="$(sed -n 's/.*(\([A-Z0-9]*\))$/\1/p' <<< "$MAC_IDENTITY")"
NOTARY="${MYSSH_NOTARY_PROFILE:-myssh-notary}"
NOTARIZE=""
if [ -n "$MAC_IDENTITY" ] && [ "$NOTARY" != "no" ] \
  && xcrun notarytool history --keychain-profile "$NOTARY" > /dev/null 2>&1; then
  NOTARIZE="yes"
fi
mac_signing() {
  if [ -n "$NOTARIZE" ]; then
    echo "подписано и нотаризовано"
  elif [ -n "$MAC_IDENTITY" ]; then
    echo "подписано, без нотаризации"
  else
    echo "без подписи Apple"
  fi
}
notary_setup() {
  echo "xcrun notarytool store-credentials $NOTARY --apple-id <твой Apple ID> --team-id ${TEAM_ID:-<team ID>}"
}

# Asks for the panel's token, pasted in (nothing shows), has the server
# check it and keeps it in $PANEL_TOKEN_FILE, for this run and the next.
# Fails when none was given, or none the server takes.
paste_panel_token() {
  local token checked
  echo "  ${D}Токен делается на панели: $SERVER/admin/settings?tab=releases → «Создать токен».${R}"
  for _ in 1 2 3; do
    read -r -s -p "  Вставь токен панели (при вставке не виден; Enter — отмена): " token; echo
    token="$(tr -d '[:space:]' <<< "$token")"
    [ -n "$token" ] || return 1
    checked=0
    MYSSH_PANEL_TOKEN="$token" python3 -B scripts/release-upload.py --check "$SERVER" || checked=$?
    if [ "$checked" -eq 1 ]; then
      echo "  ${Y}Этот токен панель не принимает.${R} Скопируй его заново или создай новый." >&2
      continue
    fi
    mkdir -p "$(dirname "$PANEL_TOKEN_FILE")"
    (umask 077 && printf '%s\n' "$token" > "$PANEL_TOKEN_FILE")
    chmod 600 "$PANEL_TOKEN_FILE"
    export MYSSH_PANEL_TOKEN="$token"
    PANEL_TOKEN="yes"
    if [ "$checked" -eq 0 ]; then
      ok "токен подошёл; сохранён в $PANEL_TOKEN_FILE"
    else
      warn "токен сохранён в $PANEL_TOKEN_FILE, но сервер его не проверил (см. выше)"
    fi
    return 0
  done
  return 1
}

LAST_TAG="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2> /dev/null || true)"
# The last version released; a new one has to be newer. None: any will do.
RELEASED="${LAST_TAG#v}"

# How long the last build of the same kind took, to say how long this one will.
took_before() {
  [ -f "$TIMES" ] || return 0
  awk -v kind="$1" '$1 == kind { print $2 }' "$TIMES" | tail -n 1
}
build_kind() {
  local kind="mac"
  [ "$WINDOWS" != "yes" ] || kind="mac+windows"
  [ "$WINDOWS" != "yes" ] || [ "$STORE_TOO" != "yes" ] || kind="mac+windows+store"
  [ "$LINUX" != "yes" ] || kind="$kind+linux"
  [ "$ANDROID" != "yes" ] || kind="$kind+android"
  echo "$kind"
}

# ------------------------------------------------------------ test build ---
# The app alone, for each system asked for, quickly: see the top of this
# file. Ends the script.
# The systems a test build is for, ticked in a list.
TEST_MAC="yes"
TEST_WINDOWS="no"
TEST_ANDROID="no"
test_label() {
  case "$1" in
    mac) echo "$(tick "$TEST_MAC") Mac  ${D}MySSH Test.app${R}" ;;
    windows)
      local note="MySSH Test.exe, запускать в виртуалке"
      [ "${#WIN_MISSING[@]}" -eq 0 ] || note="нет инструментов"
      echo "$(tick "$TEST_WINDOWS") Windows  ${D}$note${R}"
      ;;
    android)
      local note="MySSH Test.apk, для телефона или эмулятора"
      android_ready || note="нет инструментов"
      echo "$(tick "$TEST_ANDROID") Android  ${D}$note${R}"
      ;;
  esac
}
test_toggle() {
  case "$1" in
    mac) if [ "$TEST_MAC" = "yes" ]; then TEST_MAC="no"; else TEST_MAC="yes"; fi ;;
    windows)
      if [ "$TEST_WINDOWS" = "yes" ]; then
        TEST_WINDOWS="no"
      elif [ "${#WIN_MISSING[@]}" -gt 0 ]; then
        say "${Y}Для Windows сначала установи:${R}"
        local command
        for command in "${WIN_MISSING[@]}"; do say "  $command"; done
      else
        TEST_WINDOWS="yes"
      fi
      ;;
    android)
      if [ "$TEST_ANDROID" = "yes" ]; then
        TEST_ANDROID="no"
      elif ! android_ready; then
        android_tools_said
      else
        TEST_ANDROID="yes"
      fi
      ;;
  esac
}

test_build() {
  local windows="no" mac="yes" android="no" server="docker" url addr config android_config started out
  [ "${#WIN_MISSING[@]}" -gt 0 ] || windows="yes"
  if [ -n "$MENU" ]; then
    [ "${#WIN_MISSING[@]}" -gt 0 ] || TEST_WINDOWS="yes"
    while :; do
      checklist "Для каких систем? ${D}(Enter — отметить, «Готово» — дальше)${R}" test_label test_toggle mac windows android
      [ "$TEST_MAC$TEST_WINDOWS$TEST_ANDROID" = "nonono" ] || break
      echo "  ${Y}Отметь хотя бы одну систему${R}"
    done
    mac="$TEST_MAC" windows="$TEST_WINDOWS" android="$TEST_ANDROID"
    choose "С каким сервером?" 0 \
      "Бэкенд в Docker на этом Mac  ${D}поднимется сам из $(basename "$CLOUD_DIR")${R}" \
      "Рабочий  ${D}$SERVER${R}"
    [ "$CHOICE" -eq 0 ] || server="real"
  fi
  [ "$windows" = "no" ] || [ "${#WIN_MISSING[@]}" -eq 0 ] \
    || fail "для Windows не хватает: ${WIN_MISSING[*]}"
  [ "$android" = "no" ] || android_ready || fail "для Android не хватает: ${ANDROID_MISSING[*]}"

  if [ "$server" = "docker" ]; then
    [ -f "$CLOUD_DIR/docker-compose.yml" ] || fail "нет бэкенда в $CLOUD_DIR (укажи папку в MYSSH_CLOUD_DIR)"
    if ! docker info > /dev/null 2>&1; then
      # Stopped: started here, OrbStack or Docker Desktop, whichever there is.
      echo "release: запускаю Docker"
      if command -v orb > /dev/null; then
        orb start > /dev/null 2>&1 || true
      elif [ -d /Applications/Docker.app ]; then
        open -a Docker
      fi
      started="$(date +%s)"
      until docker info > /dev/null 2>&1; do
        [ $(($(date +%s) - started)) -lt 90 ] || fail "Docker не запустился; запусти его сам и попробуй снова"
        sleep 2
      done
    fi
    addr="127.0.0.1"
    if [ "$windows" = "yes" ] || [ "$android" = "yes" ]; then
      # The Windows copy runs elsewhere (a virtual machine), the Android one
      # on a phone or in the emulator: they need this Mac's address in the
      # network, not loopback.
      addr="$(ipconfig getifaddr en0 2> /dev/null || ipconfig getifaddr en1 2> /dev/null || true)"
      [ -n "$addr" ] || fail "не понял адрес этого Mac в сети (en0/en1): Windows и Android будет не до чего достучаться"
    fi
    url="http://$addr:8787"
    echo "${B}release: бэкенд в Docker на $url${R}"
    [ "$addr" = "127.0.0.1" ] || echo "  ${Y}!${R} пока он запущен так, он открыт всей локальной сети"
    (cd "$CLOUD_DIR" && docker compose build --quiet && MYSSH_PUBLISH="$addr" docker compose up -d --quiet-pull) \
      || fail "бэкенд в Docker не поднялся"
    started="$(date +%s)"
    until curl -fsS -o /dev/null "$url/healthz" 2> /dev/null; do
      [ $(($(date +%s) - started)) -lt 60 ] || fail "бэкенд в Docker не отвечает на $url"
      sleep 1
    done
    echo "  ${G}✓${R} отвечает"
  else
    url="$SERVER"
  fi

  # A separate app: its own identifier (so its own data, apart from the
  # installed MySSH's), its own name and link scheme, and, for a server
  # over plain HTTP, the shared terminals' socket allowed in the window.
  config="$(python3 -c '
import json, sys
url = sys.argv[1]
conf = json.load(open("src-tauri/tauri.conf.json"))
config = {
    "identifier": "app.myssh.desktop.test",
    "productName": "MySSH Test",
    "plugins": {"deep-link": {"desktop": {"schemes": ["myssh-test"]}}},
}
if url.startswith("http://"):
    config["app"] = {"security": {"csp": conf["app"]["security"]["csp"] + " ws://" + url[len("http://"):]}}
print(json.dumps(config))
' "$url")"
  # Android: the same socket allowed; its separate identity and name come
  # from the Android project (MYSSH_ANDROID_TEST), its links stay myssh://.
  android_config="$(python3 -c '
import json, sys
url = sys.argv[1]
conf = json.load(open("src-tauri/tauri.conf.json"))
config = {}
if url.startswith("http://"):
    config["app"] = {"security": {"csp": conf["app"]["security"]["csp"] + " ws://" + url[len("http://"):]}}
print(json.dumps(config))
' "$url")"
  out="release/test"
  rm -rf "$out"
  mkdir -p "$out"
  started="$(date +%s)"
  export MYSSH_TEST_BUILD=1 MYSSH_CLOUD_SERVER="$url" MYSSH_UPDATE_PUBKEY=""
  if [ "$mac" = "yes" ]; then
    echo "${B}release: тестовая сборка для Mac${R}"
    npx tauri build --bundles app -c "$config"
    ditto "$BUILD_DIR/release/bundle/macos/MySSH Test.app" "$out/MySSH Test.app"
    rm -rf "${BUILD_DIR:?}/release/bundle"
  fi
  if [ "$windows" = "yes" ]; then
    echo "${B}release: тестовая сборка для Windows${R}"
    PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH" \
      npx tauri build --runner cargo-xwin --target "$WIN_TARGET" --no-bundle -c "$config"
    cp "$BUILD_DIR/$WIN_TARGET/release/myssh.exe" "$out/MySSH Test.exe"
  fi
  if [ "$android" = "yes" ]; then
    # A development build: signed by Android's debug key, plain HTTP
    # allowed, for 64-bit ARM, which phones and the emulator on this Mac are.
    echo "${B}release: тестовая сборка для Android${R}"
    MYSSH_ANDROID_TEST=1 npx tauri android build --debug --apk --target aarch64 -c "$android_config"
    cp "$ANDROID_OUTPUTS/apk/universal/debug/app-universal-debug.apk" "$out/MySSH Test.apk"
  fi
  find release -name .DS_Store -delete 2> /dev/null || true

  echo
  echo "${G}${B}Готово: тестовая сборка за $(minutes $(($(date +%s) - started))).${R}"
  echo "В $out/ ${D}(сервер: $url)${R}:"
  du -sh "$out"/* | sed "s|$out/||; s/^/  /"
  [ "$windows" = "no" ] || echo "${D}Windows: скопируй MySSH Test.exe в виртуалку и запусти; ему нужен WebView2, он есть в Windows 10 и 11.${R}"
  [ "$android" = "no" ] || echo "${D}Android: поставь MySSH Test.apk на телефон (или из меню ниже по USB); он ставится рядом с MySSH и сервер видит по адресу в сети.${R}"
  notify "Тестовая сборка готова"
  if [ -n "$MENU" ]; then
    local finder="Показать в Finder" install=""
    while :; do
      if [ "$android" = "yes" ]; then
        install="$(android_install_item)"
        choose "Что дальше?" 0 "$finder" "$install" "Выйти"
        case "$CHOICE" in
          0) open "$out" || true; finder="${G}✓${R} Показать в Finder" ;;
          1) android_install "$out/MySSH Test.apk" ;;
          2) break ;;
        esac
      else
        choose "Что дальше?" 0 "$finder" "Выйти"
        [ "$CHOICE" -ne 0 ] || open "$out" || true
        break
      fi
    done
  fi
  exit 0
}
CLOUD_DIR="${MYSSH_CLOUD_DIR:-$ROOT/../myssh-cloud}"
BUILD_DIR="${CARGO_TARGET_DIR:-target}"

[ -z "$TEST_ONLY" ] || test_build

if [ -n "$MENU" ]; then
  choose "Что собрать?" 0 \
    "Выпуск  ${D}версия, установщики, подписи, коммит и тег${R}" \
    "Тестовая сборка  ${D}только .app, .exe и .apk, без установщиков и подписей, с бэкендом в Docker${R}"
  [ "$CHOICE" -eq 0 ] || test_build

  # ------------------------------------------------- where things stand ---
  echo
  echo "${B}MySSH — новый выпуск${R}"
  echo
  if [ -n "$LAST_TAG" ]; then
    SINCE="$(git rev-list --count "$LAST_TAG..HEAD")"
    ok "сейчас $CURRENT, выпущена $(git log -1 --date=format:'%d.%m в %H:%M' --format=%cd "$LAST_TAG")"
    if [ "$SINCE" -eq 0 ]; then
      warn "с $LAST_TAG ничего не закоммичено: новая версия будет такой же"
    else
      ok "с $LAST_TAG коммитов: $SINCE"
    fi
  else
    ok "сейчас $CURRENT; выпусков ещё не было (тегов нет): номер можно выбрать любой"
  fi
  UNPUSHED="$(git rev-list --count '@{u}..HEAD' 2> /dev/null || echo 0)"
  [ "$UNPUSHED" -eq 0 ] || warn "не отправлено в GitHub коммитов: $UNPUSHED (можно отправить в конце)"
  DIRTY="$(git status --porcelain --untracked-files=no)"
  if [ -n "$DIRTY" ]; then
    bad "есть незакоммиченные изменения:"
    sed 's/^/      /' <<< "$DIRTY"
    fail "закоммить или убери их (git stash) и запусти снова"
  fi
  ok "незакоммиченных изменений нет"
  if [ -f "$KEY" ] && [ -f "$KEY.pub" ]; then ok "ключ релиза на месте"; else bad "нет ключа релиза в $KEY"; fi
  if [ -n "$MAC_IDENTITY" ]; then
    ok "подпись для Mac: $MAC_IDENTITY"
    if [ -n "$NOTARIZE" ]; then
      ok "нотаризация в Apple: профиль $NOTARY"
    elif [ "$NOTARY" != "no" ]; then
      warn "нотаризация не настроена — macOS будет предупреждать при первом запуске. Один раз:"
      echo "      $(notary_setup)"
      echo "      ${D}(спросит пароль приложения — его делают на account.apple.com → «Пароли приложений»)${R}"
    fi
  else
    warn "нет сертификата Developer ID: приложение для Mac будет без подписи Apple"
  fi
  if [ -z "$MAC_MISSING" ]; then
    ok "приложение для Mac соберётся и для Apple silicon, и для Intel"
  else
    bad "для Intel-маков не хватает: $MAC_MISSING"
  fi
  if [ "${#WIN_MISSING[@]}" -eq 0 ]; then
    ok "инструменты для Windows на месте"
  else
    warn "для Windows не хватает: ${WIN_MISSING[*]}"
  fi
  if android_ready && [ -n "$ANDROID_KEY" ]; then
    ok "инструменты и ключ для Android на месте"
  elif android_ready; then
    warn "нет ключа для Android: создать его можно в меню, отметив Android"
  else
    warn "для Android не хватает: ${ANDROID_MISSING[*]}"
  fi
  if [ -n "$DOCKER" ]; then
    ok "Docker запущен: можно собрать и для Linux"
  else
    warn "Docker не запущен: для Linux собрать не выйдет (OrbStack или Docker Desktop)"
  fi
  if [ -n "$PANEL_TOKEN" ]; then
    ok "токен панели на месте: собранное загрузится на панель само"
  else
    warn "нет токена панели: файлы придётся загружать вручную (вставить его можно в меню перед сборкой)"
  fi
  if [ -n "$SIGNED" ]; then
    ok "сертификат для Windows на месте"
  else
    warn "нет сертификата для Windows: установщик будет без подписи (scripts/windows-cert.sh)"
  fi
  FREE_KB="$(df -k . | awk 'NR == 2 { print $4 }')"
  FREE="$((FREE_KB / 1024 / 1024)) ГБ"
  if [ "$FREE_KB" -lt $((15 * 1024 * 1024)) ]; then
    warn "свободно на диске $FREE: сборке нужно около 10 ГБ"
  else
    ok "свободно на диске $FREE"
  fi

  # ----------------------------------------------------------- choices ---
  IFS=. read -r MAJOR MINOR PATCH <<< "$CURRENT"
  pick_version() {
    local next_patch="$MAJOR.$MINOR.$((PATCH + 1))" next_minor="$MAJOR.$((MINOR + 1)).0" next_major="$((MAJOR + 1)).0.0"
    local typed
    choose "Какую версию выпустить?" 0 \
      "$(printf '%-8s' "$next_patch") ${D}исправления и мелочи${R}" \
      "$(printf '%-8s' "$next_minor") ${D}заметные новые возможности${R}" \
      "$(printf '%-8s' "$next_major") ${D}большой выпуск${R}" \
      "Другая…"
    case "$CHOICE" in
      0) VERSION="$next_patch" ;;
      1) VERSION="$next_minor" ;;
      2) VERSION="$next_major" ;;
      3)
        while :; do
          read -r -p "  Версия${RELEASED:+ (больше $RELEASED)}: " typed
          if [[ ! "$typed" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "  ${Y}Нужна версия вида 1.2.3${R}"
          elif [ -n "$RELEASED" ] && ! newer "$RELEASED" "$typed"; then
            echo "  ${Y}$typed не больше $RELEASED${R}"
          elif git rev-parse -q --verify "refs/tags/v$typed" > /dev/null; then
            echo "  ${Y}тег v$typed уже есть${R}"
          else
            VERSION="$typed"
            break
          fi
        done
        ;;
    esac
  }

  # The systems, ticked in a list. The Mac is always built: its version is
  # the one the others are released with.
  system_label() {
    local note
    case "$1" in
      mac) echo "$(tick yes) Mac  ${D}Apple silicon и Intel, $(mac_signing); собирается всегда${R}" ;;
      windows)
        note="x64, $([ -n "$SIGNED" ] && echo "подписанный" || echo "без подписи")"
        [ "${#WIN_MISSING[@]}" -eq 0 ] || note="нет инструментов"
        echo "$(tick "$WINDOWS") Windows  ${D}$note${R}"
        ;;
      linux)
        note="AppImage, в Docker, ещё минут 5–15"
        docker info > /dev/null 2>&1 || note="Docker не запущен"
        echo "$(tick "$LINUX") Linux  ${D}$note${R}"
        ;;
      store)
        note="пакет .msix для Partner Center"
        [ -n "$STORE_TOOL" ] || note="нет makemsix: scripts/msix-tool.sh"
        echo "$(tick "$STORE_TOO") Microsoft Store  ${D}$note${R}"
        ;;
      android)
        note=".aab для Google Play"
        if ! android_ready; then
          note="нет инструментов"
        elif [ -z "$ANDROID_KEY" ]; then
          note="$note; ключа ещё нет — создам"
        fi
        echo "$(tick "$ANDROID") Android  ${D}$note${R}"
        ;;
    esac
  }
  system_toggle() {
    local command
    case "$1" in
      mac) say "${D}Mac собирается всегда: с него и номер, и описание выпуска${R}" ;;
      windows)
        if [ "$WINDOWS" = "yes" ]; then
          WINDOWS="no" STORE_TOO="no"
        elif [ "${#WIN_MISSING[@]}" -gt 0 ]; then
          say "${Y}Для Windows сначала установи:${R}"
          for command in "${WIN_MISSING[@]}"; do say "  $command"; done
        else
          WINDOWS="yes"
        fi
        ;;
      linux)
        if [ "$LINUX" = "yes" ]; then
          LINUX="no"
        elif ! docker info > /dev/null 2>&1; then
          say "${Y}Для Linux сначала запусти Docker (OrbStack или Docker Desktop)${R}"
        else
          LINUX="yes"
        fi
        ;;
      store)
        if [ "$STORE_TOO" = "yes" ]; then
          STORE_TOO="no"
        elif [ -z "$STORE_TOOL" ]; then
          say "${Y}Для Microsoft Store сначала запусти scripts/msix-tool.sh${R}"
        elif [ "${#WIN_MISSING[@]}" -gt 0 ]; then
          say "${Y}Пакет для Store собирается из версии для Windows, а для неё не хватает инструментов${R}"
        else
          STORE_TOO="yes" WINDOWS="yes"
        fi
        ;;
      android)
        if [ "$ANDROID" = "yes" ]; then
          ANDROID="no"
        elif ! android_ready; then
          android_tools_said
        elif [ -n "$ANDROID_KEY" ] || make_android_key; then
          ANDROID="yes"
        fi
        ;;
    esac
  }
  pick_systems() {
    # What cannot be built now starts unticked.
    [ "${#WIN_MISSING[@]}" -eq 0 ] || WINDOWS="no" STORE_TOO="no"
    [ -n "$STORE_TOOL" ] || STORE_TOO="no"
    docker info > /dev/null 2>&1 || LINUX="no"
    android_ready || ANDROID="no"
    checklist "Для каких систем собрать? ${D}(Enter — отметить, «Готово» — дальше)${R}" \
      system_label system_toggle mac windows linux store android
  }

  # The notes live in notes.txt, which git leaves alone. Old notes are
  # pointed out: they may be the last release's.
  notes_preview() {
    if [ -z "$NOTES_FILE" ]; then
      echo "${D}без заметок${R}"
    else
      local first lines
      first="$(head -n 1 "$NOTES_FILE" | cut -c 1-60)"
      lines="$(grep -c '' "$NOTES_FILE" || true)"
      if [ "$lines" -gt 1 ]; then echo "«${first}» ${D}и ещё строк: $((lines - 1))${R}"; else echo "«${first}»"; fi
    fi
  }
  edit_notes() {
    local draft
    draft="$(mktemp -t myssh-notes)"
    {
      [ ! -s notes.txt ] || cat notes.txt
      echo
      echo "# Заметки к MySSH $VERSION: их видят в окне обновления."
      echo "# Строки с # в заметки не попадут. Пусто — без заметок."
      if [ -n "$LAST_TAG" ]; then
        echo "#"
        echo "# Что закоммичено с $LAST_TAG:"
        git log --reverse --format='#   %s' "$LAST_TAG..HEAD"
      fi
    } > "$draft"
    ${VISUAL:-${EDITOR:-nano}} "$draft" < /dev/tty > /dev/tty || true
    python3 - "$draft" notes.txt <<'PY'
import sys
lines = [line.rstrip() for line in open(sys.argv[1]) if not line.startswith("#")]
text = "\n".join(lines).strip()
open(sys.argv[2], "w").write(text + "\n" if text else "")
PY
    rm -f "$draft"
    if [ -s notes.txt ]; then NOTES_FILE="notes.txt"; else NOTES_FILE=""; fi
  }
  pick_notes() {
    local items=() actions=() age=""
    if [ -s notes.txt ]; then
      if [ -n "$LAST_TAG" ] && [ "$(stat -f %m notes.txt)" -lt "$(git log -1 --format=%ct "$LAST_TAG")" ]; then
        age="  ${Y}написаны до $LAST_TAG — возможно, старые${R}"
      fi
      NOTES_FILE="notes.txt"
      items+=("Оставить $(notes_preview)$age") actions+=(keep)
    fi
    items+=("Открыть notes.txt  ${D}в приложении по умолчанию; потом вернись сюда${R}") actions+=(open)
    items+=("Написать  ${D}откроется редактор, внизу список коммитов${R}") actions+=(edit)
    if [ -s notes.txt ]; then
      items+=("Очистить  ${D}notes.txt станет пустым${R}") actions+=(clear)
    fi
    items+=("Без заметок  ${D}можно вписать потом на панели${R}") actions+=(none)
    choose "Заметки к обновлению (их видят в окне обновления):" 0 "${items[@]}"
    case "${actions[$CHOICE]}" in
      keep) NOTES_FILE="notes.txt" ;;
      open)
        touch notes.txt
        open notes.txt || true
        read -r -p "  Сохрани notes.txt и нажми Enter… " _ < /dev/tty
        pick_notes
        ;;
      edit) edit_notes ;;
      clear)
        : > notes.txt
        NOTES_FILE=""
        pick_notes
        ;;
      none) NOTES_FILE="" ;;
    esac
  }

  pick_version
  pick_systems
  pick_notes

  # ----------------------------------------------------------- summary ---
  while :; do
    SYSTEMS="Mac (Apple silicon и Intel, $(mac_signing))"
    if [ "$WINDOWS" = "yes" ]; then
      SYSTEMS="$SYSTEMS, Windows (x64$([ -n "$SIGNED" ] && echo ", подписанный" || echo ", без подписи"))"
      [ "$STORE_TOO" != "yes" ] || SYSTEMS="$SYSTEMS, Microsoft Store"
    fi
    [ "$LINUX" != "yes" ] || SYSTEMS="$SYSTEMS, Linux (x86_64, AppImage)"
    [ "$ANDROID" != "yes" ] || SYSTEMS="$SYSTEMS, Android (.aab для Google Play)"
    BEFORE="$(took_before "$(build_kind)")"
    echo
    echo "${B}Итого${R}"
    echo "  Версия    $CURRENT → ${B}$VERSION${R}"
    echo "  Системы   $SYSTEMS"
    echo "  Заметки   $(notes_preview)"
    echo "  Панель    $([ -n "$PANEL_TOKEN" ] && echo "загрузить туда самому, отправить — тебе" || echo "${D}загрузить вручную: токена нет${R}")"
    echo "  GitHub    $([ "$GITHUB" = "yes" ] && echo "выложить и туда (github.com/$REPO)" || echo "${D}нет${R}")"
    [ -z "$BEFORE" ] || echo "  Займёт    ${D}около $(minutes "$BEFORE"), как в прошлый раз${R}"
    choose "Собрать?" 0 \
      "Собрать  ${D}потом спросит $( [ "$ANDROID" = "yes" ] || { [ "$WINDOWS" = "yes" ] && [ -n "$SIGNED" ]; } && echo "пароли ключей" || echo "пароль ключа")${R}" \
      "Изменить версию" \
      "Изменить системы" \
      "Изменить заметки" \
      "Выложить и на GitHub: $([ "$GITHUB" = "yes" ] && echo да || echo нет)  ${D}только для старых тестовых сборок${R}" \
      "$([ -n "$PANEL_TOKEN" ] && echo "Заменить токен панели" || echo "Вставить токен панели  ${D}чтобы загрузить самому${R}")" \
      "Отмена"
    case "$CHOICE" in
      0) break ;;
      1) pick_version ;;
      2) pick_systems ;;
      3) pick_notes ;;
      4) if [ "$GITHUB" = "yes" ]; then GITHUB="no"; else GITHUB="yes"; fi ;;
      5) paste_panel_token || true ;;
      6) fail "отменено" ;;
    esac
  done
  echo
elif [ -z "$VERSION" ]; then
  fail "укажи версию: scripts/release.sh 0.2.0 [notes.txt], или запусти без аргументов в терминале — будет меню"
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "нужна версия вида 0.2.0"
[ -z "$NOTES_FILE" ] || [ -f "$NOTES_FILE" ] || fail "нет файла с заметками: $NOTES_FILE"
[ -f "$KEY" ] && [ -f "$KEY.pub" ] || fail "нет ключа релиза в $KEY; его делает scripts/updater-key.sh"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "сначала закоммить или убери изменения (git stash)"
[ -z "$RELEASED" ] || newer "$RELEASED" "$VERSION" || fail "$VERSION не больше выпущенной $RELEASED"
! git rev-parse -q --verify "refs/tags/v$VERSION" > /dev/null || fail "тег v$VERSION уже есть"
[ -n "$PUBKEY" ] || fail "в app.config.json нет updates.pubkey; запусти scripts/updater-key.sh"
[ "$LINUX" != "yes" ] || docker info > /dev/null 2>&1 || fail "для Linux нужен запущенный Docker"
[ "$PUBKEY" = "$(tr -d '\n' < "$KEY.pub")" ] || fail "ключ в $KEY — не тот, что в app.config.json"
[[ "$SERVER" == https://* ]] || fail "cloud.server в app.config.json должен быть адресом https://"
if [ -z "$MENU" ] && [ -z "$NOTARIZE" ]; then
  if [ -z "$MAC_IDENTITY" ]; then
    echo "release: нет сертификата Developer ID: приложение для Mac будет без подписи Apple."
  elif [ "$NOTARY" != "no" ]; then
    echo "release: нотаризация не настроена; один раз: $(notary_setup)"
  fi
fi
[ "$GITHUB" != "yes" ] || command -v gh > /dev/null || fail "для выкладки на GitHub нужен GitHub CLI: brew install gh"
[ -z "$MAC_MISSING" ] || fail "для приложения под Intel-маки сначала: $MAC_MISSING"
if [ "$ANDROID" = "yes" ]; then
  android_ready || fail "для Android не хватает: ${ANDROID_MISSING[*]} (или собери без него: MYSSH_RELEASE_ANDROID=no)"
  [ -n "$ANDROID_KEY" ] || fail "нет ключа для Android в $MYSSH_ANDROID_KEYSTORE; его делает scripts/android-key.sh"
fi

if [ "$WINDOWS" = "yes" ]; then
  MISSING=()
  [ "${#WIN_MISSING[@]}" -eq 0 ] || MISSING+=("${WIN_MISSING[@]}")
  [ "$STORE_TOO" != "yes" ] || [ -n "$STORE_TOOL" ] || MISSING+=("scripts/msix-tool.sh")
  if [ "${#MISSING[@]}" -gt 0 ]; then
    echo "${RD}release:${R} для сборки под Windows сначала нужны инструменты:" >&2
    printf '  %s\n' "${MISSING[@]}" >&2
    fail "установи их или собери без Windows: MYSSH_RELEASE_WINDOWS=no"
  fi
  WIN_PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin"
  [ -n "$SIGNED" ] || [ -n "$MENU" ] || echo "release: нет сертификата в $WIN_CERT: установщик для Windows будет без подписи (его делает scripts/windows-cert.sh)."
fi

# A wrong password should fail now, not after the whole build. Typed by
# hand it can be tried again; nothing shows while typing, so a slip or the
# wrong keyboard layout is easy.
PROBE="$(mktemp)"
trap 'rm -f "$PROBE" "$PROBE.sig"; printf "\033[?25h"' EXIT
for ATTEMPT in 1 2 3; do
  TYPED=""
  if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
    read -r -s -p "Пароль ключа релиза: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo
    TYPED="yes"
  fi
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  if REASON="$(npx tauri signer sign -f "$KEY" "$PROBE" 2>&1)"; then
    break
  fi
  # Anything but a wrong password is said as the signer said it.
  grep -qi "wrong password" <<< "$REASON" || fail "ключом $KEY не получилось подписать: $(tail -n 1 <<< "$REASON")"
  if [ -z "$TYPED" ] || [ "$ATTEMPT" = 3 ]; then
    fail "пароль не подходит к ключу $KEY"
  fi
  echo "${Y}Пароль не тот.${R} Символы при вводе не видны: проверь раскладку и Caps Lock." >&2
  unset TAURI_SIGNING_PRIVATE_KEY_PASSWORD
done

# The certificate's password too, and tried the same way: on something
# small, before the build.
if [ "$WINDOWS" = "yes" ] && [ -n "$SIGNED" ]; then
  if [ -z "${MYSSH_WINDOWS_CERT_PASSWORD+set}" ]; then
    read -r -s -p "Пароль сертификата для Windows: " MYSSH_WINDOWS_CERT_PASSWORD; echo
  fi
  export MYSSH_WINDOWS_CERT="$WIN_CERT" MYSSH_WINDOWS_CERT_PASSWORD
  OPENSSL="$(brew --prefix openssl@3 2> /dev/null)/bin/openssl"
  [ -x "$OPENSSL" ] || OPENSSL="$(command -v openssl)"
  "$OPENSSL" pkcs12 -in "$WIN_CERT" -passin env:MYSSH_WINDOWS_CERT_PASSWORD -nokeys -noout 2> /dev/null \
    || fail "пароль не подходит к сертификату $WIN_CERT"
fi
# And the Android key's, opened with it to be sure.
if [ "$ANDROID" = "yes" ]; then
  for ATTEMPT in 1 2 3; do
    TYPED=""
    if [ -z "${MYSSH_ANDROID_KEYSTORE_PASSWORD:-}" ]; then
      read -r -s -p "Пароль ключа для Android: " MYSSH_ANDROID_KEYSTORE_PASSWORD; echo
      TYPED="yes"
    fi
    export MYSSH_ANDROID_KEYSTORE_PASSWORD
    "$JAVA_HOME/bin/keytool" -list -keystore "$MYSSH_ANDROID_KEYSTORE" \
      -storepass:env MYSSH_ANDROID_KEYSTORE_PASSWORD > /dev/null 2>&1 && break
    if [ -z "$TYPED" ] || [ "$ATTEMPT" = 3 ]; then
      fail "пароль не подходит к ключу $MYSSH_ANDROID_KEYSTORE"
    fi
    echo "${Y}Пароль не тот.${R} Символы при вводе не видны: проверь раскладку и Caps Lock." >&2
    unset MYSSH_ANDROID_KEYSTORE_PASSWORD
  done
fi
[ -z "$MENU" ] || echo "${D}Дальше всё само; можно заняться другим — в конце будет уведомление.${R}"

# Reads one field of the JSON notarytool answers with ("" when there is none).
notary_field() {
  python3 -c '
import json, sys
text = sys.argv[2]
print(json.loads(text[text.index("{"):text.rindex("}") + 1]).get(sys.argv[1], ""))
' "$1" "$2" 2> /dev/null || true
}

# Sends a file (an app goes zipped) to Apple's notary service, waits for the
# answer and staples the ticket to it, so that it opens offline too. While
# Apple checks, a ticking line shows that nothing hangs: it asks Apple once
# a minute and keeps the time.
notarize() {
  local file="$1" name upload answer state id started now asked="" spin='|/-\' i=0 took
  name="$(basename "$file")"
  upload="$file"
  if [ -d "$file" ]; then
    upload="$(mktemp -d)/$name.zip"
    ditto -c -k --keepParent "$file" "$upload"
  fi
  echo "${B}release: нотаризация $name в Apple${R} ${D}(обычно 1–5 минут; самые первые у нового аккаунта — бывает, часами)${R}"
  answer="$(xcrun notarytool submit "$upload" --keychain-profile "$NOTARY" --output-format json 2>&1)" \
    || fail "не получилось отправить $name на нотаризацию: $answer"
  id="$(notary_field id "$answer")"
  [ -n "$id" ] || fail "Apple не дала номер отправки: $answer"
  echo "  отправлено, номер ${C}$id${R}"
  echo "  ${D}Ctrl+C прервёт выпуск, но Apple проверку доделает; узнать, чем кончилось:${R}"
  echo "  ${D}xcrun notarytool info $id --keychain-profile $NOTARY${R}"
  started="$(date +%s)"
  state="In Progress"
  while :; do
    now="$(date +%s)"
    if [ -z "$asked" ] || [ $((now - asked)) -ge 60 ]; then
      asked="$now"
      answer="$(xcrun notarytool info "$id" --keychain-profile "$NOTARY" --output-format json 2>&1 || true)"
      # No answer (the network dropped, say) is waited out like "In Progress".
      state="$(notary_field status "$answer")"
      [ -n "$state" ] || state="нет ответа, спрошу ещё"
      case "$state" in
        "In Progress" | "нет ответа, спрошу ещё") ;;
        *) break ;;
      esac
    fi
    took=$((now - started))
    if [ -t 1 ]; then
      printf '\r\033[K  %s ждём Apple: %d:%02d:%02d ⋅ %s ⋅ спрашивали %d с назад' \
        "${spin:i++%4:1}" $((took / 3600)) $((took / 60 % 60)) $((took % 60)) "$state" $((now - asked))
      sleep 1
    else
      echo "  ждём Apple: $((took / 60)) мин ⋅ $state"
      sleep 60
    fi
  done
  took=$(($(date +%s) - started))
  [ ! -t 1 ] || printf '\r\033[K'
  echo "  Apple ответила за $((took / 60)) мин $((took % 60)) с: $state"
  if [ "$state" != "Accepted" ]; then
    echo "${RD}release:${R} Apple не приняла $name ($state). Что ей не понравилось:" >&2
    xcrun notarytool log "$id" --keychain-profile "$NOTARY" >&2 || true
    fail "нотаризация $name не прошла"
  fi
  xcrun stapler staple -q "$file" || fail "не получилось прикрепить нотаризацию к $name"
  [ "$upload" = "$file" ] || rm -rf "$(dirname "$upload")"
}

# From here on files are changed. If anything fails before the release is
# committed, they are put back, and what was half built is removed.
BUMPED=""
COMMITTED=""
VERSION_FILES=(Cargo.toml Cargo.lock package.json package-lock.json src-tauri/tauri.conf.json)
undo() {
  rm -f "$PROBE" "$PROBE.sig"
  printf '\033[?25h'
  if [ -n "$BUMPED" ] && [ -z "$COMMITTED" ]; then
    git checkout -q -- "${VERSION_FILES[@]}" 2> /dev/null || true
    rm -rf "release/${VERSION:?}"
    echo "${RD}release:${R} не получилось; версия снова $CURRENT, ничего не закоммичено." >&2
    notify "Сборка $VERSION не удалась"
  fi
}
trap undo EXIT

STARTED="$(date +%s)"
echo "${B}release: $CURRENT → $VERSION${R}"
BUMPED="yes"
python3 - "$VERSION" <<'PY'
import json, re, sys
version = sys.argv[1]
cargo = open("Cargo.toml").read()
cargo, n = re.subn(r'(?m)^version = "[^"]*"$', f'version = "{version}"', cargo, count=1)
assert n == 1, "no version in Cargo.toml"
open("Cargo.toml", "w").write(cargo)
path = "src-tauri/tauri.conf.json"
conf = json.load(open(path))
conf["version"] = version
open(path, "w").write(json.dumps(conf, indent=2, ensure_ascii=False) + "\n")
PY
npm version "$VERSION" --no-git-tag-version --allow-same-version > /dev/null

echo "${B}release: сборка для Mac${R} ${D}($(mac_signing))${R}"
# With a Developer ID the app is signed by it, with the hardened runtime
# notarizing asks for; without, the ad hoc signature tauri.conf.json names.
MAC_SIGN=()
[ -z "$MAC_IDENTITY" ] || MAC_SIGN=("APPLE_SIGNING_IDENTITY=$MAC_IDENTITY")
env ${MAC_SIGN[@]+"${MAC_SIGN[@]}"} TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" npx tauri build --target "$MAC_TARGET" --bundles app \
  -c "{\"bundle\":{\"createUpdaterArtifacts\":true},\"plugins\":{\"updater\":{\"pubkey\":\"$PUBKEY\"}}}"

BUNDLE="$BUILD_DIR/$MAC_TARGET/release/bundle/macos"
if [ -n "$MAC_IDENTITY" ]; then
  codesign --verify --deep --strict "$BUNDLE/MySSH.app" || fail "подпись приложения для Mac не сходится"
  # Read whole first: grep -q stops reading early, and pipefail would take
  # codesign's broken pipe for a failure.
  SIGNATURE="$(codesign -dv "$BUNDLE/MySSH.app" 2>&1)"
  grep -q "flags=.*runtime" <<< "$SIGNATURE" \
    || fail "приложение подписано без hardened runtime: Apple его не нотаризует"
fi
if [ -n "$NOTARIZE" ]; then
  notarize "$BUNDLE/MySSH.app"
  # The update archive was packed before the ticket was stapled: packed
  # again, as the build packs it (the app at the top, no Finder metadata),
  # and signed again with the release key, for this version as the build
  # signs it: the server and the app take a bundle only for the version its
  # signature names.
  rm -f "$BUNDLE/MySSH.app.tar.gz" "$BUNDLE/MySSH.app.tar.gz.sig"
  COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$BUNDLE/MySSH.app.tar.gz" -C "$BUNDLE" MySSH.app
  npx tauri signer sign -f "$KEY" --app-version "$VERSION" "$BUNDLE/MySSH.app.tar.gz" > /dev/null \
    || fail "не получилось подписать архив обновления ключом релиза"
fi
OUT="release/$VERSION"
ARCHIVE="MySSH_${VERSION}_${ARCH}.app.tar.gz"
DMG="MySSH_${VERSION}_${ARCH}.dmg"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$BUNDLE/MySSH.app.tar.gz" "$OUT/$ARCHIVE"
# The installer: a disk image that opens as a window with the app, the
# Applications folder beside it, and a picture saying to drag one onto the
# other. dmgbuild lays that out; it lives in a small Python environment of
# its own, made the first time. Without it the image is a plain one.
DMG_ENV="${MYSSH_DMG_ENV:-$HOME/.myssh/dmg-env}"
if [ ! -x "$DMG_ENV/bin/dmgbuild" ]; then
  echo "release: ставлю dmgbuild в $DMG_ENV (один раз)"
  { python3 -m venv "$DMG_ENV" && "$DMG_ENV/bin/pip" install --quiet "dmgbuild==1.6.7"; } || true
fi
if [ -x "$DMG_ENV/bin/dmgbuild" ] && "$DMG_ENV/bin/dmgbuild" -s scripts/dmg-settings.py \
  -D app="$BUNDLE/MySSH.app" -D background="src-tauri/dmg/background.tiff" \
  -D icon="src-tauri/icons/icon.icns" "MySSH" "$OUT/$DMG" > /dev/null; then
  :
else
  echo "release: dmgbuild недоступен; установщик будет простым образом диска" >&2
  rm -f "$OUT/$DMG"
  hdiutil create -quiet -volname "MySSH" -srcfolder "$BUNDLE/MySSH.app" -ov -format UDZO "$OUT/$DMG"
fi
if [ -n "$MAC_IDENTITY" ]; then
  codesign --sign "$MAC_IDENTITY" --timestamp "$OUT/$DMG" || fail "не получилось подписать $DMG"
fi
if [ -n "$NOTARIZE" ]; then
  notarize "$OUT/$DMG"
  # What Gatekeeper will say on a user's Mac.
  if spctl --assess --type open --context context:primary-signature "$OUT/$DMG" 2> /dev/null \
    && spctl --assess --type execute "$BUNDLE/MySSH.app" 2> /dev/null; then
    echo "  ${G}✓${R} Gatekeeper принимает и приложение, и образ диска"
  else
    echo "  ${Y}!${R} Gatekeeper пока не принимает собранное; проверь: spctl -a -vv \"$BUNDLE/MySSH.app\"" >&2
  fi
fi

# What each kind of computer updates from: its name to the updater, the
# file, and the signature made for that file. Both kinds of Mac take the
# one app built for both.
UPDATES=("darwin-aarch64" "$ARCHIVE" "$BUNDLE/MySSH.app.tar.gz.sig")
UPDATES+=("darwin-x86_64" "$ARCHIVE" "$BUNDLE/MySSH.app.tar.gz.sig")
FILES=("$OUT/$ARCHIVE" "$OUT/$DMG")

# Windows: one installer, which is also what an installed copy updates
# from. With a certificate, the program and the installer are signed with
# it as they are made, and the update's own signature is made over that.
STORE=""
if [ "$WINDOWS" = "yes" ]; then
  echo "${B}release: сборка для Windows${R}"
  WIN_CONFIG="$(python3 - "$PUBKEY" "$SIGNED" "$ROOT/scripts/windows-sign.sh" <<'PY'
import json, sys
pubkey, signed, signer = sys.argv[1:4]
config = {"bundle": {"createUpdaterArtifacts": True}, "plugins": {"updater": {"pubkey": pubkey}}}
if signed:
    config["bundle"]["windows"] = {"signCommand": {"cmd": signer, "args": ["%1"]}}
print(json.dumps(config))
PY
)"
  PATH="$WIN_PATH:$PATH" TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" npx tauri build \
    --runner cargo-xwin --target "$WIN_TARGET" --bundles nsis -c "$WIN_CONFIG"
  WIN_BUNDLE="$BUILD_DIR/$WIN_TARGET/release/bundle/nsis"
  SETUP="MySSH_${VERSION}_x64-setup.exe"
  cp "$WIN_BUNDLE/$SETUP" "$OUT/$SETUP"
  UPDATES+=("windows-x86_64" "$SETUP" "$WIN_BUNDLE/$SETUP.sig")
  FILES+=("$OUT/$SETUP")

  # For the Microsoft Store, when asked: the program alone, built without
  # the release key so that it leaves updating to the store.
  if [ "$STORE_TOO" = "yes" ]; then
    echo "${B}release: сборка для Microsoft Store${R}"
    PATH="$WIN_PATH:$PATH" MYSSH_UPDATE_PUBKEY="" npx tauri build \
      --runner cargo-xwin --target "$WIN_TARGET" --no-bundle
    STORE="$OUT/store/MySSH_${VERSION}_x64.msix"
    MYSSH_MAKEMSIX="$MAKEMSIX" scripts/windows-store.sh "$BUILD_DIR/$WIN_TARGET/release/myssh.exe" "$VERSION" "$STORE"
  fi
fi

# Linux: built in Docker. One AppImage, run from wherever it is saved and
# what copies update from, signed with the release key like the others.
if [ "$LINUX" = "yes" ]; then
  echo "${B}release: сборка для Linux${R} ${D}(Docker)${R}"
  LINUX_BUNDLE="$BUILD_DIR/linux-bundle"
  rm -rf "$LINUX_BUNDLE"
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")" scripts/linux-build.sh "$LINUX_BUNDLE" \
    "{\"bundle\":{\"createUpdaterArtifacts\":true},\"plugins\":{\"updater\":{\"pubkey\":\"$PUBKEY\"}}}" > /dev/null
  APPIMAGE="MySSH_${VERSION}_amd64.AppImage"
  [ -f "$LINUX_BUNDLE/$APPIMAGE" ] && [ -f "$LINUX_BUNDLE/$APPIMAGE.sig" ] \
    || fail "сборка для Linux не оставила $APPIMAGE или его подпись"
  cp "$LINUX_BUNDLE/$APPIMAGE" "$OUT/"
  UPDATES+=("linux-x86_64" "$APPIMAGE" "$LINUX_BUNDLE/$APPIMAGE.sig")
  FILES+=("$OUT/$APPIMAGE")
fi

# Android: the bundle for Google Play, signed with the Android key, for all
# four kinds of processor phones have; Google Play makes each phone's app
# from it. Apart from the panel's files: phones are not updated from it.
ANDROID_OUT=""
if [ "$ANDROID" = "yes" ]; then
  echo "${B}release: сборка для Android${R}"
  npx tauri android build --aab
  ANDROID_OUT="$OUT/android"
  mkdir -p "$ANDROID_OUT"
  cp "$ANDROID_OUTPUTS/bundle/universalRelease/app-universal-release.aab" "$ANDROID_OUT/MySSH_${VERSION}_android.aab"
fi

python3 - "$VERSION" "https://github.com/$REPO/releases/download/v$VERSION" "$OUT/latest.json" "$NOTES_FILE" \
  "${UPDATES[@]}" <<'PY'
import datetime, json, sys
version, base, out, notes, *updates = sys.argv[1:]
latest = {
    "version": version,
    "notes": open(notes).read().strip() if notes else "",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {
        target: {"signature": open(signature).read().strip(), "url": f"{base}/{name}"}
        for target, name, signature in zip(updates[0::3], updates[1::3], updates[2::3])
    },
}
open(out, "w").write(json.dumps(latest, indent=2, ensure_ascii=False) + "\n")
PY

# The sources must still be what they were when the build began. A file
# changed meanwhile may have gone into one of the builds and not the other,
# and must not slip into the release's commit either.
CHANGED="$(git status --porcelain --untracked-files=no | cut -c4- | grep -vxF -f <(printf '%s\n' "${VERSION_FILES[@]}") || true)"
if [ -n "$CHANGED" ]; then
  echo "${RD}release:${R} пока шла сборка, изменились файлы:" >&2
  sed 's/^/  /' <<< "$CHANGED" >&2
  fail "собранному нельзя доверять; закоммить их или верни как было и запусти выпуск снова"
fi
git commit -q -m "Release $VERSION" -- "${VERSION_FILES[@]}"
git tag "v$VERSION"
COMMITTED="yes"

if [ "$GITHUB" = "yes" ]; then
  NOTES=(--notes "")
  [ -z "$NOTES_FILE" ] || NOTES=(--notes-file "$NOTES_FILE")
  gh release create "v$VERSION" "${FILES[@]}" "$OUT/latest.json" \
    --repo "$REPO" --title "MySSH $VERSION" --latest "${NOTES[@]}"
  echo "release: выложено и на github.com/$REPO — для версий, которые ищут обновления там."
fi

# Tidy up. The bundle's contents are in $OUT by now, and the front end is
# built anew every time. The cache of development builds goes too: it grows
# to tens of gigabytes and costs only a few minutes to make again. Earlier
# releases are left where they are.
rm -rf "${BUILD_DIR:?}/release/bundle" "${BUILD_DIR:?}/$MAC_TARGET/release/bundle" "${BUILD_DIR:?}/debug" dist
rm -rf "${BUILD_DIR:?}/$WIN_TARGET/release/bundle" "${BUILD_DIR:?}/$WIN_TARGET/debug" "${BUILD_DIR:?}/linux-bundle"
rm -rf src-tauri/gen/android/app/build
for TARGET in "${ANDROID_TARGETS[@]}"; do rm -rf "${BUILD_DIR:?}/$TARGET/debug"; done
find release -name .DS_Store -delete 2> /dev/null || true

# Remembered, to say next time how long it will take.
TOOK=$(($(date +%s) - STARTED))
KIND="$(build_kind)"
mkdir -p "$(dirname "$TIMES")"
{ [ ! -f "$TIMES" ] || awk -v kind="$KIND" '$1 != kind' "$TIMES"; echo "$KIND $TOOK"; } > "$TIMES.new"
mv "$TIMES.new" "$TIMES"

echo
echo "${G}${B}Готово: MySSH $VERSION за $(minutes "$TOOK").${R}"
echo "Файлы в $OUT/:"
ls -lh "$OUT" | tail -n +2 | awk '$1 !~ /^d/ { printf "  %-6s %s\n", $5, $9 }'
if [ -n "$ANDROID_OUT" ]; then
  echo "Для Google Play, в $ANDROID_OUT/ ${D}(на панель не загружается)${R}:"
  ls -lh "$ANDROID_OUT" | tail -n +2 | awk '{ printf "  %-6s %s\n", $5, $9 }'
fi
echo "Коммит «Release ${VERSION}» и тег v$VERSION — только локально."

# Uploaded, not sent: that is for the owner, on the page it names.
LOOK_OVER=""
upload_release() {
  echo
  echo "${B}release: загрузка на панель${R} ${D}($SERVER)${R}"
  if LOOK_OVER="$(python3 -B scripts/release-upload.py "$SERVER" "$OUT")"; then
    echo "  ${G}✓${R} загружено; отправить можно здесь: $LOOK_OVER"
  else
    LOOK_OVER=""
    echo "  ${Y}!${R} не загрузилось — загрузи файлы вручную на $SERVER/admin/updates" >&2
  fi
}
[ -z "$PANEL_TOKEN" ] || upload_release
notify "MySSH $VERSION собрана"

if [ -z "$MENU" ]; then
  echo
  if [ -n "$LOOK_OVER" ]; then
    echo "Чтобы выпустить: открой $LOOK_OVER, проверь и нажми «Отправить»."
  else
    echo "Чтобы выпустить: открой $SERVER/admin/updates, загрузи файлы из $OUT/ и сделай $VERSION текущей."
  fi
  [ -z "$STORE" ] || echo "Для Microsoft Store: отправь $STORE в Partner Center."
  [ -z "$ANDROID_OUT" ] || echo "Для Google Play: загрузи $ANDROID_OUT/MySSH_${VERSION}_android.aab в Play Console."
  exit 0
fi

# ------------------------------------------------------- what comes next ---
# What the menu offers for the panel, as things stand: uploaded or not.
panel_items() {
  if [ -n "$LOOK_OVER" ]; then
    PANEL="Проверить и отправить на панели  ${D}$LOOK_OVER${R}"
    FINDER="Показать файлы в Finder"
    UPLOAD="${G}✓${R} Загружено на панель"
  else
    PANEL="Открыть панель обновлений  ${D}$SERVER/admin/updates${R}"
    FINDER="Показать файлы в Finder  ${D}их и нужно загрузить${R}"
    if [ -n "$PANEL_TOKEN" ]; then
      UPLOAD="Загрузить на панель ещё раз"
    else
      UPLOAD="Вставить токен панели и загрузить  ${D}вместо загрузки вручную${R}"
    fi
  fi
}
echo
if [ -n "$LOOK_OVER" ]; then
  echo "${B}Что осталось:${R} проверить $VERSION на панели и нажать «Отправить» —"
else
  echo "${B}Что осталось:${R} загрузить файлы на панели ($SERVER/admin/updates) и сделать $VERSION текущей —"
fi
echo "тогда установленные копии предложат обновиться."
[ -z "$STORE" ] || echo "Для Microsoft Store: отправить $STORE в Partner Center."
[ -z "$ANDROID_OUT" ] || echo "Для Google Play: загрузить $ANDROID_OUT/MySSH_${VERSION}_android.aab в Play Console."
panel_items
PUSH="Отправить в GitHub  ${D}git push и тег v$VERSION${R}"
while :; do
  choose "Что дальше?" 0 "$PANEL" "$FINDER" "$PUSH" "$UPLOAD" "Выйти"
  case "$CHOICE" in
    0)
      open "${LOOK_OVER:-$SERVER/admin/updates}" || true
      PANEL="${G}✓${R} ${PANEL%%  *}"
      ;;
    1)
      open "$OUT" || true
      FINDER="${G}✓${R} Показать файлы в Finder"
      ;;
    2)
      if git push -q && git push -q origin "v$VERSION"; then
        echo "  ${G}✓${R} отправлено"
        PUSH="${G}✓${R} Отправлено в GitHub"
      else
        echo "  ${RD}✗${R} не получилось; можно попробовать ещё раз"
      fi
      ;;
    3)
      if [ -z "$LOOK_OVER" ]; then
        # A kept token the panel no longer takes is asked for anew.
        CHECKED=0
        [ -z "$PANEL_TOKEN" ] || python3 -B scripts/release-upload.py --check "$SERVER" 2> /dev/null || CHECKED=$?
        if [ "$CHECKED" -eq 1 ]; then
          echo "  ${Y}Сохранённый токен панель больше не принимает.${R}"
          PANEL_TOKEN=""
        fi
        if [ -n "$PANEL_TOKEN" ] || paste_panel_token; then
          upload_release
          panel_items
        fi
      fi
      ;;
    4) break ;;
  esac
done
