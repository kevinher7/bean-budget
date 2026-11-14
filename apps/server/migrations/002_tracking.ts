import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE accounts ADD COLUMN currency TEXT NOT NULL DEFAULT 'JPY' CHECK(currency IN ('JPY','USD'))`;
  yield* sql`ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('pending','posted'))`;
  yield* sql`ALTER TABLE transactions ADD COLUMN categoryId TEXT`;
  yield* sql`ALTER TABLE transactions ADD COLUMN payeeId TEXT`;
  yield* sql`ALTER TABLE transactions ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','mail-bean'))`;
  yield* sql`ALTER TABLE transactions ADD COLUMN notes TEXT`;
  yield* sql`ALTER TABLE transactions ADD COLUMN transferId TEXT`;
  yield* sql`ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE import_identities (identity TEXT PRIMARY KEY, transactionId TEXT NOT NULL UNIQUE REFERENCES transactions(id))`;
  yield* sql`CREATE TABLE foundation (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id))`;
});
