import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

// These explicit statements also identify the legacy schema during one-time adoption.
export const definitions = [
  `CREATE TABLE migrations (version INTEGER PRIMARY KEY)`,
  `CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK (amount BETWEEN -1000000000000 AND 1000000000000),
    date TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('opening', 'transaction'))
  )`,
  `CREATE INDEX transactions_account_date ON transactions(accountId, date)`,
  `CREATE TABLE receipts (operationId TEXT PRIMARY KEY, payload TEXT NOT NULL, result TEXT NOT NULL)`,
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  for (const statement of definitions) yield* sql.unsafe(statement);
  yield* sql`INSERT INTO migrations (version) VALUES (1)`;
  yield* sql`PRAGMA user_version = 1`;
});
