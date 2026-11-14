# Android development environment

Research date: 7 November 2026. This guide separates preparing the host, starting a virtual device, compiling the app, and reloading JavaScript. Bean Budget now owns a pinned `nix/` development shell, direnv activation, and Android doctor/setup/emulator scripts (see the README quick start). The first offline mobile slice is implemented in `apps/mobile`; see the implemented workflow and manual checks at the end. No SDK downloads, emulator boot, or changes to the existing Spend Bean virtual device were performed for this research.

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

This temporarily borrows the existing working shell. Bean Budget now owns its shell definition: use `direnv allow` or `nix develop path:./nix` instead of borrowing Spend Bean’s shell. Run `exit` to leave the manual shell.

## One time preparation for Bean Budget

1. Run `direnv allow` in the repository root. The pinned `nix/` shell supplies Node 22 and JDK 17 and exposes the existing SDK. Alternatively use `nix develop path:./nix`. Both respect `ANDROID_HOME` and `ANDROID_AVD_HOME` overrides; activation does not install SDKs or accept licenses.
2. Run `npm run android:doctor` and verify the SDK components against the selected mobile Expo version. Existing SDK 58 components appear suitable; a native build remains the final check. Android Studio is an optional graphical SDK/device manager for this existing command-line installation, rather than a necessary second SDK installation.
3. Run `npm run android:setup` to create a dedicated `bean-budget` ARM64 virtual device from the installed image (existing devices are kept). Preserve `spend-bean` and its app data. With the environment active, the command below uses the already installed image; it is a setup command, not something executed during this research:

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

The development client is installed as a dependency of `apps/mobile`. Use the root `android:build` and `android:dev` commands described below. Development uses a separate app identity. The standalone release and isolated verification variant are described in [Android release and updates](ANDROID_RELEASE.md).

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

## Command interface

Available now:

- `npm run android:doctor`: checks Node, npm, Java, SDK tools, acceleration, the selected system image, available AVDs and connected devices. It installs nothing. Device inventory uses adb, which may start its local daemon.
- `npm run android:setup`: explicitly creates the configured AVD if missing, without overwriting devices or downloading an image.
- `npm run android:emulator`: starts the configured Bean Budget AVD in the foreground or reports its running device serial. It does not wait for completed boot; use the boot check above before building.

`BEAN_AVD` defaults to `bean-budget`; `BEAN_ANDROID_IMAGE` defaults to the inspected API 37 Google APIs ARM64 image. The following commands are implemented (Metro only; no backend mapping):

- `npm run android:build`: select a device, configure Metro port reversal, compile/install the dev app, and start Metro.
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

Validated here: Java through the existing Nix shell, SDK/AVD inventory, explicit AVD discovery in avdmanager, adb binary/help, and emulator acceleration. Still to validate after mobile exists: booting its dedicated AVD, a clean native build, Metro connectivity, authenticated backend access from Android, and widget rendering. The initial research did not exercise a mobile runtime; implementation validation is recorded below.

## Implemented offline slice

The separate application now lives in `apps/mobile`. Expo 58 uses React 19.3 and React Native 0.88, verified against the [versioned official compatibility table](https://docs.expo.dev/versions/v58.0.0/); `expo install` selects the compatible native module versions. Its development-only package is `app.beanbudget.dev` (Bean Budget Dev), separate from Spend Bean. Native directories are generated and ignored.

After the dedicated emulator finishes booting, run `npm run android:build`. This generates Android, compiles and installs the development binary, and starts Metro on port 8081. On later JavaScript-only sessions use `npm run android:dev`; it verifies the binary is installed and starts Metro without compiling. Both commands restore the selected device's Metro reverse mapping. Set `ANDROID_SERIAL` explicitly when multiple devices are connected. Rebuild for native dependency or app configuration changes. No backend connection or backend port reversal is needed in this slice. The development build needs Metro even when financial operations are offline; do not confuse offline data storage with an embedded production JS bundle.

The screen has one local cash account starting at zero, signed whole JPY entry, a financial date initially in Asia/Tokyo, a ledger balance, transactions and a durable pending count. Shared Effect schemas validate entries and stored transactions; the shared bigint balance function enforces the same limits as the server. The native SQLite transaction inserts the financial record and serialized CreateTransaction operation with stable operation ID together. A versioned local schema uses WAL and foreign keys. This database belongs to the app sandbox and survives force-stop/relaunch and development build updates; uninstalling or clearing app data removes it. The local account ID is provisional; pending operations are not yet suitable for submission to a server account. No synchronization worker consumes or deletes them.

Manual spot check (no automated tests):

1. Build, open Bean Budget Dev, and confirm zero balance and an empty ledger.
2. Keep Metro reachable over adb reverse; disable Android Wi-Fi/mobile data. Save `-550` for a valid date, then `1000`. Expect two pending operations and balance ¥450.
3. Try `1.5`, an impossible date, and an amount/balance beyond ±1,000,000,000,000. Expect a visible error, retained input, and unchanged ledger/pending count.
4. Force-stop `app.beanbudget.dev`, then reopen it (or rerun `android:dev` and open the dev-client project). Expect both records, ¥450, and two pending operations. A Metro reload alone is not this restart check.
5. Inspect storage if needed with `adb -s "$ANDROID_SERIAL" shell run-as app.beanbudget.dev ls files/SQLite`. Copy SQLite plus WAL/SHM only with the app stopped, or use SQLite backup tooling. Do not reset or uninstall either project's device/app to check persistence.

Widgets, web, server synchronization, authentication and real-device background behavior remain outside this slice.

Implementation validation on 7 November 2026: `npm run check` passed with zero Effect warnings; `expo install --check` passed, and Android Hermes export succeeded. Generated SDK values were compile 37, target 36, build tools 37.0.0, NDK 27.1.12297006. The ARM64 debug build completed with JDK 17 through the repository Nix shell and installed on the new `bean-budget` AVD. With Wi-Fi and mobile data disabled (Metro reachable through adb reverse), manual UI entry of -550 and +1000 showed ¥450 and two pending operations after force-stop and relaunch. Entry of 1.5 showed an error and retained the input without changing balance or pending count. A stopped-app SQLite/WAL copy showed two transactions summing to 450, two unique outbox IDs with payload amounts -550/+1000, and no foreign-key violations. Invalid-date/balance-limit UI checks and real-device behavior remain to be checked. Upstream Expo/Gradle deprecation warnings remain; npm audit reports five moderate transitive Expo CLI/fingerprint/glob/minimatch advisories. No forced dependency upgrades were applied.

## Transaction register validation

The register build with SecureStore compiled and installed on the dedicated `bean-budget` ARM64 emulator using `nix develop path:./nix --command npm run android:build`. Native Expo/Gradle dependency deprecation warnings remain separate from the project check, which requires zero warnings.

Actual UI checks used synthetic data only. The existing prototype database migrated with Cash JPY transactions -550 and +1000, retaining ¥450 and both queued operations. Through the rendered UI, a new USD Travel account opened at $100.00. With Android Wi-Fi and mobile data disabled, a pending expense of $12.34 saved locally. Force-stop and relaunch retained both accounts and that transaction. Metro remained reachable through adb reverse, as required by the development client.

After restoring connectivity, the connection screen saved a temporary server URL and token in SecureStore and cleared the token field. Sync against a temporary server database accepted all five ledger entries, including the two opening entries. The server snapshot showed Cash posted/projected 450 JPY and Travel posted 10000/projected 8766 USD cents. The register showed Bank pending separately from Synced and zero waiting operations. Posting the expense created one local operation, then synchronization preserved the five-entry ledger and changed Travel posted/projected balances to 8766 cents. Invalid opening text `0g` displayed a field-validation error and retained the entry without creating an account.

Independent visual review inspected actual account/register, entry, decimal keyboard/focus, empty ordinary register, invalid entry, pending/offline, restarted, and reconnected screenshots. A scrolling status-bar overlap found during the pass was fixed with an outer status-bar inset and re-inspected. Native device behavior, production embedded-bundle offline startup, and OS-driven background synchronization remain unverified; this milestone uses foreground/manual synchronization.
