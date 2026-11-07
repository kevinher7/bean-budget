# Bean Budget

## Local development

On this Mac, Nix, direnv, and the Android SDK are already installed. In the repository root:

```sh
direnv allow       # Once; tools load automatically when entering this directory
npm ci            # Initially, and after dependency lockfile changes
npm run dev:server
```

`dev:server` restarts on edits, listens on `http://127.0.0.1:3000`, and keeps its development database in `.local/bean-budget.sqlite`. It creates a private, persistent development token in `.local/server-token` unless `BEAN_TOKEN` is already set. Both files are ignored by Git. Keep the token private; `BEAN_DATABASE`, `BEAN_HOST`, and `BEAN_PORT` can override the defaults. `npm run server` remains the plain server command and requires an explicit `BEAN_TOKEN`.

For Android, in another terminal in this directory:

```sh
npm run android:doctor    # Check tools, acceleration, image, and device inventory
npm run android:setup     # Once: create bean-budget using the installed ARM64 image
npm run android:emulator  # Open Android; leave this terminal running
```

The existing `spend-bean` device and its data are preserved. `BEAN_AVD` overrides the device name; `BEAN_ANDROID_IMAGE` overrides the setup image. SDK downloads are never automatic. The emulator does not start the backend or build an app.

Without direnv, run `nix develop path:./nix` first. On a new host, install Nix and direnv and enable the direnv shell hook; override `ANDROID_HOME` / `ANDROID_AVD_HOME` before entering the environment if your SDK paths differ. The pinned flake supplies Node 22 and JDK 17; the Android SDK stays outside Nix. First activation may download Nix tools.

Mobile and web apps are not implemented yet. Their build/reload commands and manual browser spot checks will be added with those apps. Widget validation will use the Android launcher. Run `npm run check` for the existing format, type, boundary, and lint checks.

## Project

A personal budgeting app with a mobile app, a web app, Android spending widgets, and automatic transaction imports from bank notification emails.

Inspired by Actual Budget, Bean Budget brings the ideas behind Spend Bean and Mail Bean into one system. The planned stack uses React Native and Expo for mobile, React for web, and Effect for application logic, with shared budgeting rules and data contracts.

The initial JPY ledger server is implemented; mobile, web, widgets, and mail imports remain planned.

Run `npm ci`, set `BEAN_TOKEN`, then run `npm run server`. See [server setup and API examples](docs/SERVER.md).

- [System architecture](docs/ARCHITECTURE.md)
- [Preliminary research](docs/RESEARCH.md)
- [TypeScript and Effect checks](docs/LINTING.md)
- [Android environment and emulator workflow](docs/ANDROID_DEVELOPMENT.md)
