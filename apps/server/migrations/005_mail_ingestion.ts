import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE mail_connections (
    connectionId TEXT PRIMARY KEY NOT NULL,
    historyId TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    leaseUntil INTEGER NOT NULL CHECK (leaseUntil >= 0)
  )`;
  yield* sql`CREATE TABLE mail_runs (
    connectionId TEXT NOT NULL REFERENCES mail_connections(connectionId),
    generation INTEGER NOT NULL,
    startedAt INTEGER NOT NULL,
    finishedAt INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running','complete','failed','blocked','expired')),
    reason TEXT,
    PRIMARY KEY (connectionId, generation)
  )`;
  yield* sql`CREATE TABLE mail_messages (
    connectionId TEXT NOT NULL REFERENCES mail_connections(connectionId),
    messageId TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','retry','review','ignored','accepted')),
    reason TEXT,
    provenance TEXT CHECK (provenance IS NULL OR json_valid(provenance)),
    command TEXT CHECK (command IS NULL OR json_valid(command)),
    transactionId TEXT REFERENCES transactions(id),
    PRIMARY KEY (connectionId, messageId),
    CHECK ((state = 'accepted') = (transactionId IS NOT NULL))
  )`;
  yield* sql`CREATE INDEX mail_messages_work ON mail_messages(connectionId,state,messageId)`;
});
