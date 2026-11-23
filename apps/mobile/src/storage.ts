import { Clock, Data, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { balance, parseMoney, tokyoDate, Currency } from "@bean-budget/budget";
import {
  Account,
  Command,
  CommandReceipt,
  CreateAccount,
  CreateTransaction,
  NamedRecord,
  Transaction,
  Transactions,
  RegisterSnapshot,
  Planning,
  validatePlanning,
} from "@bean-budget/protocol";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { refreshWidgets } from "./widgets.ts";
import { randomUUID } from "expo-crypto";
import {
  emptyPlanning,
  planningKey,
  planningCommands,
  projectPlanning,
  widgetAllowances,
  type PlanningCommand,
} from "./planning.ts";
import { loadConnection } from "./connection.ts";
import {
  Operation,
  backupContent,
  backupSummary,
  decodeBackup,
  normalizeServerUrl,
  type MobileBackup,
} from "./backup.ts";

export class LocalStorageError extends Data.TaggedError("LocalStorageError")<{
  message: string;
  cause?: unknown;
}> {}

const Snapshot = RegisterSnapshot;
type Operation = typeof Operation.Type;
type RecordKind = "accounts" | "categories" | "payees" | "transactions";
let database: SQLiteDatabase;
let syncing = false;

function records<S extends Schema.ConstraintDecoder<unknown>>(
  kind: RecordKind,
  schema: S,
): S["Type"][] {
  return database
    .getAllSync<{ id: string; payload: string }>(
      "SELECT id,payload FROM records WHERE kind = ? ORDER BY rowid",
      kind,
    )
    .map((row) => {
      const value = Schema.decodeUnknownSync(schema)(JSON.parse(row.payload));
      if (typeof value !== "object" || value === null || !("id" in value) || value.id !== row.id)
        throw new Error("Local record ID differs from its content");
      return value;
    });
}

function put<T extends { readonly id: string }>(kind: RecordKind, value: T) {
  database.runSync(
    "INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
    kind,
    value.id,
    JSON.stringify(value),
  );
}

function enqueue(kind: Operation["kind"], localId: string, payload: object, operationId: string) {
  database.runSync(
    "INSERT INTO outbox(operationId,kind,localId,payload,error) VALUES(?,?,?,?,NULL)",
    operationId,
    kind,
    localId,
    JSON.stringify(payload),
  );
}

function operations() {
  return Schema.decodeUnknownSync(Schema.Array(Operation))(
    database.getAllSync("SELECT operationId,kind,localId,payload,error FROM outbox ORDER BY rowid"),
  );
}

function assertBalances(accountId: string, rows: readonly (typeof Transaction.Type)[]) {
  const relevant = rows.filter((row) => row.accountId === accountId);
  balance(relevant.map((row) => row.amount));
  balance(relevant.filter((row) => row.status !== "pending").map((row) => row.amount));
}

const initializeDatabase = Effect.try({
  try: () => {
    database = openDatabaseSync("bean-budget.sqlite");
    database.execSync("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    database.withTransactionSync(() => {
      const version = database.getFirstSync<{ user_version: number }>(
        "PRAGMA user_version",
      )?.user_version;
      if (version === 3 || version === 4 || version === 5 || version === 6 || version === 7) return;
      if (version === 2) {
        database.execSync(
          "CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=3;",
        );
        return;
      }
      if (version !== 0 && version !== 1) throw new Error("Unsupported local database version");
      database.execSync(
        "CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE accepted(id TEXT PRIMARY KEY,payload TEXT NOT NULL);",
      );
      if (version === 1) database.execSync("ALTER TABLE outbox RENAME TO legacy_outbox;");
      database.execSync(
        "CREATE TABLE outbox(operationId TEXT PRIMARY KEY,kind TEXT NOT NULL,localId TEXT NOT NULL,payload TEXT NOT NULL,error TEXT);",
      );
      if (version === 1) {
        const legacy = Schema.decodeUnknownSync(Transactions)(
          database.getAllSync("SELECT * FROM transactions"),
        );
        const accountId = randomUUID();
        const operationId = randomUUID();
        put("accounts", {
          id: accountId,
          name: "Cash",
          currency: "JPY",
          balance: 0,
          projectedBalance: 0,
        });
        enqueue(
          "account",
          accountId,
          {
            operationId,
            id: accountId,
            name: "Cash",
            currency: "JPY",
            openingBalance: 0,
            date: legacy[0]?.date ?? "1970-01-01",
          },
          operationId,
        );
        for (const row of legacy) {
          const prior = database.getFirstSync<{ payload: string }>(
            "SELECT payload FROM legacy_outbox WHERE transactionId=?",
            row.id,
          );
          if (!prior) throw new Error("Legacy transaction has no durable operation");
          const command = Schema.decodeUnknownSync(Schema.fromJsonString(CreateTransaction))(
            prior.payload,
          );
          put("transactions", { ...row, accountId, status: "posted", revision: 0 });
          enqueue("create", row.id, { ...command, accountId }, command.operationId);
        }
        database.execSync("DROP TABLE legacy_outbox; DROP TABLE transactions;");
      }
      database.execSync(
        "CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=3;",
      );
    });
    database.withTransactionSync(() => {
      for (const table of ["records", "outbox"])
        for (const action of ["INSERT", "UPDATE", "DELETE"])
          database.execSync(
            `CREATE TRIGGER IF NOT EXISTS widget_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN INSERT INTO metadata(name,value) VALUES('widgetUpdatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value; END;`,
          );
      if (
        database.getFirstSync<{ user_version: number }>("PRAGMA user_version")?.user_version === 6
      ) {
        database.execSync("DROP TABLE IF EXISTS spending_widget_weeks");
        for (const event of ["insert", "update", "delete"])
          database.execSync(`DROP TRIGGER IF EXISTS invalidate_widget_calendar_${event}`);
        database.runSync("DELETE FROM metadata WHERE name='widgetCalendarDate'");
      }
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const source = action === "DELETE" ? "OLD" : "NEW";
        database.execSync(`CREATE TRIGGER IF NOT EXISTS invalidate_widget_scope_${action.toLowerCase()}
          AFTER ${action} ON metadata
          WHEN ${source}.name IN ('widgetUpdatedAt','planning','deferredTransactions','serverUrl')
          BEGIN DELETE FROM metadata WHERE name='widgetSpendingScope'; END;`);
      }
      database.execSync("PRAGMA user_version=7;");
    });
  },
  catch: (cause) => new LocalStorageError({ message: "Could not open local ledger", cause }),
});

export const getServerUrl = Effect.try({
  try: () =>
    database.getFirstSync<{ value: string }>("SELECT value FROM metadata WHERE name='serverUrl'")
      ?.value ?? null,
  catch: (cause) => new LocalStorageError({ message: "Could not read the ledger server", cause }),
});

function bindServer(url: string) {
  const normalized = normalizeServerUrl(url);
  const previous = database.getFirstSync<{ value: string }>(
    "SELECT value FROM metadata WHERE name='serverUrl'",
  )?.value;
  if (previous && previous !== normalized)
    throw new Error("This ledger belongs to another server. Use its original server URL.");
  database.runSync(
    "INSERT INTO metadata(name,value) VALUES('serverUrl',?) ON CONFLICT(name) DO NOTHING",
    normalized,
  );
}

export const initialize = Effect.gen(function* () {
  yield* initializeDatabase;
  const connection = yield* loadConnection;
  if (connection)
    yield* Effect.try({
      try: () => bindServer(connection.url),
      catch: (cause) =>
        new LocalStorageError({
          message: "Saved connection differs from the ledger server",
          cause,
        }),
    });
});

function readBackup(): MobileBackup {
  if (
    database.getFirstSync(
      "SELECT id FROM records WHERE kind NOT IN ('accounts','categories','payees','transactions') LIMIT 1",
    )
  )
    throw new Error("Unknown local record kind");
  const value = {
    format: "bean-budget-mobile" as const,
    version: 2 as const,
    planning: acceptedPlanning(),
    deferredTransactions: deferredTransactions(),
    createdAt: new Date().toISOString(),
    serverUrl:
      database.getFirstSync<{ value: string }>("SELECT value FROM metadata WHERE name='serverUrl'")
        ?.value ?? null,
    accounts: records("accounts", Account),
    categories: records("categories", NamedRecord),
    payees: records("payees", NamedRecord),
    transactions: records("transactions", Transaction),
    accepted: database
      .getAllSync<{ id: string; payload: string }>("SELECT id,payload FROM accepted ORDER BY rowid")
      .map((row) => {
        const transaction = Schema.decodeUnknownSync(Schema.fromJsonString(Transaction))(
          row.payload,
        );
        if (transaction.id !== row.id)
          throw new Error("Accepted record ID differs from its content");
        return transaction;
      }),
    outbox: operations(),
  };
  return decodeBackup(JSON.stringify(value));
}

export const exportBackup = Effect.try({
  try: () => {
    if (syncing) throw new Error("Wait for synchronization to finish before exporting");
    let text = "";
    database.withTransactionSync(() => {
      text = JSON.stringify(readBackup(), null, 2);
    });
    return text;
  },
  catch: (cause) => new LocalStorageError({ message: "Could not export the mobile backup", cause }),
});

export const inspectBackup = Effect.fn("inspectBackup")(function* (text: string) {
  return yield* Effect.try({
    try: () => backupSummary(decodeBackup(text)),
    catch: (cause) =>
      new LocalStorageError({ message: "Invalid or unsupported mobile backup", cause }),
  });
});

export const restoreBackup = Effect.fn("restoreBackup")(function* (
  text: string,
  expectedCurrentBackup: string,
  savedServerUrl?: string,
) {
  yield* Effect.try({
    try: () => {
      if (syncing) throw new Error("Wait for synchronization to finish before restoring");
      const backup = decodeBackup(text);
      const expected = decodeBackup(expectedCurrentBackup);
      if (
        savedServerUrl &&
        backup.serverUrl &&
        normalizeServerUrl(savedServerUrl) !== backup.serverUrl
      )
        throw new Error("Backup belongs to another server. Its original server URL is required.");
      database.withTransactionSync(() => {
        if (backupContent(readBackup()) !== backupContent(expected))
          throw new Error(
            "The ledger changed after restore confirmation. Review the backup again.",
          );
        database.execSync(
          "DELETE FROM outbox; DELETE FROM accepted; DELETE FROM records; DELETE FROM metadata;",
        );
        for (const kind of ["accounts", "categories", "payees", "transactions"] as const)
          for (const row of backup[kind]) put(kind, row);
        for (const row of backup.accepted)
          database.runSync(
            "INSERT INTO accepted(id,payload) VALUES(?,?)",
            row.id,
            JSON.stringify(row),
          );
        database.runSync(
          "INSERT INTO metadata(name,value) VALUES('planning',?)",
          JSON.stringify(backup.planning),
        );
        database.runSync(
          "INSERT INTO metadata(name,value) VALUES('deferredTransactions',?)",
          JSON.stringify(backup.deferredTransactions),
        );
        for (const row of backup.outbox)
          database.runSync(
            "INSERT INTO outbox(operationId,kind,localId,payload,error) VALUES(?,?,?,?,?)",
            row.operationId,
            row.kind,
            row.localId,
            row.payload,
            row.error,
          );
        if (backup.serverUrl !== null)
          database.runSync(
            "INSERT INTO metadata(name,value) VALUES('serverUrl',?)",
            backup.serverUrl,
          );
        database.runSync(
          "INSERT INTO metadata(name,value) VALUES('widgetUpdatedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        );
        if (backupContent(readBackup()) !== backupContent(backup))
          throw new Error("Restored content differs from backup. Restore rolled back.");
      });
    },
    catch: (cause) =>
      new LocalStorageError({
        message:
          cause instanceof Error ? cause.message : "Restore failed. The current ledger was kept.",
        cause,
      }),
  });
  return yield* loadLedger();
});

export const loadLedger = Effect.fn("loadLedger")(function* () {
  const today = tokyoDate(yield* Clock.currentTimeMillis);
  const ledger = yield* Effect.try({
    try: () => {
      const queued = operations();
      const transactions = records("transactions", Transaction)
        .map((row) => {
          const edits = queued.filter(
            (operation) =>
              operation.localId === row.id ||
              (row.kind === "opening" &&
                operation.kind === "account" &&
                operation.localId === row.accountId),
          );
          const creation = queued.find(
            (operation) =>
              operation.kind === "planning" &&
              planningCommands([operation]).some(
                (command) =>
                  command.type === "pendingOccurrence" && command.transactionId === row.id,
              ),
          );
          const error = edits.find((operation) => operation.error)?.error ?? creation?.error;
          return {
            ...row,
            planningSyncError: Boolean(creation?.error),
            syncStatus: error
              ? ("failed" as const)
              : edits.length || creation
                ? ("pending" as const)
                : ("synced" as const),
            syncError: error ?? undefined,
          };
        })
        .sort((a, b) => b.date.localeCompare(a.date));
      const accounts = records("accounts", Account).map((account) => {
        const rows = transactions.filter((row) => row.accountId === account.id);
        return {
          ...account,
          balance: balance(rows.filter((row) => row.status !== "pending").map((row) => row.amount)),
          projectedBalance: balance(rows.map((row) => row.amount)),
        };
      });
      const planning = projectPlanning(acceptedPlanning(), planningCommands(queued));
      const linked = planning.occurrences.flatMap((row) =>
        row.transactionId ? [row.transactionId] : [],
      );
      const state = {
        accounts,
        transactions,
        planningConflict:
          new Set(linked).size !== linked.length ||
          queued.some((row) => row.kind === "planning" && row.error !== null),
        categories: records("categories", NamedRecord),
        payees: records("payees", NamedRecord),
        pending: queued.length,
        failed: queued.filter((row) => row.error).length,
        planning,
        deferredTransactions: deferredTransactions(),
        planningOperations: queued.filter((row) => row.kind === "planning"),
      };
      let widgetScopeFailed = false;
      try {
        const cached = database.getFirstSync<{ asOf: string }>(
          "SELECT json_extract(value,'$.asOf') AS asOf FROM metadata WHERE name='widgetSpendingScope'",
        );
        if (cached?.asOf !== today) {
          const budgets = state.planningConflict
            ? []
            : planning.budgets
                .filter(
                  (budget) =>
                    !state.deferredTransactions.some((row) =>
                      budget.accountIds.includes(row.accountId),
                    ),
                )
                .map((budget) => {
                  const { id, name, currency, accountIds } = budget;
                  let allowances;
                  try {
                    allowances = widgetAllowances(planning, budget, transactions, today);
                  } catch (error) {
                    if (!(error instanceof RangeError)) throw error;
                  }
                  return { id, name, currency, accountIds, ...allowances };
                });
          const incomeIds = planning.occurrences
            .filter((row) => row.amount > 0 && row.transactionId)
            .map((row) => row.transactionId);
          database.runSync(
            "INSERT OR REPLACE INTO metadata(name,value) VALUES('widgetSpendingScope',?)",
            JSON.stringify({ asOf: today, budgets, incomeIds }),
          );
        }
      } catch {
        widgetScopeFailed = true;
      }
      return { ...state, widgetScopeFailed };
    },
    catch: (cause) => new LocalStorageError({ message: "Could not read local ledger", cause }),
  });
  const widgets = yield* refreshWidgets.pipe(Effect.result);
  return {
    ...ledger,
    widgetWarning:
      ledger.widgetScopeFailed || widgets._tag === "Failure"
        ? "Your register is saved. Widgets could not refresh. Reopen the app to retry."
        : null,
  };
});

export const createAccount = Effect.fn("createAccount")(function* (input: {
  name: string;
  currency: typeof Currency.Type;
  openingBalance: string;
  date: string;
}) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const command = Schema.decodeUnknownSync(CreateAccount)({
          ...input,
          name: input.name.trim(),
          openingBalance: parseMoney(input.openingBalance, input.currency),
        });
        const id = randomUUID();
        const operationId = randomUUID();
        put("accounts", {
          id,
          name: command.name,
          currency: input.currency,
          balance: command.openingBalance,
          projectedBalance: command.openingBalance,
        });
        put("transactions", {
          id: `opening_${id}`,
          accountId: id,
          amount: command.openingBalance,
          date: command.date,
          kind: "opening",
          status: "posted",
          revision: 0,
        });
        enqueue("account", id, { ...command, id, operationId }, operationId);
      }),
    catch: (cause) =>
      new LocalStorageError({ message: "Check account name, amount and date", cause }),
  });
  return yield* loadLedger();
});

export const saveClassification = Effect.fn("saveClassification")(function* (
  kind: "category" | "payee",
  name: string,
) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const value = Schema.decodeUnknownSync(NamedRecord)({
          id: randomUUID(),
          name: name.trim(),
        });
        const operationId = randomUUID();
        put(kind === "category" ? "categories" : "payees", value);
        enqueue(kind, value.id, { operationId, value }, operationId);
      }),
    catch: (cause) =>
      new LocalStorageError({ message: "Enter a name up to 200 characters", cause }),
  });
  return yield* loadLedger();
});

export const saveTransaction = Effect.fn("saveTransaction")(function* (input: {
  accountId: string;
  amount: string;
  date: string;
  status: "pending" | "posted";
  categoryId?: string;
  payeeId?: string;
  notes?: string;
}) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const account = records("accounts", Account).find((row) => row.id === input.accountId);
        if (!account) throw new Error("Choose an account");
        const command = Schema.decodeUnknownSync(CreateTransaction)({
          ...input,
          amount: parseMoney(input.amount, account.currency),
          operationId: randomUUID(),
        });
        if (command.amount === 0) throw new Error("Enter a nonzero amount");
        if (
          command.categoryId &&
          !records("categories", NamedRecord).some((row) => row.id === command.categoryId)
        )
          throw new Error("Unknown category");
        if (
          command.payeeId &&
          !records("payees", NamedRecord).some((row) => row.id === command.payeeId)
        )
          throw new Error("Unknown payee");
        const row = { ...command, id: randomUUID(), kind: "transaction" as const, revision: 0 };
        assertBalances(account.id, [...records("transactions", Transaction), row]);
        put("transactions", row);
        enqueue("create", row.id, command, command.operationId);
      }),
    catch: (cause) =>
      new LocalStorageError({ message: "Check amount, date, category and balance limits", cause }),
  });
  return yield* loadLedger();
});

export const editTransaction = Effect.fn("editTransaction")(function* (
  id: string,
  input: {
    status: "pending" | "posted";
    categoryId: string | null;
    payeeId: string | null;
    notes: string | null;
  },
) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const rows = records("transactions", Transaction);
        const row = rows.find((value) => value.id === id);
        if (!row || row.kind !== "transaction" || row.transferId)
          throw new Error("Transaction cannot be edited");
        if (operations().some((op) => op.localId === id && op.error))
          throw new Error("Resolve the failed edit first");
        if (row.status === "posted" && input.status === "pending")
          throw new Error("Posted entries cannot become pending");
        const command = Schema.decodeUnknownSync(Command)({
          type: "editTransaction",
          operationId: randomUUID(),
          id,
          revision: row.revision ?? 0,
          ...input,
        });
        const updated = { ...row, ...input, revision: (row.revision ?? 0) + 1 };
        assertBalances(
          row.accountId,
          rows.map((value) => (value.id === id ? updated : value)),
        );
        put("transactions", updated);
        enqueue("edit", id, command, command.operationId);
      }),
    catch: (cause) =>
      new LocalStorageError({
        message: "Could not edit transaction. Resolve failed changes first.",
        cause,
      }),
  });
  return yield* loadLedger();
});

export const postTransaction = Effect.fn("postTransaction")(function* (id: string) {
  const ledger = yield* loadLedger();
  const row = ledger.transactions.find((value) => value.id === id);
  if (!row) return yield* Effect.fail(new LocalStorageError({ message: "Transaction not found" }));
  return yield* editTransaction(id, {
    status: "posted",
    categoryId: row.categoryId ?? null,
    payeeId: row.payeeId ?? null,
    notes: row.notes ?? null,
  });
});

export const retryFailed = Effect.fn("retryFailed")(function* () {
  yield* Effect.try(() => database.runSync("UPDATE outbox SET error=NULL"));
  return yield* loadLedger();
});

class RemoteRejection extends Data.TaggedError("RemoteRejection")<{
  status: number;
  message: string;
}> {}

const request = Effect.fn("registerRequest")(function* (
  connection: { url: string; token: string },
  method: "GET" | "POST" | "PUT",
  path: string,
  payload?: unknown,
) {
  let req = HttpClientRequest.make(method)(connection.url.replace(/\/$/, "") + path).pipe(
    HttpClientRequest.bearerToken(connection.token),
  );
  if (payload !== undefined) req = yield* HttpClientRequest.bodyJson(req, payload);
  const response = yield* HttpClient.execute(req);
  if (response.status < 200 || response.status >= 300)
    return yield* Effect.fail(
      new RemoteRejection({
        status: response.status,
        message:
          response.status === 409
            ? "Conflict. Review this change before retrying."
            : response.status === 401
              ? "Connection rejected. Check your token."
              : `Server rejected change (${response.status}).`,
      }),
    );
  return yield* response.json;
}, Effect.timeout("15 seconds"));

function deferredTransactions() {
  const row = database.getFirstSync<{ value: string }>(
    "SELECT value FROM metadata WHERE name='deferredTransactions'",
  );
  return row ? Schema.decodeUnknownSync(Schema.fromJsonString(Transactions))(row.value) : [];
}

function acceptedPlanning() {
  const row = database.getFirstSync<{ value: string }>(
    "SELECT value FROM metadata WHERE name='planning'",
  );
  return row ? Schema.decodeUnknownSync(Schema.fromJsonString(Planning))(row.value) : emptyPlanning;
}

function remapOccurrence(from: string, to: string) {
  if (from === to) return;
  for (const row of operations().filter((operation) => operation.kind === "planning")) {
    const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(row.payload);
    const next =
      command.type === "occurrence" && command.id === from
        ? { ...command, id: to }
        : (command.type === "match" || command.type === "pendingOccurrence") &&
            command.occurrenceId === from
          ? { ...command, occurrenceId: to }
          : undefined;
    if (next)
      database.runSync(
        "UPDATE outbox SET localId=?,payload=? WHERE operationId=?",
        to,
        JSON.stringify(next),
        row.operationId,
      );
  }
}

function mergeSnapshot(snapshot: typeof Snapshot.Type) {
  validatePlanning(
    snapshot.planning,
    snapshot.accounts,
    snapshot.categories,
    snapshot.payees,
    snapshot.transactions,
  );
  const deferred: (typeof Transaction.Type)[] = [];
  for (const command of planningCommands(operations())) {
    if (command.type !== "generate" || !command.id) continue;
    const existing = snapshot.planning.occurrences.find(
      (row) => row.scheduleId === command.scheduleId && row.month === command.month,
    );
    if (existing) remapOccurrence(command.id, existing.id);
  }
  database.runSync(
    "INSERT INTO metadata(name,value) VALUES('planning',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    JSON.stringify(snapshot.planning),
  );
  const queued = operations();
  for (const transaction of snapshot.transactions) {
    // A lost create acknowledgement may already be in this snapshot under its server ID.
    const unresolvedCreate = queued.some(
      (operation) =>
        operation.kind === "create" &&
        Schema.decodeUnknownSync(Schema.fromJsonString(CreateTransaction))(operation.payload)
          .accountId === transaction.accountId,
    );
    if (unresolvedCreate) {
      deferred.push(transaction);
      continue;
    }
    if (transaction.kind === "opening")
      database.runSync(
        "DELETE FROM records WHERE kind='transactions' AND id=?",
        `opening_${transaction.accountId}`,
      );
    database.runSync(
      "INSERT INTO accepted(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      transaction.id,
      JSON.stringify(transaction),
    );
    if (!queued.some((operation) => operation.localId === transaction.id))
      put("transactions", transaction);
  }
  database.runSync(
    "INSERT INTO metadata(name,value) VALUES('deferredTransactions',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
    JSON.stringify(deferred),
  );
  for (const kind of ["accounts", "categories", "payees"] as const) {
    for (const row of snapshot[kind])
      if (!queued.some((operation) => operation.localId === row.id)) put(kind, row);
  }
}

export const synchronize = Effect.fn("synchronize")(function* (connection: {
  url: string;
  token: string;
}) {
  if (syncing)
    return yield* Effect.fail(
      new LocalStorageError({ message: "Synchronization is already running" }),
    );
  syncing = true;
  return yield* Effect.gen(function* () {
    yield* Effect.try({
      try: () => bindServer(connection.url),
      catch: (cause) =>
        new LocalStorageError({ message: "Use this ledger's original server URL", cause }),
    });
    const initial = yield* request(connection, "GET", "/register").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
    );
    yield* Effect.try(() => database.withTransactionSync(() => mergeSnapshot(initial)));
    const queued = yield* Effect.try(operations);
    for (const original of queued) {
      const operation = yield* Effect.try(() =>
        operations().find((row) => row.operationId === original.operationId),
      );
      if (!operation || operation.error) break;
      const payload = yield* Effect.try(() => JSON.parse(operation.payload) as unknown);
      const path =
        operation.kind === "account"
          ? "/accounts"
          : operation.kind === "category"
            ? "/categories"
            : operation.kind === "payee"
              ? "/payees"
              : operation.kind === "create"
                ? "/transactions"
                : operation.kind === "planning"
                  ? planningPath(Schema.decodeUnknownSync(Command)(payload))
                  : `/transactions/${operation.localId}`;
      const planning = operation.kind === "planning" ? planningCommands([operation])[0] : undefined;
      const body =
        planning?.type === "plan" || planning?.type === "reservation"
          ? { ...planning.value, operationId: planning.operationId, revision: planning.revision }
          : payload;
      const result = yield* request(
        connection,
        operation.kind === "edit" ||
          (operation.kind === "planning" &&
            ["plan", "reservation", "occurrence"].includes(
              Schema.decodeUnknownSync(Command)(payload).type,
            ))
          ? "PUT"
          : "POST",
        path,
        body,
      ).pipe(Effect.result);
      if (result._tag === "Failure") {
        const rejection = result.failure;
        yield* Effect.try(() =>
          database.runSync(
            "UPDATE outbox SET error=? WHERE operationId=?",
            rejection instanceof RemoteRejection
              ? rejection.message
              : "Could not reach server. Retry when connected.",
            operation.operationId,
          ),
        );
        return yield* Effect.fail(
          new LocalStorageError({
            message:
              rejection instanceof RemoteRejection
                ? rejection.message
                : "Could not reach server. Your changes are saved.",
          }),
        );
      }
      const accepted =
        operation.kind === "create"
          ? yield* Schema.decodeUnknownEffect(Transaction)(result.success)
          : operation.kind === "edit"
            ? (yield* Schema.decodeUnknownEffect(
                Schema.Struct({ accepted: Schema.Boolean, transaction: Transaction }),
              )(result.success)).transaction
            : undefined;
      if (operation.kind === "account") {
        const account = yield* Schema.decodeUnknownEffect(Account)(result.success);
        if (account.id !== operation.localId)
          return yield* Effect.fail(
            new LocalStorageError({
              message: "Server returned a different account. The operation is retained.",
            }),
          );
      } else if (operation.kind === "category" || operation.kind === "payee") {
        yield* Schema.decodeUnknownEffect(Schema.Struct({ accepted: Schema.Literal(true) }))(
          result.success,
        );
      }
      const planningAccepted =
        operation.kind === "planning"
          ? yield* request(connection, "GET", "/register").pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
            )
          : undefined;
      yield* Effect.try(() =>
        database.withTransactionSync(() => {
          if (planningAccepted) mergeSnapshot(planningAccepted);
          if (operation.kind === "planning") {
            const command = Schema.decodeUnknownSync(Command)(payload);
            const receipt = Schema.decodeUnknownSync(CommandReceipt)(result.success);
            if (command.type === "generate" && command.id && receipt.occurrenceId)
              remapOccurrence(command.id, receipt.occurrenceId);
          }
          if (accepted) {
            const local = records("transactions", Transaction).find(
              (row) => row.id === operation.localId,
            );
            const later = operations().filter(
              (row) =>
                row.localId === operation.localId && row.operationId !== operation.operationId,
            );
            database.runSync(
              "DELETE FROM records WHERE kind='transactions' AND id=?",
              operation.localId,
            );
            put("transactions", later.length && local ? { ...local, id: accepted.id } : accepted);
            database.runSync(
              "INSERT INTO accepted(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
              accepted.id,
              JSON.stringify(accepted),
            );
            for (const row of operations().filter((row) => row.kind === "planning")) {
              const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(row.payload);
              if (command.type === "match" && command.transactionId === operation.localId)
                database.runSync(
                  "UPDATE outbox SET payload=? WHERE operationId=?",
                  JSON.stringify({ ...command, transactionId: accepted.id }),
                  row.operationId,
                );
            }
            for (const row of later) {
              const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(row.payload);
              if (command.type !== "editTransaction")
                throw new Error("Invalid dependent operation");
              database.runSync(
                "UPDATE outbox SET localId=?,payload=? WHERE operationId=?",
                accepted.id,
                JSON.stringify({ ...command, id: accepted.id }),
                row.operationId,
              );
            }
          }
          database.runSync("DELETE FROM outbox WHERE operationId=?", operation.operationId);
        }),
      );
    }
    const snapshot = yield* request(connection, "GET", "/register").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
    );
    yield* Effect.try(() =>
      database.withTransactionSync(() => {
        mergeSnapshot(snapshot);
        database.runSync(
          "INSERT INTO metadata(name,value) VALUES('lastSyncedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        );
      }),
    );
    return yield* loadLedger();
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        syncing = false;
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );
});

export const acceptServer = Effect.fn("acceptServer")(function* (id: string) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const saved = database.getFirstSync<{ payload: string }>(
          "SELECT payload FROM accepted WHERE id=?",
          id,
        );
        if (!saved) throw new Error("Synchronize to load the accepted transaction first");
        const row = Schema.decodeUnknownSync(Schema.fromJsonString(Transaction))(saved.payload);
        if (!operations().some((operation) => operation.localId === id && operation.error))
          throw new Error("No failed changes to resolve");
        database.runSync("DELETE FROM outbox WHERE localId=? AND kind='edit'", id);
        put("transactions", row);
      }),
    catch: (cause) =>
      new LocalStorageError({ message: "Synchronize before resolving this change", cause }),
  });
  return yield* loadLedger();
});

export const resolveConflict = Effect.fn("resolveConflict")(function* (id: string) {
  yield* Effect.try({
    try: () =>
      database.withTransactionSync(() => {
        const saved = database.getFirstSync<{ payload: string }>(
          "SELECT payload FROM accepted WHERE id=?",
          id,
        );
        const local = records("transactions", Transaction).find((row) => row.id === id);
        if (!saved || !local) throw new Error("Synchronize to load the accepted transaction first");
        const server = Schema.decodeUnknownSync(Schema.fromJsonString(Transaction))(saved.payload);
        if (!operations().some((operation) => operation.localId === id && operation.error))
          throw new Error("No failed changes to resolve");
        const command = Schema.decodeUnknownSync(Command)({
          type: "editTransaction",
          operationId: randomUUID(),
          id,
          revision: server.revision ?? 0,
          status: server.status === "posted" ? "posted" : (local.status ?? "posted"),
          categoryId: local.categoryId ?? null,
          payeeId: local.payeeId ?? null,
          notes: local.notes ?? null,
        });
        if (command.type !== "editTransaction") throw new Error("Invalid edit");
        const updated = { ...server, ...command, revision: command.revision + 1 };
        assertBalances(
          server.accountId,
          records("transactions", Transaction).map((row) => (row.id === id ? updated : row)),
        );
        database.runSync("DELETE FROM outbox WHERE localId=? AND kind='edit'", id);
        put("transactions", updated);
        enqueue("edit", id, command, command.operationId);
      }),
    catch: (cause) =>
      new LocalStorageError({ message: "Synchronize before resolving this change", cause }),
  });
  return yield* loadLedger();
});

function planningPath(command: typeof Command.Type) {
  switch (command.type) {
    case "budget":
      return "/budgets";
    case "schedule":
      return "/schedules";
    case "plan": {
      const period = `/budgets/${command.value.budgetId}/periods/${command.value.month}`;
      return command.value.categoryPlans === undefined ? period : period + "/category-plan";
    }
    case "reservation":
      return `/budgets/${command.value.budgetId}/reservations/${command.value.month}`;
    case "generate":
      return `/schedules/${command.scheduleId}/occurrences`;
    case "occurrence":
      return `/scheduled-occurrences/${command.id}`;
    case "pendingOccurrence":
      return `/scheduled-occurrences/${command.occurrenceId}/pending-transaction`;
    case "match":
      return `/scheduled-occurrences/${command.occurrenceId}/match`;
    case "category":
    case "payee":
    case "editTransaction":
    case "transfer":
      throw new Error("Unsupported planning operation");
  }
}

export const savePlanning = Effect.fn("savePlanning")(function* (
  commands: readonly PlanningCommand[],
) {
  yield* Effect.try({
    try: () => {
      if (syncing) throw new Error("Wait for synchronization to finish");
      database.withTransactionSync(() => {
        for (const candidate of commands) {
          const decoded = Schema.decodeUnknownSync(Command)(candidate);
          const command = planningCommands([
            { kind: "planning", payload: JSON.stringify(decoded) },
          ])[0];
          if (!command) throw new Error("Invalid planning command");
          const current = projectPlanning(acceptedPlanning(), planningCommands(operations()));
          const expected =
            command.type === "plan"
              ? (current.periods.find(
                  (row) =>
                    row.budgetId === command.value.budgetId && row.month === command.value.month,
                )?.revision ?? 0)
              : command.type === "schedule" || command.type === "generate"
                ? (current.schedules.find(
                    (row) =>
                      row.id ===
                      (command.type === "schedule" ? command.value.id : command.scheduleId),
                  )?.revision ?? 0)
                : command.type === "reservation"
                  ? (current.budgets.find((row) => row.id === command.value.budgetId)
                      ?.reservationRevision ?? 0)
                  : command.type !== "budget"
                    ? current.occurrences.find(
                        (row) =>
                          row.id ===
                          (command.type === "occurrence" ? command.id : command.occurrenceId),
                      )?.revision
                    : undefined;
          if (command.type !== "budget" && command.revision !== expected)
            throw new Error("This editor is stale. Reopen it before saving.");
          if (command.type === "schedule") {
            const previous = current.schedules.find((row) => row.id === command.value.id);
            if (
              previous &&
              (previous.accountId !== command.value.accountId ||
                Math.sign(previous.amount) !== Math.sign(command.value.amount))
            )
              throw new Error("Schedule account and direction are fixed");
          }
          if (
            command.type === "generate" &&
            !current.schedules.some((row) => row.id === command.scheduleId && row.active)
          )
            throw new Error("Choose an active schedule");
          if (
            command.type === "occurrence" ||
            command.type === "pendingOccurrence" ||
            command.type === "match"
          ) {
            const occurrence = current.occurrences.find(
              (row) =>
                row.id === (command.type === "occurrence" ? command.id : command.occurrenceId),
            );
            if (!occurrence || occurrence.transactionId)
              throw new Error("Choose an unmatched occurrence");
            if (
              command.type === "occurrence" &&
              Math.sign(command.amount) !== Math.sign(occurrence.amount)
            )
              throw new Error("The estimate must keep its direction");
          }
          if (command.type === "pendingOccurrence") {
            const occurrence = current.occurrences.find((row) => row.id === command.occurrenceId);
            if (!occurrence || !command.transactionId || occurrence.transactionId)
              throw new Error("Choose an unmatched occurrence");
            put("transactions", {
              id: command.transactionId,
              accountId: occurrence.accountId,
              amount: occurrence.amount,
              date: occurrence.date,
              kind: "transaction",
              status: "pending",
              categoryId: occurrence.categoryId,
              payeeId: occurrence.payeeId,
              revision: 0,
            });
          }
          const localId =
            command.type === "budget" || command.type === "schedule"
              ? command.value.id
              : command.type === "plan" || command.type === "reservation"
                ? command.value.budgetId
                : command.type === "generate"
                  ? command.id
                  : command.type === "occurrence"
                    ? command.id
                    : command.occurrenceId;
          if (!localId) throw new Error("Missing planning identity");
          enqueue("planning", localId, command, command.operationId);
        }
        const state = projectPlanning(acceptedPlanning(), planningCommands(operations()));
        validatePlanning(
          state,
          records("accounts", Account),
          records("categories", NamedRecord),
          records("payees", NamedRecord),
          [...records("transactions", Transaction), ...deferredTransactions()],
        );
      });
    },
    catch: (cause) =>
      new LocalStorageError({
        message: cause instanceof Error ? cause.message : "Could not save budget changes",
        cause,
      }),
  });
  return yield* loadLedger();
});

export const recoverPlanning = Effect.fn("recoverPlanning")(function* (
  operationId: string,
  keepLocal: boolean,
) {
  yield* Effect.try({
    try: () => {
      if (syncing) throw new Error("Wait for synchronization to finish");
      database.withTransactionSync(() => {
        const queued = operations();
        const operation = queued.find(
          (row) => row.operationId === operationId && row.kind === "planning",
        );
        if (!operation) throw new Error("Planning operation is no longer queued");
        const command = planningCommands([operation])[0];
        if (!command) throw new Error("Missing planning operation");
        const related = queued.filter(
          (row) =>
            row.kind === "planning" &&
            planningCommands([row]).some((value) => planningKey(value) === planningKey(command)),
        );
        const server = acceptedPlanning();
        let revision =
          command.type === "plan"
            ? (server.periods.find(
                (row) =>
                  row.budgetId === command.value.budgetId && row.month === command.value.month,
              )?.revision ?? 0)
            : command.type === "schedule"
              ? (server.schedules.find((row) => row.id === command.value.id)?.revision ?? 0)
              : command.type === "reservation"
                ? (server.budgets.find((row) => row.id === command.value.budgetId)
                    ?.reservationRevision ?? 0)
                : command.type === "occurrence"
                  ? (server.occurrences.find((row) => row.id === command.id)?.revision ?? 0)
                  : 0;
        for (const row of related) {
          const value = planningCommands([row])[0];
          if (!value) throw new Error("Missing related operation");
          if (keepLocal) {
            if (
              value.type !== "plan" &&
              value.type !== "schedule" &&
              value.type !== "reservation" &&
              value.type !== "occurrence"
            )
              throw new Error("Use server, then select the payment or generation again");
            const next = { ...value, revision: revision++, operationId: randomUUID() };
            database.runSync(
              "UPDATE outbox SET operationId=?,payload=?,error=NULL WHERE operationId=?",
              next.operationId,
              JSON.stringify(next),
              row.operationId,
            );
          } else {
            if (value.type === "pendingOccurrence" && value.transactionId) {
              database.runSync(
                "DELETE FROM outbox WHERE kind='edit' AND localId=?",
                value.transactionId,
              );
              const accepted = database.getFirstSync<{ payload: string }>(
                "SELECT payload FROM accepted WHERE id=?",
                value.transactionId,
              );
              if (accepted)
                put(
                  "transactions",
                  Schema.decodeUnknownSync(Schema.fromJsonString(Transaction))(accepted.payload),
                );
              else
                database.runSync(
                  "DELETE FROM records WHERE kind='transactions' AND id=?",
                  value.transactionId,
                );
            }
            database.runSync("DELETE FROM outbox WHERE operationId=?", row.operationId);
          }
        }
        validatePlanning(
          projectPlanning(server, planningCommands(operations())),
          records("accounts", Account),
          records("categories", NamedRecord),
          records("payees", NamedRecord),
          [...records("transactions", Transaction), ...deferredTransactions()],
        );
      });
    },
    catch: (cause) =>
      new LocalStorageError({
        message: cause instanceof Error ? cause.message : "Could not recover planning change",
        cause,
      }),
  });
  return yield* loadLedger();
});
