import { make as makeSqliteClient } from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, Layer } from "effect";
import { layerWebCrypto as secureRandomLayer } from "effect/crypto/SecureRandom";
import { layer as reactivityLayer } from "effect/reactivity/Reactivity";
import { SqlClient } from "effect/sql/SqlClient";
import { migrateTo } from "./migrations.ts";

export class LedgerError extends Error {
  readonly _tag = "LedgerError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const databaseLayer = (path: string, version = 4) =>
  Layer.merge(
    Layer.effect(
      SqlClient,
      Effect.gen(function* () {
        const sql = yield* makeSqliteClient({
          filename: path,
          disableWAL: false,
          busyTimeout: 5000,
        });
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrateTo(version).pipe(Effect.provideService(SqlClient, sql));
        return sql;
      }),
    ).pipe(Layer.provide(reactivityLayer)),
    secureRandomLayer,
  );
