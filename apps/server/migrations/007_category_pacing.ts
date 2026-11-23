import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE budget_category_plans (
    budgetId TEXT NOT NULL, month TEXT NOT NULL, categoryId TEXT NOT NULL REFERENCES categories(id),
    rhythm TEXT CHECK(rhythm IN ('monthly','weekly','daily')),
    carryIn INTEGER CHECK(carryIn BETWEEN 0 AND 1000000000000),
    PRIMARY KEY(budgetId, month, categoryId),
    FOREIGN KEY(budgetId, month) REFERENCES budget_periods(budgetId, month)
  )`;
  yield* sql`CREATE TABLE budget_week_limits (
    budgetId TEXT NOT NULL, month TEXT NOT NULL, categoryId TEXT NOT NULL,
    start TEXT NOT NULL, fixedFrom TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount BETWEEN 0 AND 1000000000000),
    PRIMARY KEY(budgetId, month, categoryId, start),
    FOREIGN KEY(budgetId, month, categoryId) REFERENCES budget_category_plans(budgetId, month, categoryId) ON DELETE CASCADE
  )`;
});
