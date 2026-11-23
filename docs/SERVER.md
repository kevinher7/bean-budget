# Initial ledger server

For daily local development, activate direnv (or `nix develop path:./nix`) and run `npm run dev:server`. It creates a persistent private token in `.local/server-token` when `BEAN_TOKEN` is unset and defaults to `.local/bean-budget.sqlite`; both are ignored. Existing environment overrides are respected. The manual `server` workflow below is unchanged.

Use Node 22 (at least 22.22.3) and npm 10. The pinned development shell currently supplies Node 22.23.3 and npm 10.9.9; the original implementation used Node 22.22.3 and npm 10.9.8. From the repository root:

```sh
npm ci
export BEAN_TOKEN="$(openssl rand -hex 32)"
export BEAN_DATABASE="$PWD/bean-budget.sqlite"
npm run server
# For automatic restarts with these overrides: npm run dev:server
```

Keep the token private and retain it in your deployment's secret configuration. There is no default token. Settings are read through Effect Config: `BEAN_TOKEN` (required, nonempty and redacted), `BEAN_DATABASE` (default `bean-budget.sqlite`), `BEAN_HOST` (default `127.0.0.1`), `BEAN_PORT` (default `3000`). Create the database parent directory beforehand. The server closes SQLite on shutdown and listen failure. Binding another host exposes plain HTTP: use a private connection or a TLS reverse proxy before remote use. One bearer token controls one owner's entire budget.

In a second terminal with the same token exported:

```sh
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/accounts \
  -H "Authorization: Bearer $BEAN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Cash","openingBalance":10000,"date":"2026-11-01"}'
# Copy the response id:
ACCOUNT_ID='replace-with-account-id'
curl -sS http://127.0.0.1:3000/transactions \
  -H "Authorization: Bearer $BEAN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"operationId\":\"purchase-001\",\"accountId\":\"$ACCOUNT_ID\",\"amount\":-550,\"date\":\"2026-11-07\"}"
curl -sS "http://127.0.0.1:3000/transactions?accountId=$ACCOUNT_ID&from=2026-11-01&to=2026-11-30" \
  -H "Authorization: Bearer $BEAN_TOKEN"
curl -sS http://127.0.0.1:3000/accounts -H "Authorization: Bearer $BEAN_TOKEN"
```

Only `GET /health` is public. Account creation returns 201 and an account object; listing returns an array. Every account has currency JPY and an explicit opening transaction, including a zero opening balance. Account and opening transaction creation are atomic. Account creation itself has no operation receipt: retrying it creates another account.

Transaction creation returns 201 and an immutable transaction object. Retain a stable operation ID for each transaction intent: retries return the original object, including ID, across restarts. Reusing the ID with another decoded payload returns 409. Receipts and transactions commit in one SQLite transaction. Failed commands retain neither a receipt nor a financial mutation. Unknown accounts return 404. Transactions expose `kind` (`opening` or `transaction`); there are no update/delete routes.

Units are whole JPY (scale zero), signed integers bounded at ±1,000,000,000,000 for each transaction and resulting account balance. Income is positive, spending negative. Balance arithmetic uses bigint before converting the bounded result to number. Balances always derive from the ledger, not a mutable balance column. Dates are real Gregorian YYYY-MM-DD calendar dates, independent of timestamps or host timezone. Query bounds are inclusive; results sort by date then insertion order. `accountId` is required; duplicate or unknown query keys, invalid dates, reversed ranges, invalid integer amounts, malformed JSON and malformed URLs return 400. Request bodies are limited to 16 KiB (413). Unknown JSON fields are stripped by Schema decoding and do not affect receipt identity.

SQLite uses `@effect/sql-sqlite-node` 4.1.2, compatible with Effect 4.1.2, backed by Node's built-in `node:sqlite`. WAL is explicitly enabled, foreign keys are explicitly enabled, and the busy timeout is 5000 ms. The driver serializes access to one scoped connection; `SqlClient.withTransaction` uses BEGIN IMMEDIATE. Ledger commands use tagged SQL, effectful Schema decoding and JSON codecs, and the Effect SecureRandom Web Crypto layer for UUID v4 IDs. Pure bigint balance arithmetic remains in the shared budget package. Native SQLite calls and blocking busy waits live inside the official driver.

`databaseLayer` acquires the scoped client and runs migrations before exposing `SqlClient`. The official `SqliteMigrator.run` owns migration execution and records `(migration_id, name, created_at)` in `effect_sql_migrations`. The initial migration is ID 1, name `initial_ledger`, implemented in `apps/server/migrations/001_initial_ledger.ts`. It exports an Effect that executes explicit SQL statements; the initial schema is unchanged. There is no runtime SQL-file reader or semicolon splitter. Future migration modules can use tagged SQL statements directly, including statements containing semicolons.

Startup wraps schema validation, legacy adoption, and the official migrator in one immediate transaction. Empty databases initialize cleanly. Legacy databases are adopted only with `user_version = 1`, exactly the four known tables, exactly the legacy version-1 record, and the known initial table/index DDL. DDL comparison ignores whitespace outside quoted strings, preserving constraint values. Adoption adds the official journal and marks only migration 1 as applied; existing accounts, transactions, receipts, and legacy metadata remain intact. Other legacy schemas are rejected.

Once the official journal exists, it is authoritative: its ordered ID/name entries must match a prefix of the registered migrations. Unknown, renamed, or missing intermediate migrations fail startup. Legacy `user_version` and `migrations` records no longer constrain upgrades. To add migration 2, create an immutable `002_name.ts` module exporting an Effect and append its import, ID, name, and effect to the registry in `src/migrations.ts`. The official migrator applies only the pending entries; no special version-2 acceptance branch is required. Do not edit an applied migration. There is no automatic downgrade.

HTTP uses Effect's `HttpRouter`, `HttpServerRequest.schemaBodyJson`, and `HttpServerResponse` APIs. Authentication, query validation, request-size limits, error handling, and route execution are Effects. `NodeHttpServer.layer` supplies the Node transport and manages request fibers and server shutdown. There is no manual body-reading Promise, request runner, or listener cleanup. The server's inner scope is released before the database Layer. The main program runs through `@effect/platform-node/NodeRuntime`, which handles failure reporting and SIGINT/SIGTERM interruption.

Input decoding failures are mapped to 400 where requests are decoded. Schema failures from stored rows or receipt JSON remain internal errors and return 500, rather than blaming the client. Internal error logs retain safe classifications (SQL reason and retryability, or stored-data decoding failure); they omit raw error messages, SQL parameters, request bodies, and credentials. Public internal-error responses remain generic.

`tsx` loads workspace TypeScript source exports on Node 22.22.3. No platform runtime dependency enters the shared budget/protocol packages.

Run `npm run check` for TypeScript, shared import boundaries, typed Oxlint, and official Effect diagnostics. The project does not include automated tests or test fixtures.

This slice has no categories, allocations, transfers, sync feed, Gmail, UI, pagination, account idempotency, or multi-owner auth. Queries currently read an account's full transaction history to calculate balances. Use the verified online export and new-path restore commands in [backup and restore](BACKUP.md). Server backups retain accepted data and receipts, while mobile exports also retain unsynchronized edits.

## Docker Compose

With Docker Desktop running, `npm run up` builds the server image, starts it in the background, and waits for its health check. The wrapper creates/reuses `.local/server-token`, just like `dev:server`, unless `BEAN_TOKEN` is already exported. It never prints the token. Use `npm run logs` to follow logs and `npm run down` to stop the stack. No host Node dependencies need installing to run the container; the npm scripts only invoke Bash and Docker.

The API is published at `http://127.0.0.1:3000`; `/health` is public. `BEAN_PORT=3001 npm run up` changes the published host port while the container continues listening on 3000. The native server and Compose cannot both use the same host port. The container binds all of its internal interfaces so Docker can forward requests, but the host publication is loopback-only.

Compose uses a named `server-data` volume mounted at `/data`, separate from the native development database. `npm run down` preserves it. Do not use `docker compose down --volumes` unless you intend to delete the container ledger. Existing `.local/bean-budget.sqlite` data is not automatically imported. A volume is persistence, not a backup; follow the SQLite backup guidance above.

For direct Compose commands, first export the token privately in your terminal:

```sh
export BEAN_TOKEN="$(cat .local/server-token)"
docker compose up --build --detach --wait
curl -sS http://127.0.0.1:3000/accounts -H "Authorization: Bearer $BEAN_TOKEN"
docker compose ps
docker compose down
```

If no token file exists yet, run `npm run up` first. Compose requires a nonempty token; there is no shared default credential. The token is supplied at runtime as an environment variable, so Docker administrators can inspect it. It is excluded from the image and build context. This is a local integration workflow, not a remote deployment configuration.

The image uses Node 22, runs as its non-root `node` user, and launches the Effect server directly with the existing tsx loader. It includes the root development dependencies because tsx currently lives there. Source is copied into the image; rerun `npm run up` after edits. Prefer `npm run dev:server` for automatic reload. The build includes only the server and shared budget/protocol packages; future mobile dependencies are outside its workspace install. There is no web service yet, and the Android emulator and Metro remain host processes.

## Nix package

`nix/flake.nix` exposes the server as `packages.<system>.server` (also `default`) for x86_64-linux, aarch64-linux and aarch64-darwin. Like the Compose image, it installs only the server and the shared budget/protocol workspaces and runs the TypeScript source through tsx. It has two programs:

- `bean-budget-server` runs the server with the environment settings above. Set `BEAN_DATABASE` to an absolute path, because the default is relative to the working directory.
- `bean-budget-backup` takes the same `export`, `verify` and `restore` arguments as `npm run server:backup`.

```sh
nix build 'git+file:.?dir=nix#server'
BEAN_TOKEN=... BEAN_DATABASE=/var/lib/bean-budget/bean-budget.sqlite ./result/bin/bean-budget-server
```

Other flakes reference it as `github:kevinher7/bean-budget?dir=nix`. After changing `package-lock.json`, update `npmDepsHash` in the flake. Set it to `lib.fakeHash`, build, and copy the hash Nix reports.

## Ledger and tracking-budget foundation

Migration 2 (`002_tracking.ts`) upgrades existing/legacy ledgers without modifying migration 1 or receipts. Existing accounts remain JPY; transactions become posted/manual with revision zero. New account requests accept optional `currency` (`JPY` default, or `USD`). Integers represent whole JPY or USD cents; shared `parseMoney` parses decimal text without floating-point multiplication. Account responses include posted `balance` and `projectedBalance` including pending entries. The same ±1,000,000,000,000 bound applies to both balances.

`POST /transactions` additionally accepts optional `categoryId`, `payeeId`, `status` (`posted` default), `source` (`manual` default or `mail-bean`), `notes`, and structured `importIdentity: { namespace, key }`. Import identities are persisted separately and are unique across the ledger; namespace/key design remains the importer's responsibility. A duplicate identity with a different operation returns 409. A stable operation retry returns its original transaction, even after later edits. Transactions returned from the register include metadata, `revision`, and optional `transferId`. Currency comes from the account.

Migration 3 (`003_relational_budget.ts`) replaces the former JSON container with relational tables: `categories`, `payees`, `schedules`, `scheduled_occurrences`, `budgets`, `budget_accounts`, `budget_reserved_schedules`, `budget_periods`, and `budget_allocations`. It validates and copies existing records, rebuilds transaction classification references, checks foreign keys, and removes the old table in the migration transaction. Invalid stored records/references fail migration without discarding the original data. Occurrences are unique by schedule/month, matches by transaction, and allocations by budget/month/category. Existing operation receipts and import identities are retained.

Authenticated routes use domain resources; the former `/foundation`, `/commands`, and `/summary` endpoints are removed. All mutation bodies below include a stable `operationId`. Mutations and receipts commit atomically; success and retries return `{ "accepted": true }`. Reusing an operation ID with another decoded command returns 409. Allocation-map key order does not affect retry identity, including migrated receipts. Existing transaction/account routes retain their response formats.

| Route                                                           | Request fields besides operationId / response                                                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /categories`, `GET /payees`                                | Arrays of `{ id, name }`                                                                                                           |
| `POST /categories`, `POST /payees`                              | `value: { id, name }`; create or rename; `uncategorized` is reserved                                                               |
| `GET /schedules`                                                | Schedule array                                                                                                                     |
| `POST /schedules`                                               | `value: { id, accountId, amount, day, categoryId, payeeId, active }`                                                               |
| `POST /schedules/:scheduleId/occurrences`                       | `month` (`YYYY-MM`); materialize an occurrence                                                                                     |
| `GET /scheduled-occurrences`                                    | Occurrence array                                                                                                                   |
| `PUT /scheduled-occurrences/:id`                                | `amount`; override an unmatched same-sign estimate                                                                                 |
| `POST /scheduled-occurrences/:occurrenceId/pending-transaction` | Create and link a pending transaction                                                                                              |
| `POST /scheduled-occurrences/:occurrenceId/match`               | `transactionId`; match an existing transaction                                                                                     |
| `PUT /transactions/:id`                                         | `revision`, `status`, nullable `categoryId`, `payeeId`, `notes`                                                                    |
| `POST /transfers`                                               | `fromAccountId`, `toAccountId`, negative `outgoing`, positive `incoming`, `date`                                                   |
| `GET /budgets`                                                  | Budget array with included account and reserved schedule IDs                                                                       |
| `POST /budgets`                                                 | `value: { id, name, currency, accountIds, startDay, firstMonth, reservedScheduleIds }`                                             |
| `PUT /budgets/:budgetId/periods/:month`                         | `allocations` mapping category IDs to nonnegative integer units, nullable nonnegative `incomeForecast`; replaces the period's plan |
| `GET /budgets/:budgetId/periods/:month`                         | Saved period with allocations and forecast, or 404 if absent                                                                       |
| `GET /budgets/:budgetId/periods/:month/summary`                 | Calculated period summary, including unsaved periods                                                                               |

Period identity comes from budget/month in the path; there is no client-supplied plan ID. Path IDs take precedence over redundant body fields. Definitions and replacements are decoded before execution. Planning replacements require revisions as described below.

Schedules use signed nonzero amounts and days 1–31; nullable category/payee fields are required. Updates affect future generation only; account and income/expense direction cannot change. Generation clamps the day to the month's last day and is idempotent by schedule/month even with a new operation ID. Occurrences retain their original date, amount, and metadata after schedule edits. No background generator is installed.

Matching requires a same-account, same-sign ordinary transaction. Each occurrence and transaction can be linked once. This declares full settlement, including when the actual amount differs; partial payments and automatic matching are unsupported. Settlement may happen outside the expected period; commitment accounting remains in the expected period. Already-linked occurrences cannot generate another pending transaction or change their estimate.

Transaction edits increment revision; stale revisions return 409. Posting pending entries and historical categorization are supported. Posted-to-pending changes, opening/transfer edits, date/amount edits, and deletion are rejected or unavailable. Transfers create linked posted entries on distinct accounts atomically. Same-currency amounts must cancel; cross-currency amounts are explicit with no FX inference. Opening and transfer entries never affect budget income or spending.

Budget accounts must be distinct and use the budget currency. Reserved schedules must be expenses on included accounts. Currency, account scope and period boundaries are immutable; create another independent budget to change those fields. Reserved bills have an effective-period timeline. `firstMonth` is the first evaluated period with zero opening carryover. Historical allocation/forecast changes recalculate subsequent carryover. Summaries load only the selected budget's accounts, occurrences, and relevant saved periods rather than a combined object containing all planning data.

A summary evaluates from the budget's first month through the requested period (maximum 1200 periods). Boundaries are inclusive start/exclusive end; each monthly start is independently clamped. The response includes currency, boundaries, expectedIncome, commitments, postedIncome, postedNet, spending by category, assignable, unassigned, category remaining, and prior overspending deduction. No cross-currency aggregate is returned.

Expected income is the explicit period forecast, or generated positive occurrences in that period. It is deliberately independent of actual receipts: income deviations do not automatically change the forecast. Commitments are generated occurrences selected by the budget; unmatched and pending-linked commitments use estimates, while posted full settlements replace estimates. Their linked transactions are excluded from discretionary spending, including when settlement dates differ. A budget that does not reserve the schedule counts its transaction normally. Missing occurrences are not inferred: generate all expected occurrences before relying on a summary.

Pending discretionary spending counts immediately and posting does not count it again. Negative uncategorized transactions remain in the `uncategorized` bucket and contribute to next-period overspending. Positive categorized ordinary transactions are treated as refunds, except linked scheduled income; positive uncategorized entries are income. Categorize refunds explicitly. PostedIncome reports all positive ordinary postings (including refunds); postedNet reports all ordinary postings. Positive category remainders stay assigned; negative remainders reset and reduce next-period assignable funds. Signed unassigned carries separately. Forecasts and commitments are planning values, distinct from posted ledger totals.

This supersedes the initial-slice limitations above concerning currencies, metadata, edits, transfers, categories, allocations, and budgets. Web UI, mail orchestration, incremental change feeds, bank reconciliation, automatic matching, and Actual import remain unimplemented. Mobile register and planning synchronization use full snapshots. The backend loads ledger history and planning records for summaries; pagination and incremental summary caching remain future work.

## Mobile register synchronization

`POST /accounts` now accepts optional `operationId` and `id`. Supplying an account ID requires an operation ID. Mobile generates both once and retains them with its outbox intent. The account, opening transaction and receipt commit together. Replaying the decoded request returns the original account response, even after its balance changes. Reusing the operation ID with different content, or creating another operation with an existing account ID, returns 409. Older callers without either field retain the original non-idempotent behavior.

`PUT /transactions/:id` returns `{ accepted: true, transaction }` for new edit operations. The receipt retains that accepted transaction, so retrying after an interrupted acknowledgement returns the same revision and metadata without applying the edit twice. Existing receipts created before this change still return `{ accepted: true }`; clients can reconcile those through the register snapshot. Transaction creation continues to return its original accepted record and server-generated ID on retry.

Authenticated `GET /register` returns `{ accounts, categories, payees, transactions }` in one SQLite read transaction. This first mobile slice uses a complete register snapshot because the server has no deletion routes or sync feed. Clients must merge it while preserving local queued mutations, rather than replacing their database or dropping outbox records. It includes all accounts and transaction history and has no pagination. Incremental change feeds and retention remain future work.

## Mobile planning replication

Migration 4 adds revisions to schedules, occurrences and saved periods, plus a reservation-timeline revision on budgets. Existing rows start at revision zero. New schedules and saved periods start at revision one; an absent record has expected revision zero. Each replacement increments the stored revision. New occurrence estimates start at revision zero.

`GET /register` now includes `planning`, containing all budgets, schedules, occurrences, saved periods and effective-period reservation selections. The server reads planning and ledger inputs in one transaction. This is a complete replication snapshot, separate from the resource routes used for commands and ordinary queries. Mobile requires this contract before synchronizing planning. Older ledger clients can ignore the added fields.

Send top-level `revision` with schedule and period replacements, occurrence generation, estimate overrides, pending-payment creation and full-payment matching. Reservation edits use the budget's `reservationRevision`. A missing or stale planning revision returns 409. Historical receipt payloads still decode without revisions, and matching operation retries return their original receipt before revision checks. Upgrade older planning API callers before writing.

`PUT /budgets/:budgetId/reservations/:month` accepts `operationId`, `revision`, and a complete `scheduleIds` array. It replaces the selection from that period until the next saved selection, increments `reservationRevision`, and rejects periods before `firstMonth`. Included schedules must be expenses on included accounts. Migration seeds each budget's initial selection from its original reserved schedules. Original definition fields remain unchanged.

Generation accepts an optional client `id`. Pending-payment creation accepts an optional client `transactionId`. Receipts return `accepted: true` with canonical `occurrenceId` for generation and both canonical IDs for pending-payment creation. Retries preserve these results. Schedule/month uniqueness still prevents duplicate occurrences when another device generates first. Mobile reconciles canonical occurrence and transaction identities before dependent operations.

Reservation accounting follows the occurrence's expected budget period. Its linked transaction stays excluded from discretionary spending even when settlement happens in another period. Changing a historical selection recalculates commitments and subsequent carryover. The server retains the existing full-settlement and manual-forecast policies.

## Ledger change notifications

Obtain a single-use ticket with an authenticated `POST /notifications/ticket`.
Connect to `GET /notifications?ticket=...` on the same listener using WebSocket.
Tickets expire after 30 seconds. When an Origin header is present, its authority
must match the request host. Keep bearer tokens out of WebSocket URLs and
configure proxies to forward HTTP upgrades and omit ticket query strings from logs.

After a successful register write, the server sends `{"type":"ledgerChanged"}`.
Clients use this hint to fetch a register snapshot. Hints may be dropped or
coalesced, and replaying a receipt may send another hint.

## Gmail debit notifications

Mail ingestion is disabled by default. When enabled, the server runs a job at startup and waits 15 minutes between runs. Mobile foreground notifications arrive after the ledger commit. They do not change the Gmail polling interval.

Set `BEAN_MAIL_ENABLED=true` and pass the following backend settings through your deployment's private configuration. The Gmail OAuth client and refresh token must already have the Gmail readonly scope. Keep these credentials in secret storage outside SQLite and mobile settings.

- `BEAN_GMAIL_CLIENT_ID`, `BEAN_GMAIL_CLIENT_SECRET` and `BEAN_GMAIL_REFRESH_TOKEN`.
- `BEAN_MAIL_CONFIG` is a JSON object. Set a stable `connectionId` for the mailbox and keep it when rotating credentials. Set `cutover` to the desired first Gmail receipt date in Asia/Tokyo, in YYYY-MM-DD format. Set `accounts` to a mapping of `smbc` and/or `yucho` to existing JPY account IDs.
- `status` defaults to `posted`. Accepted debit notices affect the posted balance immediately. Set `status` to `pending` to require a separate posting action.
- `merchants` is optional. Each entry has `merchant` and optional `categoryId`, `payeeId` and `transfer`. Matching uses the exact merchant after Unicode normalization, whitespace folding and case folding. Unknown merchants can enter the register without a category or payee. Mark known transfer merchants with `transfer: true` to hold their notices for review.

The first run searches all matching mail at or after the cutover, then drains Gmail history from a baseline captured before the search. Later runs read history pages. If Gmail expires the history cursor, the server repeats the cutover search and deduplicates previously discovered messages. The issuer's transaction date stays separate from Gmail receipt time.

The server saves discovered messages, run outcomes and review reasons. It holds unavailable messages, malformed debit notices, mapping errors and same-day same-amount candidates for review. An OAuth failure records a blocked run. Check the configured credential and readonly scope before the next run. Imported mail amounts are whole yen and accepted imports appear in the regular register.

Authenticated `GET /mail/status` returns message counts by mailbox, state and
reason, plus the 20 most recent runs. It excludes message bodies and credentials.

By default, parsed notices need explicit review before they become purchases.
Set `trustGmailAuthenticationResults: true` only for a mailbox whose delivery
path strips forged Gmail Authentication-Results headers. With that setting,
automatic acceptance requires a single `mx.google.com` result reporting
`dmarc=pass` for the issuer's exact From domain. Missing, failed, or ambiguous
authentication leaves the notice in review. See [RFC 8601](https://www.rfc-editor.org/rfc/rfc8601.html).

## Mail review

Use the server bearer token for both requests.

- `GET /mail/review` lists up to 100 messages awaiting review. Each mapped notice
  includes same-account, same-amount and same-day candidate transactions.
  Compare the candidates with the bank notice before choosing an action. A
  link can explicitly select a transaction from another date by ID. Use this
  for a known date difference between the notice and the register entry.
- `POST /mail/review` accepts JSON. Reuse the same operation ID and exact
  action when retrying after a lost response. Use a new operation ID for a
  different decision.

```json
{
  "operationId": "operator-review-001",
  "message": { "connectionId": "personal", "messageId": "synthetic123" },
  "action": "link",
  "transactionId": "selected-transaction-id",
  "revision": 0,
  "status": "pending"
}
```

`link` uses the selected manual transaction's current revision and status.
It preserves its date, category, payee, notes and posting state. Scheduled
payments use their existing occurrence workflow. `import` accepts the frozen
purchase as its own transaction. `ignore` records the decision without a
ledger write. These last two actions require only the operation and message IDs.

For a transfer, use `transfer` with `toAccountId` and the actual positive
`incoming` amount in destination minor units. The notice supplies the
outgoing account, amount and date. Both legs post together. Same-currency
amounts must balance. For a notification about an existing transfer use
`linkTransfer` with the outgoing leg's `transactionId`. Each source message
has its own identity, so several notices can point to the same financial record.
