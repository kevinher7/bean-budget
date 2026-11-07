# Bean Budget

## Local development

On this Mac, Nix, direnv, and the Android SDK are already installed. In the repository root:

```sh
direnv allow       # Once; tools load automatically when entering this directory
npm ci            # Initially, and after dependency lockfile changes
npm run dev:server
```

`dev:server` restarts on edits, listens on `http://127.0.0.1:3000`, and keeps its development database in `.local/bean-budget.sqlite`. It creates a private, persistent development token in `.local/server-token` unless `BEAN_TOKEN` is already set. Both files are ignored by Git. Keep the token private; `BEAN_DATABASE`, `BEAN_HOST`, and `BEAN_PORT` can override the defaults. `npm run server` remains the plain server command and requires an explicit `BEAN_TOKEN`.

To run the server in Docker instead (Docker Desktop must be running):

```sh
npm run up       # Build, start in the background, and wait until healthy
curl http://127.0.0.1:3000/health
npm run logs     # Follow server logs; Ctrl-C only stops following
npm run down     # Stop containers; keep the database
```

Compose uses the same private development token and a separate persistent Docker volume for SQLite. Stop the native server first, or use `BEAN_PORT=3001 npm run up` to publish a different port. Run `npm run up` again after source changes to rebuild. Only the server is containerized; Android and Metro run on the Mac. See [container details](docs/SERVER.md#docker-compose) for credentials, persistence, and direct Compose usage.

For Android, in another terminal in this directory:

```sh
npm run android:doctor    # Check tools, acceleration, image, and device inventory
npm run android:setup     # Once: create bean-budget using the installed ARM64 image
npm run android:emulator  # Open Android; leave this terminal running
# In another terminal, once Android has booted:
npm run android:build     # First native build/install, or after native changes
npm run android:dev       # Later sessions: Metro and JavaScript reload only
```

The existing `spend-bean` device and its data are preserved. `BEAN_AVD` overrides the device name; `BEAN_ANDROID_IMAGE` overrides the setup image. SDK downloads are never automatic. The emulator does not start the backend or build an app.

Without direnv, run `nix develop path:./nix` first. On a new host, install Nix and direnv and enable the direnv shell hook; override `ANDROID_HOME` / `ANDROID_AVD_HOME` before entering the environment if your SDK paths differ. The pinned flake supplies Node 22 and JDK 17; the Android SDK stays outside Nix. First activation may download Nix tools.

The Android app supports offline JPY transaction entry, a local ledger, and durable pending operations. It does not synchronize yet; the development build needs Metro running. See the Android guide for manual persistence checks. Web and widgets remain planned; browser validation will use manual spot checks and widget validation will use the Android launcher. Run `npm run check` for the existing format, type, boundary, and lint checks.

## Project

A personal budgeting app with a mobile app, a web app, Android spending widgets, and automatic transaction imports from bank notification emails.

Inspired by Actual Budget, Bean Budget brings the ideas behind Spend Bean and Mail Bean into one system. The planned stack uses React Native and Expo for mobile, React for web, and Effect for application logic, with shared budgeting rules and data contracts.

The initial JPY ledger server and offline Android slice are implemented; synchronization, web, widgets, and mail imports remain planned.

Run `npm ci`, set `BEAN_TOKEN`, then run `npm run server`. See [server setup and API examples](docs/SERVER.md).

- [System architecture](docs/ARCHITECTURE.md)
- [Preliminary research](docs/RESEARCH.md)
- [TypeScript and Effect checks](docs/LINTING.md)
- [Android environment and emulator workflow](docs/ANDROID_DEVELOPMENT.md)
