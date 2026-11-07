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

This slice has no categories, allocations, transfers, sync feed, Gmail, UI, pagination, account idempotency, or multi-owner auth. Queries currently read an account's full transaction history to calculate balances. Back up SQLite using its online backup facilities or stop the server and copy the database together with any WAL state; restore verification remains operational work before primary-ledger use.

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
