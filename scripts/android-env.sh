# Where the tools for building MySSH for Android are, sourced by
# scripts/release.sh and scripts/android-build.sh. Sets what Tauri and the
# build need (JAVA_HOME, ANDROID_HOME, NDK_HOME, PATH, and a ranlib for each
# processor, which OpenSSL, built into the app for Android, looks for), and
# lists in ANDROID_MISSING the commands that install whatever is missing.
#
# Homebrew's places are taken when the variables are not set:
#   brew install openjdk@17 && brew install --cask android-commandlinetools
#   sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" "ndk;27.2.12479018"
# (Gradle fetches a newer platform by itself when the project asks for one.)

ANDROID_MISSING=()
ANDROID_TARGETS=(aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android)

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2> /dev/null | sort -V | tail -n 1 || true)"
fi
export NDK_HOME

[ -x "$JAVA_HOME/bin/java" ] || ANDROID_MISSING+=("brew install openjdk@17")
if [ ! -d "$ANDROID_HOME/platforms" ]; then
  [ -d "$ANDROID_HOME/cmdline-tools" ] || ANDROID_MISSING+=("brew install --cask android-commandlinetools")
  ANDROID_MISSING+=("sdkmanager \"platform-tools\" \"platforms;android-35\" \"build-tools;35.0.0\" \"ndk;27.2.12479018\"")
elif [ -z "$NDK_HOME" ] || [ ! -d "$NDK_HOME" ]; then
  ANDROID_MISSING+=("sdkmanager \"ndk;27.2.12479018\"")
fi
android_installed="$(rustup target list --installed 2> /dev/null || true)"
android_targets_missing=()
for android_target in "${ANDROID_TARGETS[@]}"; do
  grep -qx "$android_target" <<< "$android_installed" || android_targets_missing+=("$android_target")
done
[ "${#android_targets_missing[@]}" -eq 0 ] || ANDROID_MISSING+=("rustup target add ${android_targets_missing[*]}")
unset android_installed android_targets_missing android_target

export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
if [ -n "$NDK_HOME" ] && [ -d "$NDK_HOME" ]; then
  android_ranlib="$(ls -d "$NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-ranlib 2> /dev/null | head -n 1 || true)"
  for android_target in "${ANDROID_TARGETS[@]}"; do
    export "RANLIB_${android_target//-/_}=$android_ranlib"
  done
  unset android_ranlib android_target
fi

# Where Gradle leaves what it builds.
ANDROID_OUTPUTS="src-tauri/gen/android/app/build/outputs"

# The phones and emulators adb sees, one serial a line.
android_devices() {
  command -v adb > /dev/null || return 0
  adb devices 2> /dev/null | awk 'NR > 1 && $2 == "device" { print $1 }'
}
