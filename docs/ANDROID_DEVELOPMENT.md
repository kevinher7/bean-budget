# Android development environment

Research date: 7 November 2026. This guide separates preparing the host, starting a virtual device, compiling the app, and reloading JavaScript. Bean Budget currently has no mobile application, so the Expo commands below describe the workflow to implement when `apps/mobile` is added. No SDK downloads, emulator boot, or changes to the existing Spend Bean virtual device were performed for this research.

## Recommended setup

Use a local Expo development build and an ARM64 Android Emulator on this Apple Silicon Mac. Keep Node and JDK versions in a repository Nix shell, and keep the large Android SDK installation and virtual-device data outside Git. Use one SDK installation for both projects, with a separate virtual device for Bean Budget.

A development build supports the native modules needed by the app and widgets. Expo Go is useful for limited experiments but is not the intended widget development environment. Local Expo builds do not require an Expo account or cloud build service. [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/)

## What exists on this machine

The following were inspected directly:

- Host: macOS on `arm64`, with Nix and direnv installed.
- Android SDK: `~/Library/Android/sdk`.
- SDK platform: Android 37.0; build tools 36.0.0 and 37.0.0.
- NDK: 27.1.12297006; CMake: 3.22.1.
- Platform tools: adb 37.0.1, executable by its full SDK path.
- System image: Android 37.0, Google APIs, `arm64-v8a`.
- Virtual device: `spend-bean`, using that ARM64 image.
- Emulator acceleration check: successful, using Hypervisor.Framework.
- Current shell: SDK tools are not on PATH; `/usr/bin/java` exists but cannot locate a registered Java runtime.
- Spend Bean's Nix shell successfully runs JDK 17.0.19. There is no need to infer Java availability from `/usr/bin/java` alone.
- Device discovery differs between the installed tools: `emulator -list-avds` finds `spend-bean`, while `avdmanager list avd` initially lists none. Explicitly setting `ANDROID_AVD_HOME="$HOME/.android/avd"` makes avdmanager find the same device. Keep this path consistent across both tools.

The installed Spend Bean Expo 58 / React Native 0.88 files specify compile SDK 37, target SDK 36, build tools 37.0.0 and NDK 27.1.12297006. Expo's versioned SDK 58 documentation agrees on compile/target SDK 37/36. Generic setup instructions still mention platform 36, so use the selected Expo version and generated native configuration when checking prerequisites. The emulator image version and compile SDK are separate choices. [Expo SDK 58 compatibility](https://docs.expo.dev/versions/v58.0.0/)

## Why Spend Bean's setup was easy to misunderstand

`../spend-bean/flake.nix` provides Node 22 and JDK 17. It does not install the Android SDK or start an emulator. `../spend-bean/.envrc` enters that shell, sets `ANDROID_HOME`, and adds SDK command-line tools, platform tools and emulator to PATH.

`nix develop ../spend-bean` supplies Java and Node, but does not execute that project's `.envrc` SDK exports. Direnv applies the `.envrc` only when enabled and authorized. Each terminal running Gradle, Expo, or SDK tools needs the appropriate environment.

For a manual environment check from the Bean Budget root today:

```sh
nix develop ../spend-bean
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_AVD_HOME="$HOME/.android/avd"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
java -version
adb version
emulator -list-avds
emulator -accel-check
```

This temporarily borrows the existing working shell. Bean Budget should own its shell definition before mobile development starts, so it does not depend on a sibling checkout. Run `exit` to leave the manual shell.

## One time preparation for Bean Budget

1. Add a small Bean Budget Nix shell for the project's Node version and JDK 17, and an `.envrc` that activates it and exposes the existing SDK. Allow `ANDROID_HOME` and `ANDROID_AVD_HOME` overrides, defaulting to the inspected macOS paths. Keep direnv optional: provide a documented `nix develop` entry path with the same SDK/AVD exports. Commit the Nix lockfile. Do not put SDK downloads or license acceptance into shell startup.
2. Verify the SDK components against the selected mobile Expo version. Existing SDK 58 components appear suitable; a native build remains the final check. Android Studio is an optional graphical SDK/device manager for this existing command-line installation, rather than a necessary second SDK installation.
3. Create a dedicated `bean-budget` ARM64 virtual device. Preserve `spend-bean` and its app data. With the environment active, the command below uses the already installed image; it is a setup command, not something executed during this research:

```sh
printf 'no\n' | avdmanager create avd \
  --name bean-budget \
  --package 'system-images;android-37.0;google_apis;arm64-v8a'
```

If the selected image is not installed on a new machine, install it with SDK Manager first. Android Studio's Device Manager is the graphical alternative. Choose ARM64 on Apple Silicon. Do not use force/overwrite flags or wipe an existing device to fix ordinary connectivity problems.

The installed `emulator -list-avds` and acceleration commands work here. Android also documents a newer Android CLI; adopting that extra tool is unnecessary for reproducing this installed workflow. [Android emulator command line](https://developer.android.com/studio/run/emulator-commandline)

## Daily workflow

Think of three running processes: the backend serves financial data, the emulator runs Android, and Metro serves JavaScript to the installed development build. Gradle only needs to run when the native app needs rebuilding.

Once the dedicated device exists, start it in its own terminal:

```sh
emulator -avd bean-budget
```

In another environment-enabled terminal, inspect `adb devices -l`, select the actual device serial, then wait for boot. For a single emulator it is commonly `emulator-5554`, but do not assume that when another device is connected:

```sh
adb -s emulator-5554 wait-for-device
adb -s emulator-5554 shell getprop sys.boot_completed
```

Proceed when `sys.boot_completed` returns `1`; appearing in adb alone does not mean Android has finished booting. [adb device selection](https://developer.android.com/tools/adb)

After `apps/mobile` is implemented, install the development client there with `npx expo install expo-dev-client`. For its first native build, run from that directory:

```sh
APP_VARIANT=dev npx expo run:android --device
```

The variant must be implemented in app configuration first; the environment variable alone does not change the Android package ID. Choose the emulator in the device picker. On subsequent sessions that only change JavaScript or TypeScript:

```sh
APP_VARIANT=dev npx expo start --dev-client --localhost
```

Rebuild after native dependency or config-plugin changes, not after every screen change. Keep `android/` generated and make native configuration through app config/plugins. Use a clean prebuild deliberately after native configuration changes; it replaces the generated native directory. [Expo local build and reload workflow](https://docs.expo.dev/guides/local-app-development/)

## Connecting to the backend

The emulator's `localhost` belongs to Android, not the Mac. There are two useful routes:

- For emulator-only use, `http://10.0.2.2:<server-port>` reaches the Mac's loopback interface. [Android emulator addresses](https://developer.android.com/studio/run/emulator-networking-address)
- For one consistent USB/emulator workflow, use adb reverse and configure the app with `http://127.0.0.1:<server-port>`. This avoids changing the API hostname when moving to an attached phone.

I recommend the second route for the project wrappers. After selecting the correct device, map the server's configured port and Metro's port:

```sh
adb -s emulator-5554 reverse tcp:3000 tcp:3000
adb -s emulator-5554 reverse tcp:8081 tcp:8081
adb -s emulator-5554 reverse --list
```

Here `3000` is an example; use the actual backend port from [the server guide](SERVER.md). Repeat the mapping after reconnecting or restarting the relevant device/adb connection. The installed adb help documents `reverse` and `--list`; verify the mapping rather than assuming it persists. Metro's default port is 8081; map the chosen port if it reports using a different one.

Local HTTP must be permitted by the development Android build. Spend Bean's generated debug manifest already enables cleartext traffic. Verify Bean Budget's generated debug configuration too; keep production HTTPS policy separate and do not globally relax release traffic settings to fix development. `expo-build-properties` exposes `usesCleartextTraffic` if a deliberate app-config setting is required. [Expo 58 native network configuration](https://docs.expo.dev/versions/v58.0.0/sdk/build-properties/)

Use a development-only backend credential. Do not place a bearer token in an `EXPO_PUBLIC_*` variable: those values become client bundle data. A public API base URL is appropriate there. The first client can accept the credential through its connection screen and keep it in platform secure storage.

## Proposed command interface

When mobile is implemented, expose these root commands. These names are a proposal, not scripts currently available:

- `npm run android:doctor`: read-only checks for Node, Java, SDK tools/components, acceleration, available AVDs and connected devices, with actionable fixes. Do not print secrets or mutate SDK state.
- `npm run android:emulator`: start the configured Bean Budget AVD, reusing an already running instance when possible and waiting for completed boot.
- `npm run android:build`: select a device, configure port reversal, compile/install the dev app, and start Metro.
- `npm run android:dev`: select a running device, restore port reversal, and start Metro for an existing dev build. If the native app is missing, explain that `android:build` is needed.

Device selection must be explicit when multiple targets exist; an environment override such as `ANDROID_SERIAL` can avoid a picker. Run the backend in a separate terminal with the actual documented server command. Small wrappers around these distinct actions are easier to understand than one script that silently downloads tools, rebuilds, and changes devices.

## Troubleshooting and validation

- **Java not found:** enter the repository shell; the macOS Java shim is not evidence of a working JDK. Verify `JAVA_HOME` and `java -version` in the terminal that runs Expo.
- **adb/emulator not found:** SDK activation is missing. Check `ANDROID_HOME` and PATH before reinstalling anything.
- **Tools disagree about virtual devices:** set `ANDROID_AVD_HOME` explicitly to the directory containing the `.ini` and `.avd` entries. This resolved the inspected emulator/avdmanager discrepancy without recreating a device.
- **App installs but cannot reach the server:** check the backend on the Mac first, then selected adb serial, reverse mappings, app API URL, and debug cleartext policy. The bearer token is a separate authentication issue.
- **Metro unreachable:** check its chosen port, reverse that port, and use the dev-client localhost workflow consistently.
- **Native module missing:** rebuild the development binary; restarting Metro cannot add native libraries.
- **Widget looks stale:** Fast Refresh does not prove the launcher widget tree was redrawn. Trigger its update path explicitly and verify its timestamp. Test background and battery behavior on a real phone before relying on it.

Validated here: Java through the existing Nix shell, SDK/AVD inventory, explicit AVD discovery in avdmanager, adb binary/help, and emulator acceleration. Still to validate after mobile exists: booting its dedicated AVD, a clean native build, Metro connectivity, authenticated backend access from Android, and widget rendering. No mobile runtime is claimed to be working yet.
