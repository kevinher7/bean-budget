import { Data, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { balance, parseMoney, Currency } from "@bean-budget/budget";
import {
  Account,
  Command,
  CreateAccount,
  CreateTransaction,
  NamedRecord,
  Transaction,
  Transactions,
  RegisterSnapshot,
} from "@bean-budget/protocol";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { randomUUID } from "expo-crypto";
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
      if (version === 3) return;
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
    version: 1 as const,
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
  return yield* Effect.try({
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
          const error = edits.find((operation) => operation.error)?.error;
          return {
            ...row,
            syncStatus: error
              ? ("failed" as const)
              : edits.length
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
      return {
        accounts,
        transactions,
        categories: records("categories", NamedRecord),
        payees: records("payees", NamedRecord),
        pending: queued.length,
        failed: queued.filter((row) => row.error).length,
      };
    },
    catch: (cause) => new LocalStorageError({ message: "Could not read local ledger", cause }),
  });
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

function mergeSnapshot(snapshot: typeof Snapshot.Type) {
  const queued = operations();
  for (const transaction of snapshot.transactions) {
    // A lost create acknowledgement may already be in this snapshot under its server ID.
    const unresolvedCreate = queued.some(
      (operation) =>
        operation.kind === "create" &&
        Schema.decodeUnknownSync(Schema.fromJsonString(CreateTransaction))(operation.payload)
          .accountId === transaction.accountId,
    );
    if (unresolvedCreate) continue;
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
                : `/transactions/${operation.localId}`;
      const result = yield* request(
        connection,
        operation.kind === "edit" ? "PUT" : "POST",
        path,
        payload,
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
      yield* Effect.try(() =>
        database.withTransactionSync(() => {
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
    yield* Effect.try(() => database.withTransactionSync(() => mergeSnapshot(snapshot)));
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
