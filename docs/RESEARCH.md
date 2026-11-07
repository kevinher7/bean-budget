# Bean Budget feasibility research

Research date: 4 November 2026.

Bean Budget is feasible as a focused personal budgeting app: Android first, Expo and React Native, Effect for application services, home screen widgets, and mail ingestion in the backend. Replacing every Actual feature is a substantially larger undertaking. The strongest reason to build it is control over the product and data model; the current widget latency alone does not justify a replacement.

My recommendation is a small independent app, with a local SQLite database and a self hosted backend, using Actual as a behavioral reference and migration source. Before committing, prove the offline write and sync path, budget arithmetic, and headless widget access. Keep an Actual backed implementation as the lower risk alternative if continued compatibility matters more than independence.

## Checkouts and scope

Actual is cloned at `/Users/beellm/Projects/clones/actual`, at commit `a3a1c7fc41f891dc91936a488ef08f695c982580` (3 November 2026). It is a shallow, blob filtered clone with a sparse checkout of `loot-core`, `crdt`, `sync-server`, `api`, and `mobile-client`, plus root files. Other files remain accessible through Git; expand the sparse checkout when needed. No dependencies were installed or builds run.

Local inputs were `../spend-bean` and `../mail-bean`, including their repository instructions, dependencies, core programs, adapters, widget handlers, and app screens. This is source inspection and preliminary architecture research, not a measured performance study or a working prototype.

## What the existing Bean projects provide

Spend Bean already establishes the desired boundaries: core logic has no React dependency, screens and widgets consume core, and adapters remain independent. It uses Expo `~58.0.16`, React Native `0.88.0`, React `19.3.0`, Effect `^4.0.5`, Expo Router, SecureStore, AsyncStorage, and `react-native-android-widget`. These are the inspected repository declarations, not a proposed upgrade matrix.

Its design system currently consists of shared Material 3 style semantic color roles and paper, night, and bean palettes in `src/core/theme.ts`. Screens use React Native controls and StyleSheet directly; there is no installed component design system. Preserve the tokens and add a small reusable component layer. React Native Paper is a plausible candidate because it supplies Material components and theming; verify its selected release against Expo 58 and React 19 before adopting it. Widgets still require their own renderer, sharing tokens and view data rather than screen components. [Paper documentation](https://oss.callstack.com/react-native-paper/)

The spending calculation is particularly reusable: explicit dates, Tokyo calendar semantics, Monday to Sunday weeks, refunds reducing spending, and transfer/income exclusions. Preserve these as product rules. The current new transaction route only redirects to settings, so transaction entry still needs implementing.

Mail Bean provides Gmail retrieval, MIME parsing, issuer specific SMBC/Yucho extraction, account/category/transfer mappings, duplicate identifiers, and run summaries. These can become a backend job. Its program currently uses promises and Zod rather than Effect; wrap working adapters at the service boundary before considering a rewrite.

Its duplicate key is currently source account plus approval number. Before migration, check whether those approval numbers can repeat over time. Preserve existing identifiers for import continuity, and design a stronger source identity if required. Avoid treating matching date and amount alone as sufficient evidence that two transactions are the same.

## Actual architecture and reuse boundaries

Actual is local first. Its web UI communicates with an in-browser background database process; desktop uses a Node child process. Much of the application engine lives in `packages/loot-core`. The remote sync server is not a conventional budget CRUD backend. The official API operates its own local budget copy and exposes the engine programmatically. [Architecture](https://actualbudget.org/docs/contributing/project-details/architecture/) · [API model](https://actualbudget.org/docs/api/)

Useful source entry points in the cloned revision:

- `packages/loot-core/src/server/budget/envelope.ts` and `base.ts`: envelope balances, overspending, carryover, income buffering, and month dependencies. Calculations depend on the spreadsheet engine and database; this is not a standalone budgeting function package.
- `packages/loot-core/src/server/transactions/`: transaction behavior to inspect when defining splits, transfers, reconciliation, and import matching.
- `packages/loot-core/src/server/sync/`: message application, schema compatibility, mutation coordination, and derived budget invalidation.
- `packages/crdt/src/`: clocks, Merkle trees, and protocol primitives. These do not by themselves provide a complete sync implementation.
- `packages/loot-core/src/platform/server/`: filesystem, SQLite, connection, and storage implementations.
- `packages/loot-core/src/server/encryption/`: encrypted payloads and key handling.
- `packages/api/`: headless engine integration, including Node and browser entry points.
- `packages/sync-server/`: self hosting, auth, synchronization, and bank connection endpoints.
- `packages/mobile-client/`: Capacitor shell for the web client, not React Native screens.

The browser SQLite implementation uses SQL.js/WASM with filesystem and IndexedDB integration. The Node API resolves to the Electron SQLite implementation using better-sqlite3. Neither is an Expo native SQLite adapter. Conditional package imports cover browser, API, and Electron; there is no existing React Native branch. A native port must address SQLite semantics and custom functions, filesystem, execution isolation, communication, crypto, and build resolution. Importing the published API into Metro is not an established shortcut.

The repository root carries an MIT license, while the inspected core package manifest declares ISC. Preserve applicable notices for copied code and check the licenses of the specific files and dependencies selected. This preliminary review does not resolve that metadata discrepancy. [Root license](https://github.com/actualbudget/actual/blob/a3a1c7fc41f891dc91936a488ef08f695c982580/LICENSE.txt) · [Core manifest](https://github.com/actualbudget/actual/blob/a3a1c7fc41f891dc91936a488ef08f695c982580/packages/loot-core/package.json)

## Three viable approaches

**Keep Actual and improve the integration.** Put a Bean backend in front of a persistent headless Actual client, integrate Mail Bean there, and expose a single summary endpoint. The Expo app uses a cached summary immediately. This retains Actual budgeting behavior and migration safety with the least work. It still leaves Bean dependent on Actual and its synchronization model. Reads and mutations need deliberate serialization around the headless client rather than arbitrary concurrent API calls.

**Build a native Actual compatible client.** Reuse or port the engine and speak the existing sync protocol. This keeps the Actual web app usable alongside Bean, but commits the project to schema, mutation, encryption, and protocol compatibility. A new UI does not remove this maintenance burden. Choose this only if two way Actual compatibility is a firm requirement.

**Build an independent Bean engine.** Use a small domain model, a dedicated backend API, and a local native database. Import Actual data once and expand behavior deliberately. This best fits the goal of owning the entire experience, provided the initial scope is narrower than Actual. Reimplementing reports, arbitrary rules, schedules, goals, bank providers, multiple budgeting modes, collaborative editing, and plugin support should not be initial requirements.

## Proposed independent app design

Assumptions: one owner, Android first, JPY first, a self hosted backend that may read budget data, offline transaction entry, and eventual support for another client. These are working assumptions to validate before implementation.

Use one repository and initially one backend process. Logical modules can start as directories rather than separately published packages:

- `apps/mobile`: Expo Router screens, React Native components, SQLite adapter, secure credentials, and Android widgets.
- `apps/server`: authenticated HTTP API, durable database, mail job, sync/change log, and backup operations.
- `core`: plain budget calculations and domain types, with no React or Node imports.
- `contracts`: Effect Schema request/response and persisted record definitions shared by both runtimes.

Keep Effect central to orchestration: services for storage, remote API, clock, Gmail, and import processing; Layers for platform implementations; typed failures; scoped resources; bounded concurrency; retries and tracing. Keep arithmetic as plain functions. Run effects at application boundaries rather than scattering `runPromise` throughout the domain. Import platform HTTP modules through their specific paths, following Spend Bean's Metro size constraint. [Effect v4 documentation](https://effect.website/docs/v4/onboarding)

On mobile, read the ledger and calculate summaries locally. Persist each user mutation and an outbox entry atomically. A sync worker submits stable operation IDs; the server deduplicates operations, commits a domain change and a monotonically ordered change record together, then returns changes after the client's cursor. Apply incoming changes and advance the cursor in one local transaction. Use explicit record revisions and a visible conflict path for stale edits. A transfer, split edit, or reconciliation action must remain one domain operation across retries.

This is a proposed simpler alternative to Actual's CRDT, not an already validated synchronization algorithm. Deleted records need tombstones, operation retention needs a policy, and expired cursors need a full resnapshot path. Simultaneous offline edits can initially require conflict resolution; do not silently overwrite financial edits based on device clocks. Avoid supporting concurrent edits to the same records until that behavior is defined.

Expo SQLite provides persistent native storage and transaction APIs. Prefer asynchronous operations for substantial work. Its ordinary async transaction scope can include unrelated queries; use controlled write ownership and the appropriate exclusive transaction API on native. Exclusive async transactions are not supported on web, so a desktop/web client needs its own storage strategy and validation. [Expo 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/)

Store monetary values as bounded integers with an explicit currency scale. Actual uses hundredths even for JPY; Mail Bean currently multiplies yen by 100 on import and Spend Bean divides by 100. Define this conversion once. Keep financial dates separate from timestamps and retain Asia/Tokyo calendar rules. Start with accounts, payees, categories, transactions, monthly allocations, linked transfers, and import identities. Support splits before migrating any source budget that contains them.

Widgets should render a last committed local summary immediately, with an updated time. App writes and successful sync trigger summary refresh and widget redraw. Refresh over the network separately; do not require a network round trip to display a widget. Validate database access and update races in headless widget execution on a real device. Backend mail delivery cannot guarantee an immediate widget change while Android suspends the app. Background execution remains OS scheduled, with a minimum Android periodic interval of 15 minutes for Expo BackgroundTask. [Background execution limits](https://docs.expo.dev/versions/latest/sdk/background-task/)

Run mail ingestion as a scheduled job within the backend deployment. Fetch and parse using the existing adapters, then submit the same transaction commands used by app writes. Commit import identity and financial changes together; persist progress only after a successful commit. A failed run must be safe to repeat. Persist failure/run status for the app and keep OAuth credentials on the server. An Effect Schedule is not durable job state across process restarts; persist checkpoints and prevent overlapping runs.

Server side ingestion makes the backend a trusted processor of imported transaction details. If the requirement becomes that the server cannot read the ledger, this design needs revisiting: an encrypted staging inbox and client side import is one alternative. Retaining Actual E2EE likewise requires an importing headless client to hold decryption credentials.

## What the latency evidence actually says

Spend Bean's `refresh` first fetches accounts, then concurrently fetches one or two budget months and transactions for every on budget account. That is `1 + M + A` HTTP requests per refresh, where `M` is one or two and `A` is the account count. Its five second timeout wraps the whole fetch group, and two retries with exponential delay can extend a failed refresh to roughly sixteen seconds before fallback. The widget handler awaits that refresh before rendering; its stored summary is primarily a failure fallback.

These are code observations, not proof of the reported latency's cause. Instrument cold widget startup, bridge request time, Actual download/sync, budget calculation, and native rendering separately. A cache first render and one summary endpoint are useful baseline experiments. They could make Spend Bean satisfactory without a new ledger.

## Scope and feasibility gates

First define the actual replacement target from the live budget: account types, categories, envelope versus tracking mode, splits, schedules, rollover behavior, reconciliation, history size, and desktop editing needs. Use a local export with permission for sensitive data; this research did not open the live budget or access Gmail.

1. **Local ledger and widget slice.** On a real Android device, create a transaction offline, restart the app, and show the updated daily/weekly widget from persisted data. Exercise simultaneous app and widget access. Suggested targets, not measured results: a warm local widget redraw below 200 ms and an ordinary local transaction save below 100 ms; measure cold startup separately.
2. **Budget arithmetic slice.** Import a small representative Actual export and compare account balances and several months of allocations, available balances, refunds, overspending, and rollover. Include Tokyo month boundaries. Choose intentionally whether to match Actual semantics or document differences.
3. **Mail and sync slice.** Repeat an import, interrupt after commit but before acknowledgement, edit offline while mail arrives, and reconnect. Verify no duplicate transactions, lost edits, half transfers, or prematurely advanced cursors. Verify backup restoration, not just backup creation.
4. **Personal MVP.** Account register, add/edit transaction, categories and monthly allocations, spending widgets, mail status, one time migration, export, and backup/restore. Add only the advanced behaviors the current budget requires.

A focused vertical slice is plausibly days to a few weeks; a trustworthy personal replacement is more likely several months of part time work. Full Actual parity is an open ended maintenance project. These are rough planning judgments, not estimates derived from an implementation. Sync conflicts and migration fidelity are the largest uncertainties; Expo and Effect are not the main feasibility risks.

## Decision

Proceed with an independent Bean prototype if ownership of budgeting behavior is the goal and a narrow initial feature set is acceptable. Keep the Actual export/import boundary, rather than promising ongoing two way compatibility. Retain the existing Bean projects until balance comparisons, import replay, offline behavior, and restore checks are satisfactory.

If the goal is chiefly a better phone experience and faster widgets, start with the consolidated Actual backed backend instead. It can still embed mail ingestion and remove the separate HTTP bridge from the phone's request path, while preserving the mature budget engine.
