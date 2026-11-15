import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDangerousMod, type ConfigPlugin } from "expo/config-plugins";
import { colors } from "./src/ui/theme.ts";

export const withWidgets: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    "android",
    (mod) => {
      const directory = join(mod.modRequest.platformProjectRoot, "app/src/main/res/values");
      mkdirSync(directory, { recursive: true });
      const names = [
        "surface",
        "text",
        "secondary",
        "outline",
        "primary",
        "selected",
        "onPrimary",
        "error",
      ] as const;
      writeFileSync(
        join(directory, "bean_widget_colors.xml"),
        `<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@color/bean_widget_*">${names.map((name) => `<color name="bean_widget_${name === "onPrimary" ? "on_primary" : name}">${colors[name]}</color>`).join("")}</resources>`,
      );
      return mod;
    },
  ]);
