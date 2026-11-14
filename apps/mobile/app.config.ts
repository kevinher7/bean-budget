import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import type { ConfigContext, ExpoConfig } from "expo/config";
import {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
} from "expo/config-plugins";

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant: unknown = env["BEAN_APP_VARIANT"] ?? "development";
  if (variant !== "development" && variant !== "release" && variant !== "probe") {
    throw new Error("BEAN_APP_VARIANT must be development, release, or probe.");
  }
  const development = variant === "development";
  const probe = variant === "probe";
  let nativeConfig: ExpoConfig = {
    ...config,
    name: development ? "Bean Budget Dev" : probe ? "Bean Budget Probe" : "Bean Budget",
    slug: "bean-budget",
    scheme: development ? "bean-budget-dev" : probe ? "bean-budget-probe" : "bean-budget",
    android: {
      ...config.android,
      package: development
        ? "app.beanbudget.dev"
        : probe
          ? "app.beanbudget.probe"
          : "app.beanbudget",
      allowBackup: false,
      ...(!development
        ? {
            blockedPermissions: [
              "android.permission.SYSTEM_ALERT_WINDOW",
              "android.permission.READ_EXTERNAL_STORAGE",
              "android.permission.WRITE_EXTERNAL_STORAGE",
            ],
          }
        : {}),
    },
    plugins: [
      ...(development ? ["expo-dev-client"] : []),
      "expo-sqlite",
      ["expo-secure-store", { configureAndroidBackup: false }],
    ],
  };
  nativeConfig = withAndroidManifest(nativeConfig, (mod) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    application.$["android:allowBackup"] = "false";
    application.$["android:fullBackupContent"] = "@xml/bean_backup_rules";
    application.$["android:dataExtractionRules"] = "@xml/bean_data_extraction_rules";
    application.$["android:usesCleartextTraffic"] = variant === "release" ? "false" : "true";
    return mod;
  });
  nativeConfig = withDangerousMod(nativeConfig, [
    "android",
    (mod) => {
      const directory = join(mod.modRequest.platformProjectRoot, "app/src/main/res/xml");
      mkdirSync(directory, { recursive: true });
      const exclusions = ["root", "file", "database", "sharedpref", "external"]
        .map((domain) => `<exclude domain="${domain}" path="."/>`)
        .join("");
      writeFileSync(
        join(directory, "bean_backup_rules.xml"),
        `<?xml version="1.0" encoding="utf-8"?><full-backup-content>${exclusions}</full-backup-content>`,
      );
      writeFileSync(
        join(directory, "bean_data_extraction_rules.xml"),
        `<?xml version="1.0" encoding="utf-8"?><data-extraction-rules><cloud-backup>${exclusions}</cloud-backup><device-transfer>${exclusions}</device-transfer></data-extraction-rules>`,
      );
      return mod;
    },
  ]);
  if (development) return nativeConfig;
  return withAppBuildGradle(nativeConfig, (mod) => {
    const signing = "    signingConfigs {";
    const releaseSigning = `    signingConfigs {
        release {
            def keyPath = System.getenv('BEAN_ANDROID_KEYSTORE')
            if (keyPath) storeFile file(keyPath)
            storePassword System.getenv('BEAN_ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('BEAN_ANDROID_KEY_ALIAS')
            keyPassword System.getenv('BEAN_ANDROID_KEY_PASSWORD')
        }`;
    if (mod.modResults.contents.includes(releaseSigning)) return mod;
    const release = /release \{([\s\S]*?)signingConfig signingConfigs\.debug/;
    if (!mod.modResults.contents.includes(signing) || !release.test(mod.modResults.contents)) {
      throw new Error("Expo Android signing template changed; refusing a debug-signed release.");
    }
    mod.modResults.contents = mod.modResults.contents
      .replace(release, "release {$1signingConfig signingConfigs.release")
      .replace(signing, releaseSigning);
    return mod;
  });
};
