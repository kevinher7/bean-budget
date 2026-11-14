# Bean Budget system architecture

Decision date: 5 November 2026.

Bean Budget will use one monorepo with separate mobile, web, and backend applications. The clients share budgeting rules and network contracts while providing interfaces suited to their platforms. Mobile supports offline reads and edits; the initial web application requires connectivity for reads and writes, with an in-memory query cache. The backend coordinates accepted changes. Mail ingestion remains planned.

The [preliminary research](RESEARCH.md) records the Actual Budget exploration and alternatives considered. This document captures the subsequent architecture decisions and takes precedence where the proposals differ. The [initial ledger server and shared packages](SERVER.md) are implemented as of 7 November 2026. Mobile now implements the offline register, durable foreground snapshot synchronization, explicit transaction conflict recovery and verified local backup/restore. The server implements the ledger and tracking-budget foundation, including schedules, transfers and period summaries. Android widgets read the committed mobile register locally. Web, mail ingestion and incremental change feeds remain planned; the sections below describe the intended whole system.

## Project structure

```text
bean-budget/
  apps/
    mobile/
      src/
        app/                   Expo Router routes
        features/
          transactions/
          budget/
          settings/
        widgets/               Android widget rendering and handlers
        storage/               SQLite, migrations, local queries
        sync/                  Outbox, incoming changes, reconciliation
        ui/                    Components, theme, typography
        runtime.ts             Effect services and Layers

    web/
      src/
        features/
          transactions/
          budget/
          settings/
        api/                   HTTP access and query cache integration
        ui/                    Web components and theme
        runtime.ts             Effect services and Layers

    server/
      src/
        http/                  Routes, authentication, request decoding
        budget/                Commands, queries, persistence
        mail/                  Gmail, parsers, import orchestration
        sync/                  Operation receipts and change feed
        storage/               Database and migrations
        runtime.ts             Effect services and Layers

  packages/
    budget/
      src/
        money.ts
        dates.ts
        transactions.ts
        allocations.ts
        spending.ts
        schemas.ts

    protocol/
      src/
        commands.ts
        responses.ts
        sync.ts

  docs/
    RESEARCH.md
    ARCHITECTURE.md
```

These directories describe ownership boundaries. Create modules as their behavior is implemented rather than scaffolding empty files or introducing an abstraction for every entity.

## Separate mobile and web interfaces

Mobile uses React Native and Expo, following Spend Bean's separation between React-free core logic, app screens, and widget rendering. Its primary interactions are quick transaction entry, spending awareness, and home screen widgets.

Web uses React with its own interface. It can prioritize desktop budgeting tasks such as a dense transaction register, keyboard navigation, bulk editing, and monthly planning. A separate web application avoids requiring these interactions to fit the mobile component model.

Each application initially owns its design system implementation. Mobile screens and widgets share semantic design tokens and presentation data, while using separate renderers. Shared UI packages or workflow packages should be extracted only when actual reuse warrants them. The web framework and component libraries remain undecided.

## Shared budgeting domain and protocol

`packages/budget` owns financial concepts, schemas, validation, and pure calculations. It must not depend on React, React Native, browser APIs, Node APIs, or a database driver. Calculations accept their inputs explicitly, including financial dates and any relevant clock-derived values.

`packages/protocol` owns network commands, responses, synchronization records, and their Effect Schema definitions. It may depend on `budget`. Neither shared package depends on an application; `budget` does not depend on `protocol`.

The applications supply platform-specific persistence and runtime implementations. Sharing domain types does not require identical client and server database schemas. Local pending operations and sync metadata belong to mobile storage; operation receipts and the authoritative change feed belong to server storage.

Money uses bounded integers with an explicit currency scale (JPY whole yen, USD cents). Financial dates remain distinct from timestamps. Migration must explicitly convert Actual's hundredths-based amounts, including JPY amounts, and preserve the intended Asia/Tokyo calendar behavior. The tracking-budget rules below define the agreed foundation; the migration format remains to be specified.

## Effect as the application orchestration layer

Use Effect for database access, HTTP, imports, synchronization, typed failures, retries, resource management, and cancellation. Keep budget arithmetic as ordinary functions where effects are unnecessary.

Each application assembles its services and Layers at its runtime boundary. Services should represent meaningful dependencies such as a database, remote API, or Gmail access. Avoid creating a service and repository abstraction for every entity or executing effects throughout the domain with scattered `runPromise` calls.

The shared budgeting rules must be usable by both the mobile provisional write path and server command validation. Storage transactions and network orchestration remain platform-specific. Existing Mail Bean promise-based adapters can be wrapped at the Effect boundary before considering a rewrite.

## Data ownership and client behavior

The backend owns accepted synchronized state. All client writes and mail imports pass through server command validation. The mobile database contains a local replica plus pending changes, rather than only a disposable response cache.

### Mobile

Screens and widgets read local SQLite. An offline mutation saves its local effect and a durable outbox operation atomically, then refreshes the visible state and widget summary. The operation remains identifiable as pending until the server accepts it.

Synchronization sends pending operations, receives accepted changes, and reconciles local data. Incoming accepted records must not silently erase pending user edits. Rejected or conflicting operations retain enough information for an explicit recovery path. The current register stores accepted transaction snapshots separately from local records and ordered outbox operations. Full register snapshots preserve queued local edits and reconcile stable operation receipts before replacing provisional transaction IDs. See [mobile register](MOBILE.md).

### Web

The initial web application reads and writes through the backend API. It uses an in-memory query cache and may update the interface optimistically while a request is pending. Failed writes must be surfaced and optimistic state reconciled. There is no initial promise of offline browser reads, durable queued edits, or recovery of unsent edits after closing the page.

Browser persistence and offline synchronization can be added later. Mobile's offline capability does not imply that the web application already has a local replica.

### Changes from other sources

Mail imports and edits on another client must become visible to connected clients. Web can invalidate or refresh relevant queries when notified of a change. Mobile pulls accepted changes during synchronization. Notifications are hints; the durable change feed provides recovery for missed updates. The notification transport remains undecided.

## Commands and synchronization

Start with explicit domain commands such as `CreateTransaction`, `EditTransaction`, and `CreateTransfer`. Each submitted operation has a stable ID for safe retries. Edits include the record revision they were based on so the server can detect stale changes.

The backend commits operation receipts and financial mutations in one database transaction. A future incremental sync implementation must include ordered change-feed entries in that transaction. Repeating an accepted operation must not repeat its financial effect. Transfers, split edits, and other multi-record financial changes remain atomic domain operations.

Clients pull changes after a cursor. Applying an incoming batch and advancing that cursor must be atomic locally. Deletions require tombstones or an equivalent explicit deletion representation. The implemented first mobile slice uses complete register snapshots and has no deletions. Change retention, expired cursors, resnapshot behavior and protocol versioning need a concrete design before adding incremental synchronization.

A stale edit produces an explicit conflict rather than silently overwriting a financial change using device timestamps. The mobile register supports explicit "Keep local edit" and "Use server" recovery for transaction metadata and posting conflicts. Planning replacements still need a conflict policy before offline planning edits. This architecture does not promise automatic merging of concurrent offline edits.

The change feed supports replication of current state. It does not commit the project to event sourcing or CRDTs. Ongoing two-way compatibility with Actual's sync protocol is outside the initial design; Actual is a behavioral reference and migration source.

## Backend and mail ingestion

Deploy one backend process containing the authenticated API and a scheduled mail ingestion job. Start with a server SQLite database on persistent storage. PostgreSQL or a separate worker can be considered if deployment or concurrency requirements change.

Mail ingestion reuses the Gmail retrieval and issuer parsing knowledge from Mail Bean. It submits transactions through the same command path as client writes, including validation, transfer handling, and duplicate protection.

Persist import identities with their financial effects in a transaction. Advance import checkpoints only after successful processing, make interrupted runs safe to repeat, and prevent overlapping runs. Job progress and failures must survive process restarts. An in-process schedule alone does not provide those guarantees.

Import idempotency and matching a mail purchase to a manually entered purchase are separate concerns. The former prevents repeated source processing; the latter requires an explicit reconciliation policy. The existing source-account-plus-approval-number identifiers need review for possible reuse over time.

## Widgets

Android widgets render the latest committed local summary immediately, with an update time or freshness indication. App mutations and successful synchronization refresh that summary and request a widget redraw. Rendering must not wait for a network round trip.

Android widget providers open the existing SQLite database read-only and query a single committed snapshot. They never initialize or migrate the database, start JavaScript or perform network work. The app requests a redraw after reading the register following a mutation, sync or restore. Validate real-device cold starts and overlapping writes on the Pixel after emulator verification. Backend imports become visible after the device receives and applies changes; immediate background delivery is not guaranteed while the operating system suspends the app.

## Trust and operations

The initial model assumes a personal, self-hosted backend that may read budget data. Gmail credentials stay on the backend; mobile credentials use platform-appropriate secure storage. Authentication and transport security must be specified before exposing the API.

Server-unreadable ledger encryption would require revisiting backend validation and mail ingestion. It is not part of the initial architecture.

Backups, restore verification, export, migrations, and import status are part of operating the system. The backend database must live on durable storage, and the recovery design must distinguish accepted server data from mobile edits that have not synchronized yet.

## Initial implementation slice

Prove the architecture with one complete flow:

1. Enter a transaction offline on mobile and persist it across an app restart.
2. Update the widget from local data.
3. Synchronize the transaction safely, including a retry after an interrupted acknowledgement.
4. Display the accepted transaction in the web app.
5. Ingest the same email twice without creating duplicate transactions and propagate the accepted result to both clients.

Before using Bean Budget as the primary ledger, compare representative Actual balances and monthly budgets, exercise conflicts and atomic transfers, and verify backup restoration.

## Decisions still open

- Web framework, routing, component libraries, and concrete design tokens.
- Authentication, device registration, and deployment configuration.
- Actual migration requirements and remaining forecast/reconciliation policies.
- Database schemas and transaction ownership in each runtime.
- Sync batch format, conflict recovery, retention, and resnapshot behavior.
- Notification transport and mail scheduling cadence.
- Matching imported purchases with manually entered transactions.

Resolve these as their implementation slices require them. Preserve the agreed boundaries without adding speculative infrastructure.

## Agreed ledger and tracking-budget foundation

Decision date: 8 November 2026. These rules describe the next implementation, not capabilities already present in the initial ledger server.

### Ledger ownership

One server stores one owner's data. Accounts have a name and currency, with no required account type. Balances derive from transactions, including explicit opening entries; negative account balances are valid. Transactions do not belong to a budget. Multiple independent budgets may evaluate the same ledger without copying it.

Support JPY and USD using bounded integer minor units: input ¥1234 stores 1234 JPY, while $12.34 stores 1234 USD cents. Parse decimal input text into integer units and format at the UI boundary. Account currency determines transaction currency. Never sum different currencies into an unqualified total. Cross-currency transfers record both actual amounts; automatic FX conversion is outside the initial scope.

Transactions carry an account, financial date, signed amount, optional payee/category, pending or posted status, source (initially manual or mail-bean), and optional notes. Income is positive and expenses negative. Transfers link outgoing and incoming entries and commit atomically. Opening entries and transfers do not count as ordinary budget income or spending. Posted balances exclude pending entries; projected balances include them. Pending discretionary purchases consume category availability immediately. Posting them must not consume it again. Posting is distinct from future bank reconciliation.

Payees and categories are core concepts. Uncategorized transactions are valid and must remain visible for review. Mail-specific merchant parsing, normalization, account matching, and import orchestration belong to the mail module. Preserve structured import identities separately from source labels and notes, committing duplicate protection with financial changes. Payee-to-category defaults and their editing UI can follow later; historical categorization changes require an explicit user action.

### Budget periods and allocations

A budget defines its name, currency, included accounts, and monthly start day. Its accounts use its currency; conversion between currencies is not implicit. Categories are shared ledger classifications, while category allocations are specific to a budget and period and may change during that period.

A period has explicit financial-date boundaries, an inclusive start and exclusive next start. Day 1 means a calendar month. Day 25 means the 25th through the 24th of the next month. Clamp start days 29–31 independently to each month's last valid day, deriving the end from the following start. Calculations accept explicit dates rather than reading the clock.

This is tracking budgeting over expected income, not cash-constrained envelope budgeting. Expected scheduled income minus scheduled commitments establishes fresh discretionary funds. Allow period-specific income forecasts and occurrence amount overrides for variable salary and estimated bills. Forecasts are not money received and should be presented distinctly from posted totals.

For each period:

```text
assignable = expected income - committed expenses
           + previous unassigned funds - previous category overspending
unassigned = assignable - current period category allocations
category remaining = positive previous category remainder
                   + current allocation - net discretionary spending
```

Refunds reduce net spending. Positive category remainders stay assigned to the same category in the next period. Negative category remainders reset to zero and reduce the next period's assignable funds by their absolute value. Signed unassigned funds carry separately. Never add retained positive category funds to the unassigned pool as well.

Example: ¥200,000 expected income and ¥80,000 commitments yield ¥120,000 fresh assignable funds. Allocating ¥40,000 to food, ¥20,000 to entertainment, and ¥30,000 to shopping leaves ¥30,000 unassigned. Food spending of ¥43,000 leaves −¥3,000; entertainment spending of ¥15,000 leaves ¥5,000. Next period, food carries zero, entertainment carries ¥5,000, and assignable funds receive a −¥3,000 overspending adjustment plus the previous unassigned remainder.

Derive carryover in period order rather than creating financial transactions or relying on a midnight rollover job. Historical edits recalculate affected subsequent periods. Persisted summaries, if introduced later, are rebuildable projections.

### Schedules and commitment fulfillment

Schedules are separate recurring templates for income or expenses. A scheduled occurrence records one expected payment, its financial date, account, amount, payee/category, and optional link to its actual transaction. Occurrences preserve period expectations: editing a schedule must not silently rewrite past occurrences. Generation uses a stable schedule-and-occurrence identity to prevent duplicate entries on retries. Monthly recurrence uses the same explicit short-month policy.

An occurrence may generate a pending transaction. Mail or manual confirmation can fulfill that occurrence rather than create another purchase. Automatic matching requires an explicit reconciliation policy; do not infer that import deduplication solves matching.

Within each budget, a transaction fulfilling a reserved scheduled commitment must not also consume a discretionary allocation. It can still retain a category for reporting. Commitment selection belongs to the budget, allowing independent plans over the same ledger. A posted bill replaces its estimate for that occurrence: an estimated ¥8,000 bill posting at ¥9,000 reduces assignable funds by a further ¥1,000, not ¥9,000. Exact treatment of partial payments, unmatched occurrences, and income forecast deviations remains to be specified before implementing those cases.

### Implementation ownership and order

Keep pure money, date, ledger, and budget rules in packages/budget; network commands and responses in packages/protocol; database migrations, persistence, and orchestration in apps/server. Retain compact modules and meaningful dependency boundaries rather than per-entity services.

Implement the ledger extensions first, then schedules and occurrence matching, then budget persistence/calculations and period-summary commands. Mail integration, client UI, full synchronization, and Actual migration remain separate work. Add immutable migrations instead of changing applied migrations. Preserve existing transaction retry protection and extend atomicity and validation to new financial commands.

### Relational storage and resource API

Categories, payees, schedules, scheduled occurrences, budgets, budget account membership, reserved schedules, budget periods, and category allocations use explicit relational tables. Foreign keys enforce references; schedule/month and budget/month/category keys enforce identity. Transactions reference categories and payees. Budget periods are identified by budget/month, without constructed plan IDs.

The server exposes resource routes for these concepts rather than a combined planning-data endpoint or generic command endpoint. Read queries gather the selected budget's inputs; schedules.ts and budgets.ts own their cohesive read queries while ledger.ts coordinates atomic mutations and receipts. See SERVER.md for the route contract. Migration 3 preserves existing JSON records and receipts, verifies their relationships, and removes the former catch-all table atomically. Applied migrations 1 and 2 remain unchanged.
