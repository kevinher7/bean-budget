import { Data, Effect, Schema } from "effect";
import { balance } from "@bean-budget/budget";
import { CreateTransaction, Transactions } from "@bean-budget/protocol";
import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { randomUUID } from "expo-crypto";

class LocalStorageError extends Data.TaggedError("LocalStorageError")<{
  message: string;
  cause?: unknown;
}> {}

// One connection, synchronous native transactions: no asynchronous interleaving inside a write.
// Owned for the application process lifetime; Android closes it at process exit.
let database: SQLiteDatabase;

export const initialize = Effect.try({
  try: () => {
    database = openDatabaseSync("bean-budget.sqlite");
    database.execSync(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    database.withTransactionSync(() => {
      const version = database.getFirstSync<{ user_version: number }>("PRAGMA user_version");
      if (version?.user_version === 1) return;
      if (version?.user_version !== 0)
        throw new LocalStorageError({ message: "Unsupported local database version" });
      database.execSync(`
        CREATE TABLE transactions (
          id TEXT PRIMARY KEY, accountId TEXT NOT NULL, amount INTEGER NOT NULL,
          date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind = 'transaction')
        );
        CREATE TABLE outbox (
          operationId TEXT PRIMARY KEY, payload TEXT NOT NULL,
          transactionId TEXT NOT NULL UNIQUE REFERENCES transactions(id)
        );
        PRAGMA user_version = 1;
      `);
    });
  },
  catch: (cause) => new LocalStorageError({ message: "Could not initialize local storage", cause }),
});

export const loadLedger = Effect.fn("loadLedger")(function* () {
  const rows = yield* Effect.try(() =>
    database.getAllSync(
      "SELECT id, accountId, amount, date, kind FROM transactions ORDER BY date DESC, rowid DESC",
    ),
  );
  const transactions = yield* Schema.decodeUnknownEffect(Transactions)(rows);
  const total = yield* Effect.try(() => balance(transactions.map((row) => row.amount)));
  const pending = yield* Effect.try(() =>
    database.getFirstSync<{ count: number }>("SELECT count(*) AS count FROM outbox"),
  );
  return { transactions, total, pending: pending?.count ?? 0 };
});

export const saveTransaction = Effect.fn("saveTransaction")(function* (
  amount: string,
  date: string,
) {
  if (!/^-?\d+$/.test(amount))
    return yield* Effect.fail(new LocalStorageError({ message: "Enter signed whole yen" }));
  const command = yield* Schema.decodeUnknownEffect(CreateTransaction)({
    operationId: randomUUID(),
    accountId: "local-cash",
    amount: Number(amount),
    date,
  });
  const id = randomUUID();
  yield* Effect.try(() =>
    database.withTransactionSync(() => {
      const rows = Schema.decodeUnknownSync(Transactions)(
        database.getAllSync("SELECT id, accountId, amount, date, kind FROM transactions"),
      );
      balance([...rows.map((row) => row.amount), command.amount]);
      database.runSync(
        "INSERT INTO transactions VALUES (?, ?, ?, ?, 'transaction')",
        id,
        command.accountId,
        command.amount,
        command.date,
      );
      database.runSync(
        "INSERT INTO outbox VALUES (?, ?, ?)",
        command.operationId,
        JSON.stringify(command),
        id,
      );
    }),
  );
  return yield* loadLedger();
});
