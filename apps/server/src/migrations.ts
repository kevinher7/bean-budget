import { MigrationError, run as runMigrations } from "@effect/sql-sqlite-node/SqliteMigrator";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import initial, { definitions } from "../migrations/001_initial_ledger.ts";

import tracking from "../migrations/002_tracking.ts";
import relationalBudget from "../migrations/003_relational_budget.ts";

// Append immutable migration modules here. This list defines supported journal entries.
const registry = [
  { id: 1, name: "initial_ledger", effect: initial },
  { id: 2, name: "tracking", effect: tracking },
  { id: 3, name: "relational_budget", effect: relationalBudget },
];

const incompatible = () =>
  new MigrationError({
    kind: "BadState",
    message: "Unrecognized or newer database schema",
  });

// Ignore formatting differences around punctuation without changing quoted values.
const normalize = (sql: string) =>
  sql.replace(/'(?:''|[^'])*'|\s+/g, (token) => (token.startsWith("'") ? token : ""));

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ name: Schema.String })),
      )(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      );
      const names = tables.map((table) => table.name);
      if (names.includes("effect_sql_migrations")) {
        // The official journal is authoritative; legacy metadata no longer restricts upgrades.
        const journal = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ migration_id: Schema.Int, name: Schema.String })),
        )(yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`);
        if (
          journal.some(
            (row, index) =>
              row.migration_id !== registry[index]?.id || row.name !== registry[index]?.name,
          )
        )
          return yield* Effect.fail(incompatible());
      } else {
        const versions = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ user_version: Schema.Int })),
        )(yield* sql`PRAGMA user_version`);
        const version = versions[0]?.user_version;
        if (version === 1) {
          if (
            names.length !== 4 ||
            !["migrations", "accounts", "transactions", "receipts"].every((name) =>
              names.includes(name),
            )
          )
            return yield* Effect.fail(incompatible());
          const legacy = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ version: Schema.Int })),
          )(yield* sql`SELECT version FROM migrations`);
          if (legacy.length !== 1 || legacy[0]?.version !== 1)
            return yield* Effect.fail(incompatible());
          const stored = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ sql: Schema.String })),
          )(
            yield* sql`SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
          );
          const expected = definitions.map(normalize);
          if (
            stored.length !== expected.length ||
            !stored.every((row) => expected.includes(normalize(row.sql)))
          )
            return yield* Effect.fail(incompatible());
          yield* sql`CREATE TABLE effect_sql_migrations (migration_id integer PRIMARY KEY NOT NULL, created_at datetime NOT NULL DEFAULT current_timestamp, name VARCHAR(255) NOT NULL)`;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'initial_ledger')`;
        } else if (version !== 0 || names.length !== 0) {
          return yield* Effect.fail(incompatible());
        }
      }
      return yield* runMigrations({
        loader: Effect.succeed(
          registry.map(({ id, name, effect }) => [id, name, Effect.succeed(effect)] as const),
        ),
      });
    }),
  );
});
