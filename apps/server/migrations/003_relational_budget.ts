import { Effect, Schema } from "effect";
import { MigrationError } from "@effect/sql-sqlite-node/SqliteMigrator";
import { SqlClient } from "effect/sql/SqlClient";
import { Budget, BudgetPeriod, NamedRecord, Occurrence, Schedule } from "@bean-budget/protocol";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["category", "payee", "budget", "plan", "schedule", "occurrence"]),
        id: Schema.String,
        value: Schema.String,
      }),
    ),
  )(yield* sql`SELECT * FROM foundation ORDER BY rowid`);
  for (const row of rows) {
    switch (row.kind) {
      case "category":
      case "payee":
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(NamedRecord))(row.value);
        break;
      case "budget":
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Budget))(row.value);
        break;
      case "plan": {
        const period = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BudgetPeriod))(
          row.value,
        );
        if (row.id !== period.budgetId + "_" + period.month)
          return yield* Effect.fail(
            new MigrationError({ kind: "BadState", message: "Stored period identity mismatch" }),
          );
        break;
      }
      case "schedule":
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schedule))(row.value);
        break;
      case "occurrence":
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Occurrence))(row.value);
        break;
    }
    const value = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
    )(row.value);
    if (value.id !== row.id)
      return yield* Effect.fail(
        new MigrationError({ kind: "BadState", message: "Stored record identity mismatch" }),
      );
  }
  yield* sql`CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200))`;
  yield* sql`CREATE TABLE payees (id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200))`;
  yield* sql`INSERT INTO categories SELECT id,json_extract(value,'$.name') FROM foundation WHERE kind='category'`;
  yield* sql`INSERT INTO payees SELECT id,json_extract(value,'$.name') FROM foundation WHERE kind='payee'`;
  yield* sql`CREATE TABLE transactions_next (
    id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000),
    date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('opening','transaction')),
    status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('pending','posted')),
    categoryId TEXT REFERENCES categories(id), payeeId TEXT REFERENCES payees(id),
    source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','mail-bean')),
    notes TEXT, transferId TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
  )`;
  yield* sql`INSERT INTO transactions_next SELECT * FROM transactions ORDER BY rowid`;
  yield* sql`CREATE TABLE import_identities_next (identity TEXT PRIMARY KEY, transactionId TEXT NOT NULL UNIQUE REFERENCES transactions_next(id))`;
  yield* sql`INSERT INTO import_identities_next SELECT * FROM import_identities`;
  yield* sql`DROP TABLE import_identities`;
  yield* sql`DROP TABLE transactions`;
  yield* sql`ALTER TABLE transactions_next RENAME TO transactions`;
  yield* sql`ALTER TABLE import_identities_next RENAME TO import_identities`;
  yield* sql`CREATE INDEX transactions_account_date ON transactions(accountId,date)`;
  yield* sql`CREATE TABLE schedules (
    id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000 AND amount != 0),
    day INTEGER NOT NULL CHECK(day BETWEEN 1 AND 31),
    categoryId TEXT REFERENCES categories(id), payeeId TEXT REFERENCES payees(id),
    active INTEGER NOT NULL CHECK(active IN (0,1))
  )`;
  yield* sql`INSERT INTO schedules SELECT id,json_extract(value,'$.accountId'),json_extract(value,'$.amount'),json_extract(value,'$.day'),json_extract(value,'$.categoryId'),json_extract(value,'$.payeeId'),json_extract(value,'$.active') FROM foundation WHERE kind='schedule'`;
  yield* sql`CREATE TABLE scheduled_occurrences (
    id TEXT PRIMARY KEY, scheduleId TEXT NOT NULL REFERENCES schedules(id), month TEXT NOT NULL,
    accountId TEXT NOT NULL REFERENCES accounts(id), date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount BETWEEN -1000000000000 AND 1000000000000 AND amount != 0),
    categoryId TEXT REFERENCES categories(id), payeeId TEXT REFERENCES payees(id),
    transactionId TEXT UNIQUE REFERENCES transactions(id), UNIQUE(scheduleId,month)
  )`;
  yield* sql`INSERT INTO scheduled_occurrences SELECT id,json_extract(value,'$.scheduleId'),json_extract(value,'$.month'),json_extract(value,'$.accountId'),json_extract(value,'$.date'),json_extract(value,'$.amount'),json_extract(value,'$.categoryId'),json_extract(value,'$.payeeId'),json_extract(value,'$.transactionId') FROM foundation WHERE kind='occurrence'`;
  yield* sql`CREATE INDEX occurrences_account_date ON scheduled_occurrences(accountId,date)`;
  yield* sql`CREATE TABLE budgets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
    currency TEXT NOT NULL CHECK(currency IN ('JPY','USD')),
    startDay INTEGER NOT NULL CHECK(startDay BETWEEN 1 AND 31), firstMonth TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO budgets SELECT id,json_extract(value,'$.name'),json_extract(value,'$.currency'),json_extract(value,'$.startDay'),json_extract(value,'$.firstMonth') FROM foundation WHERE kind='budget'`;
  yield* sql`CREATE TABLE budget_accounts (budgetId TEXT NOT NULL REFERENCES budgets(id), accountId TEXT NOT NULL REFERENCES accounts(id), PRIMARY KEY(budgetId,accountId))`;
  yield* sql`INSERT INTO budget_accounts SELECT f.id,j.value FROM foundation f,json_each(f.value,'$.accountIds') j WHERE f.kind='budget'`;
  yield* sql`CREATE TABLE budget_reserved_schedules (budgetId TEXT NOT NULL REFERENCES budgets(id), scheduleId TEXT NOT NULL REFERENCES schedules(id), PRIMARY KEY(budgetId,scheduleId))`;
  yield* sql`INSERT INTO budget_reserved_schedules SELECT f.id,j.value FROM foundation f,json_each(f.value,'$.reservedScheduleIds') j WHERE f.kind='budget' GROUP BY f.id,j.value ORDER BY f.rowid,min(CAST(j.key AS INTEGER))`;
  yield* sql`CREATE TABLE budget_periods (
    budgetId TEXT NOT NULL REFERENCES budgets(id), month TEXT NOT NULL,
    incomeForecast INTEGER CHECK(incomeForecast BETWEEN 0 AND 1000000000000), PRIMARY KEY(budgetId,month)
  )`;
  yield* sql`INSERT INTO budget_periods SELECT json_extract(value,'$.budgetId'),json_extract(value,'$.month'),json_extract(value,'$.incomeForecast') FROM foundation WHERE kind='plan'`;
  yield* sql`CREATE TABLE budget_allocations (
    budgetId TEXT NOT NULL, month TEXT NOT NULL, categoryId TEXT NOT NULL REFERENCES categories(id),
    amount INTEGER NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000), PRIMARY KEY(budgetId,month,categoryId),
    FOREIGN KEY(budgetId,month) REFERENCES budget_periods(budgetId,month)
  )`;
  yield* sql`INSERT INTO budget_allocations SELECT json_extract(f.value,'$.budgetId'),json_extract(f.value,'$.month'),j.key,j.value FROM foundation f,json_each(f.value,'$.allocations') j WHERE f.kind='plan'`;
  const violations = yield* sql`PRAGMA foreign_key_check`;
  if (violations.length)
    return yield* Effect.fail(
      new MigrationError({ kind: "BadState", message: "Migrated budget references are invalid" }),
    );
  yield* sql`DROP TABLE foundation`;
});
