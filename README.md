# Bean Budget

A personal budgeting app with a mobile app, a web app, Android spending widgets, and automatic transaction imports from bank notification emails.

Inspired by Actual Budget, Bean Budget brings the ideas behind Spend Bean and Mail Bean into one system. The planned stack uses React Native and Expo for mobile, React for web, and Effect for application logic, with shared budgeting rules and data contracts.

The initial JPY ledger server is implemented; mobile, web, widgets, and mail imports remain planned.

Run `npm ci`, set `BEAN_TOKEN`, then run `npm run server`. See [server setup and API examples](docs/SERVER.md).

- [System architecture](docs/ARCHITECTURE.md)
- [Preliminary research](docs/RESEARCH.md)
- [TypeScript and Effect checks](docs/LINTING.md)
- [Android environment and emulator workflow](docs/ANDROID_DEVELOPMENT.md)
