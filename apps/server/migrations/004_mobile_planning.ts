import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`ALTER TABLE budgets ADD COLUMN reservationRevision INTEGER NOT NULL DEFAULT 0 CHECK(reservationRevision >= 0)`;
  yield* sql`ALTER TABLE budget_periods ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)`;
  yield* sql`ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)`;
  yield* sql`ALTER TABLE scheduled_occurrences ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)`;
  yield* sql`CREATE TABLE budget_reservations (budgetId TEXT NOT NULL REFERENCES budgets(id), month TEXT NOT NULL, scheduleIds TEXT NOT NULL, PRIMARY KEY(budgetId,month))`;
  yield* sql`INSERT INTO budget_reservations SELECT b.id,b.firstMonth,coalesce((SELECT json_group_array(scheduleId) FROM budget_reserved_schedules WHERE budgetId=b.id),'[]') FROM budgets b`;
});
