import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE expanded_import_identities (
    identity TEXT PRIMARY KEY NOT NULL,
    transactionId TEXT NOT NULL REFERENCES transactions(id)
  )`;
  yield* sql`INSERT INTO expanded_import_identities SELECT identity,transactionId FROM import_identities`;
  yield* sql`DROP TABLE import_identities`;
  yield* sql`ALTER TABLE expanded_import_identities RENAME TO import_identities`;
  yield* sql`CREATE INDEX import_identities_transaction ON import_identities(transactionId)`;
  yield* sql`CREATE TABLE mail_review_receipts (
    operationId TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    result TEXT NOT NULL
  )`;
});
