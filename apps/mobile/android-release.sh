#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"

require() {
  command -v "$1" >/dev/null || { echo "Missing $1. Enter the repository Nix environment." >&2; exit 1; }
}

if [[ "${1:-}" == keygen ]]; then
  require keytool
  require node
  require git
  signing_directory="${2:-$HOME/.config/bean-budget/android-signing}"
  [[ "$signing_directory" == /* ]] || { echo "Signing directory must be an absolute path outside the repository." >&2; exit 1; }
  signing_directory="$(node - "$signing_directory" <<'NODE'
const { existsSync, realpathSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
let ancestor = resolve(process.argv[2]);
const missing = [];
while (!existsSync(ancestor)) {
  missing.unshift(basename(ancestor));
  ancestor = dirname(ancestor);
}
process.stdout.write(join(realpathSync(ancestor), ...missing));
NODE
)"
  existing_directory="$signing_directory"
  while [[ ! -d "$existing_directory" ]]; do existing_directory="$(dirname "$existing_directory")"; done
  if git -C "$existing_directory" rev-parse --git-dir >/dev/null 2>&1; then
    echo "Keep signing keys outside every Git repository." >&2
    exit 1
  fi
  [[ ! -e "$signing_directory" ]] || { echo "Signing directory already exists; refusing to replace a key." >&2; exit 1; }
  umask 077
  mkdir -p "$signing_directory"
  export BEAN_ANDROID_KEYSTORE="$signing_directory/release.jks"
  export BEAN_ANDROID_KEYSTORE_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  export BEAN_ANDROID_KEY_PASSWORD="$BEAN_ANDROID_KEYSTORE_PASSWORD"
  export BEAN_ANDROID_KEY_ALIAS=bean-budget
  keytool -genkeypair -keystore "$BEAN_ANDROID_KEYSTORE" -storetype PKCS12 \
    -storepass:env BEAN_ANDROID_KEYSTORE_PASSWORD -keypass:env BEAN_ANDROID_KEY_PASSWORD \
    -alias "$BEAN_ANDROID_KEY_ALIAS" -keyalg RSA -keysize 3072 -validity 10000 \
    -dname 'CN=Bean Budget Android Release'
  export BEAN_ANDROID_SIGNING_CERT_SHA256="$(keytool -exportcert -keystore "$BEAN_ANDROID_KEYSTORE" \
    -storepass:env BEAN_ANDROID_KEYSTORE_PASSWORD -alias "$BEAN_ANDROID_KEY_ALIAS" | \
    node -e 'const {createHash}=require("node:crypto"); const hash=createHash("sha256"); process.stdin.on("data",data=>hash.update(data)); process.stdin.on("end",()=>process.stdout.write(hash.digest("hex")));')"
  {
    printf 'export BEAN_ANDROID_KEYSTORE=%q\n' "$BEAN_ANDROID_KEYSTORE"
    printf 'export BEAN_ANDROID_KEYSTORE_PASSWORD=%q\n' "$BEAN_ANDROID_KEYSTORE_PASSWORD"
    printf 'export BEAN_ANDROID_KEY_ALIAS=%q\n' "$BEAN_ANDROID_KEY_ALIAS"
    printf 'export BEAN_ANDROID_KEY_PASSWORD=%q\n' "$BEAN_ANDROID_KEY_PASSWORD"
    printf 'export BEAN_ANDROID_SIGNING_CERT_SHA256=%q\n' "$BEAN_ANDROID_SIGNING_CERT_SHA256"
  } > "$signing_directory/signing.env"
  echo "Created signing material in $signing_directory. Back up this directory in encrypted storage before distributing an APK."
  echo "Certificate SHA-256: $BEAN_ANDROID_SIGNING_CERT_SHA256"
  exit 0
fi

require node
require npm
require java
require unzip
: "${ANDROID_HOME:?Enter the repository Nix environment or set ANDROID_HOME.}"
: "${BEAN_ANDROID_KEYSTORE:?Source your external signing.env first.}"
: "${BEAN_ANDROID_KEYSTORE_PASSWORD:?Missing keystore password.}"
: "${BEAN_ANDROID_KEY_ALIAS:?Missing key alias.}"
: "${BEAN_ANDROID_KEY_PASSWORD:?Missing key password.}"
: "${BEAN_ANDROID_SIGNING_CERT_SHA256:?Set the expected signing certificate SHA-256.}"
[[ "$BEAN_ANDROID_KEYSTORE" == /* && -f "$BEAN_ANDROID_KEYSTORE" ]] || { echo "Keystore must be an existing absolute file path." >&2; exit 1; }
export BEAN_APP_VARIANT="${BEAN_APP_VARIANT:-release}"
[[ "$BEAN_APP_VARIANT" == release || "$BEAN_APP_VARIANT" == probe ]] || { echo "Release build variant must be release or probe." >&2; exit 1; }
export NODE_ENV=production
build_tools="$ANDROID_HOME/build-tools/37.0.0"
[[ -x "$build_tools/apksigner" && -x "$build_tools/aapt" ]] || { echo "Android build tools 37.0.0 are required." >&2; exit 1; }
output="${BEAN_ANDROID_OUTPUT:-$root/.local/android-release}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
cd "$root/apps/mobile"
npx expo prebuild --platform android --clean --no-install
(
  cd android
  ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon
)
apk="$root/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
"$build_tools/apksigner" verify --verbose --print-certs "$apk" > "$output/signature.txt"
"$build_tools/zipalign" -c -P 16 4 "$apk"
expected="$(printf '%s' "$BEAN_ANDROID_SIGNING_CERT_SHA256" | tr -d ':[:space:]' | tr '[:upper:]' '[:lower:]')"
actual="$(sed -n 's/^.*certificate SHA-256 digest: //p' "$output/signature.txt" | sort -u)"
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] || { echo "Release signing certificate does not match the expected SHA-256." >&2; exit 1; }
unzip -Z1 "$apk" | grep -Fx 'assets/index.android.bundle' > /dev/null || { echo "Embedded JavaScript bundle is missing." >&2; exit 1; }
"$build_tools/aapt" dump badging "$apk" > "$output/apk-info.txt"
package=app.beanbudget
[[ "$BEAN_APP_VARIANT" == probe ]] && package=app.beanbudget.probe
version="$(node -p 'JSON.parse(require("fs").readFileSync("app.json", "utf8")).expo.version')"
version_code="$(node -p 'JSON.parse(require("fs").readFileSync("app.json", "utf8")).expo.android.versionCode')"
grep -F "package: name='$package' versionCode='$version_code' versionName='$version'" "$output/apk-info.txt" > /dev/null || { echo "APK identity or version does not match app.json." >&2; exit 1; }
if grep -q application-debuggable "$output/apk-info.txt"; then
  echo "Refusing a debuggable release APK." >&2
  exit 1
fi
name="bean-budget-$version-arm64-v8a.apk"
[[ "$BEAN_APP_VARIANT" == probe ]] && name="bean-budget-probe-$version-arm64-v8a.apk"
cp "$apk" "$output/$name"
(
  cd "$output"
  node - "$name" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const name = process.argv[2];
writeFileSync("SHA256SUMS", `${createHash("sha256").update(readFileSync(name)).digest("hex")}  ${name}\n`);
NODE
)
git -C "$root" rev-parse HEAD > "$output/source-commit.txt"
git -C "$root" status --porcelain > "$output/source-worktree-status.txt"
echo "Verified $output/$name. Nothing was installed or published."
