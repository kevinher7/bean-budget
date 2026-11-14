#!/usr/bin/env bash
set -euo pipefail
avd="${BEAN_AVD:-bean-budget}"
image="${BEAN_ANDROID_IMAGE:-system-images;android-37.0;google_apis;arm64-v8a}"

require() {
  command -v "$1" >/dev/null || { echo "Missing $1. Enter the direnv environment (or run nix develop path:./nix)." >&2; exit 1; }
}

case "${1:-}" in
  build|dev)
    action="$1"
    export BEAN_APP_VARIANT=development
    require adb
    require node
    if [[ -z "${ANDROID_SERIAL:-}" ]]; then
      devices=()
      while read -r serial state rest; do
        [[ "$state" == device ]] && devices+=("$serial")
      done < <(adb devices)
      if [[ "${#devices[@]}" != 1 ]]; then
        echo "Set ANDROID_SERIAL to one connected device (adb devices)." >&2
        exit 1
      fi
      export ANDROID_SERIAL="${devices[0]}"
    fi
    adb -s "$ANDROID_SERIAL" get-state
    adb -s "$ANDROID_SERIAL" reverse tcp:8081 tcp:8081
    cd "$(dirname "$0")"
    if [[ "$action" == build ]]; then
      npx expo prebuild --platform android --clean --no-install
      exec npx expo run:android --device "$ANDROID_SERIAL" --port 8081
    fi
    if ! adb -s "$ANDROID_SERIAL" shell pm path app.beanbudget.dev | grep -q package:; then
      echo "Development build missing. Run npm run android:build first." >&2
      exit 1
    fi
    echo "Open Bean Budget Dev on $ANDROID_SERIAL and select the localhost:8081 development server."
    exec npx expo start --dev-client --localhost --port 8081
    ;;
  doctor)
    for tool in node npm java adb emulator avdmanager; do require "$tool"; done
    node --version
    npm --version
    java -version
    adb version
    echo "SDK: ${ANDROID_HOME:-unset}"
    echo "AVDs: ${ANDROID_AVD_HOME:-unset}"
    emulator -accel-check
    emulator -list-avds
    adb devices -l
    if [[ ! -d "${ANDROID_HOME:-}/${image//;/\/}" ]]; then
      echo "Selected system image is missing. Install it explicitly with SDK Manager." >&2
      exit 1
    fi
    ;;
  setup)
    require avdmanager
    require emulator
    if emulator -list-avds | grep -Fxq "$avd"; then
      echo "$avd already exists; keeping its data."
      exit 0
    fi
    # No force flag: never replace an existing device. SDK downloads are separate.
    avdmanager create avd --name "$avd" --package "$image" <<< no
    ;;
  emulator)
    require emulator
    require adb
    if ! emulator -list-avds | grep -Fxq "$avd"; then
      echo "Missing $avd. Run npm run android:setup first." >&2
      exit 1
    fi
    while read -r serial state rest; do
      [[ "$serial" == emulator-* && "$state" == device ]] || continue
      name="$(adb -s "$serial" emu avd name | tr -d '\r' | head -n 1)"
      if [[ "$name" == "$avd" ]]; then
        echo "$avd is already running on $serial."
        exit 0
      fi
    done < <(adb devices)
    exec emulator -avd "$avd"
    ;;
  *) echo "Usage: bash apps/mobile/android.sh {doctor|setup|emulator|build|dev}" >&2; exit 1 ;;
esac
