# Android release and updates

Bean Budget builds an installable ARM64 APK with embedded Hermes JavaScript. It does not need Metro, Expo Go, an Expo account, or an OTA update service. The current target is the Pixel 9a and ARM64 emulator. The build command only creates files; it never installs an app or publishes a release.

## App identity

`apps/mobile/app.json` owns the release version and Android version code. The first release is `0.0.1`, code `1`. Increase both before each distributed update and keep the GitHub tag equal to `v<version>`. Android updates require the same package and signing certificate, with a higher version code. [Android versioning](https://developer.android.com/studio/publish/versioning)

| Variant                | Package                | Build                                  |
| ---------------------- | ---------------------- | -------------------------------------- |
| Development            | `app.beanbudget.dev`   | Debug build with Metro                 |
| Release                | `app.beanbudget`       | Signed release with bundled JavaScript |
| Synthetic verification | `app.beanbudget.probe` | Signed release with bundled JavaScript |

`BEAN_APP_VARIANT` defaults to `development` in Expo and `release` in the release wrapper. The probe identity gives verification its own app sandbox. Never clear or uninstall a user's existing app to run probes. Native projects are generated and ignored by Git. The build wrappers regenerate `apps/mobile/android` for their variant, so run one native build at a time.

Release connections require HTTPS. Development and probe builds permit HTTP for isolated local servers. Android cloud backup and device transfer exclude app data; use the explicit mobile backup flow to retain pending edits. Server backups alone cannot recover unsynchronized mobile operations.

## Signing key

Spend Bean keeps its release key outside Git and supplies four GitHub repository secrets. Bean Budget uses the same arrangement with a distinct key. Do not reuse another app's key or let a temporary emulator key become the production identity.

Enter the repository Nix environment, then generate the key once:

```sh
npm run android:signing-key
```

The command resolves symlinks and relative path segments, rejects destinations inside any Git repository, and refuses to replace an existing directory. It creates `~/.config/bean-budget/android-signing/release.jks` and an owner-only `signing.env`. Passwords come from the operating system's random source and never appear in command arguments or console output. The environment file contains credentials; never attach it to a PR or exported budget backup.

Copy the entire directory into encrypted backup storage and confirm it can be recovered before distributing the first APK. Keep a second copy outside this Mac. GitHub secrets are a build copy, not a retrievable backup. Losing the signing key prevents ordinary in-place updates for this APK distribution. [Android app signing](https://developer.android.com/studio/publish/app-signing)

Build locally:

```sh
source "$HOME/.config/bean-budget/android-signing/signing.env"
npm run android:release
```

The build uses SDK platform 37, build tools 37.0.0, JDK 17, NDK 27.1.12297006 and CMake 3.22.1. Run `npm run android:doctor` for the host setup. Expo prebuild writes the generated native project; Gradle's `assembleRelease` embeds the bundle. The local plugin replaces Expo's debug signing fallback with release credentials. Missing credentials fail the build. [Expo local release builds](https://docs.expo.dev/guides/local-app-production/)

Output defaults to `.local/android-release/`:

- `bean-budget-0.0.1-arm64-v8a.apk`
- `SHA256SUMS`
- `signature.txt`, including the signing certificate SHA-256
- `apk-info.txt`, including package and version
- `source-commit.txt` and `source-worktree-status.txt`

The wrapper checks the embedded bundle, package, version, non-debuggable flag, signature fingerprint and APK alignment. `BEAN_ANDROID_OUTPUT` chooses another output directory. An empty source worktree status identifies a build from an unchanged commit. Keep verification artifacts from a dirty checkout clearly labeled until rebuilding the committed source.

For isolated emulator verification, use `BEAN_APP_VARIANT=probe`. It can use the same signing key while keeping a separate Android app sandbox. The release wrapper still requires a matching expected fingerprint. Install only the probe APK on the selected device; keep Metro and the existing development app running as they are.

## GitHub workflow

`Build Android release` is manual and runs only for this repository's `main` branch. It checks the project, builds the signed APK and retains an Actions artifact for 14 days. It does not create tags, GitHub releases, or public downloads.

Configure the `android-release` environment with branch restriction to `main` and a required reviewer where the repository plan supports those controls. Match the existing Spend Bean secret names:

| Kind            | Name                          |
| --------------- | ----------------------------- |
| Secret          | `ANDROID_KEYSTORE_BASE64`     |
| Secret          | `ANDROID_KEYSTORE_PASSWORD`   |
| Secret          | `ANDROID_KEY_ALIAS`           |
| Secret          | `ANDROID_KEY_PASSWORD`        |
| Public variable | `ANDROID_SIGNING_CERT_SHA256` |

Store the base64 encoding of `release.jks` as the first secret. Use the corresponding values from the protected external signing environment for the other secrets. Supply values through stdin or a secret manager; do not paste them into shell commands or chat. The public certificate fingerprint is safe to record.

The workflow token has only `contents: read`; all unspecified permissions are disabled. Checkout does not persist credentials. Every action uses a full commit SHA. Signing credentials exist only in the signing step; the temporary keystore is removed when that step exits. Workflow dispatch cannot publish with this token.

## GitHub releases and Obtainium

After explicit approval to publish, create a GitHub release for the reviewed main commit. Use tag `v0.0.1` and attach the APK, checksum, public certificate report and source commit. Later releases use the same package and certificate with higher version values. Do not replace an existing release asset with different bytes. Retain old artifacts for recovery, but do not downgrade an installed app or clear data to make an older APK install.

Add `https://github.com/kevinher7/bean-budget` as a GitHub source in Obtainium. Filter APK names with `^bean-budget-[0-9]+\.[0-9]+\.[0-9]+-arm64-v8a\.apk$`, exclude prereleases and drafts, and enable Verify Latest Tag if releases use GitHub's Latest marker. Actions artifacts are not an Obtainium update source. A published GitHub release with an attached APK is required. [Obtainium source options](https://wiki.obtainium.imranr.dev/sources/)

The repository is public. Obtainium can discover published releases and download their APK assets without a GitHub account or token. A fine-grained token with public read access is optional if GitHub API rate limits become a problem. Add it only in Obtainium's GitHub settings and leave the proxy prefix empty; it never belongs in Bean Budget or its APK. [Obtainium source options](https://wiki.obtainium.imranr.dev/sources/), [GitHub release API permissions](https://docs.github.com/en/rest/releases/releases)

Verify release discovery, download and an in-place update in Obtainium on the Pixel after the first authorized publication. No release has been published by the build workflow. Local signed builds verify the installable artifact, but they cannot verify a download that does not exist yet.
