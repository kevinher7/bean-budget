import { readdirSync } from "node:fs";
import { join } from "node:path";

const mobileRoot = "apps/mobile";
const rootSourceFiles = new Set(["app.config.ts", "index.ts"]);
const rootDirectories = new Set([
  "src",
  "modules",
  "assets",
  "android",
  "ios",
  ".expo",
  "node_modules",
  "build",
  "dist",
]);
let violations = 0;

for (const entry of readdirSync(mobileRoot, { withFileTypes: true }).sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  const path = join(mobileRoot, entry.name);
  if (entry.isDirectory() && !rootDirectories.has(entry.name)) {
    console.error(
      `${path}: [mobile-root-directory] Keep feature folders under apps/mobile/src/. Keep native Expo modules and their config plugins together under apps/mobile/modules/<module>/. Do not add a feature folder at the mobile app root.`,
    );
    violations++;
  } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !rootSourceFiles.has(entry.name)) {
    console.error(
      `${path}: [mobile-root-source] Move application code to apps/mobile/src/, or put an Expo config plugin beside its module, for example apps/mobile/modules/bean-widgets/with-widgets.ts. Update its imports after moving it. Only app.config.ts and index.ts currently belong at this root; add a narrow exception here only when a framework requires an exact root filename.`,
    );
    violations++;
  }
}

if (violations > 0) process.exitCode = 1;
else console.log("Mobile root layout passed");
