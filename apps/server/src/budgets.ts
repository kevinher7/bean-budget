import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { PlanningRhythm } from "@bean-budget/budget";
import { Budget, BudgetPeriod, Reservation } from "@bean-budget/protocol";

export const readBudgets = Effect.fn("Budgets.read")(function* (id?: string) {
  const sql = yield* SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        currency: Schema.String,
        startDay: Schema.Int,
        firstMonth: Schema.String,
        reservationRevision: Schema.Int,
      }),
    ),
  )(
    id === undefined
      ? yield* sql`SELECT * FROM budgets ORDER BY rowid`
      : yield* sql`SELECT * FROM budgets WHERE id=${id}`,
  );
  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const accountIds = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ accountId: Schema.String })),
      )(yield* sql`SELECT accountId FROM budget_accounts WHERE budgetId=${row.id} ORDER BY rowid`);
      const schedules = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ scheduleId: Schema.String })),
      )(
        yield* sql`SELECT scheduleId FROM budget_reserved_schedules WHERE budgetId=${row.id} ORDER BY rowid`,
      );
      return yield* Schema.decodeUnknownEffect(Budget)({
        ...row,
        accountIds: accountIds.map((a) => a.accountId),
        reservedScheduleIds: schedules.map((s) => s.scheduleId),
      });
    }),
  );
});

export const readPeriods = Effect.fn("Budgets.readPeriods")(function* (
  budgetId: string,
  throughMonth: string,
  fromMonth = "0000-01",
) {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            budgetId: Schema.String,
            month: Schema.String,
            incomeForecast: Schema.NullOr(Schema.Number),
            revision: Schema.Int,
          }),
        ),
      )(
        yield* sql`SELECT * FROM budget_periods WHERE budgetId=${budgetId} AND month BETWEEN ${fromMonth} AND ${throughMonth} ORDER BY month`,
      );
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const allocations = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ categoryId: Schema.String, amount: Schema.Number })),
          )(
            yield* sql`SELECT categoryId,amount FROM budget_allocations WHERE budgetId=${row.budgetId} AND month=${row.month}`,
          );
          const settings = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                categoryId: Schema.String,
                rhythm: Schema.NullOr(PlanningRhythm),
                carryIn: Schema.NullOr(Schema.Int),
              }),
            ),
          )(
            yield* sql`SELECT categoryId, rhythm, carryIn FROM budget_category_plans WHERE budgetId=${budgetId} AND month=${row.month}`,
          );
          const limits = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({
                categoryId: Schema.String,
                start: Schema.String,
                fixedFrom: Schema.String,
                amount: Schema.Int,
              }),
            ),
          )(
            yield* sql`SELECT categoryId, start, fixedFrom, amount FROM budget_week_limits WHERE budgetId=${budgetId} AND month=${row.month}`,
          );
          return yield* Schema.decodeUnknownEffect(BudgetPeriod)({
            ...row,
            ...(settings.length
              ? {
                  categoryPlans: Object.fromEntries(
                    settings.map((setting) => [
                      setting.categoryId,
                      {
                        ...(setting.rhythm === null ? {} : { rhythm: setting.rhythm }),
                        ...(setting.carryIn === null ? {} : { carryIn: setting.carryIn }),
                        limits: Object.fromEntries(
                          limits
                            .filter((limit) => limit.categoryId === setting.categoryId)
                            .map((limit) => [
                              limit.start,
                              { amount: limit.amount, fixedFrom: limit.fixedFrom },
                            ]),
                        ),
                      },
                    ]),
                  ),
                }
              : {}),
            allocations: Object.fromEntries(allocations.map((a) => [a.categoryId, a.amount])),
          });
        }),
      );
    }),
  );
});

export const readReservations = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        ...Reservation.fields,
        scheduleIds: Schema.fromJsonString(Reservation.fields.scheduleIds),
      }),
    ),
  )(yield* sql`SELECT * FROM budget_reservations ORDER BY budgetId,month`);
});
