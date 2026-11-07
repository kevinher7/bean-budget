import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Occurrence, Schedule } from "@bean-budget/protocol";

export const readSchedules = Effect.fn("Schedules.read")(function* (id?: string) {
  const sql = yield* SqlClient;
  const rows =
    id === undefined
      ? yield* sql`SELECT * FROM schedules ORDER BY rowid`
      : yield* sql`SELECT * FROM schedules WHERE id=${id}`;
  const stored = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        accountId: Schema.String,
        amount: Schema.Number,
        day: Schema.Number,
        categoryId: Schema.NullOr(Schema.String),
        payeeId: Schema.NullOr(Schema.String),
        active: Schema.Literals([0, 1]),
      }),
    ),
  )(rows);
  return yield* Schema.decodeUnknownEffect(Schema.Array(Schedule))(
    stored.map((s) => ({ ...s, active: s.active === 1 })),
  );
});

export const readOccurrences = Effect.fn("Schedules.readOccurrences")(function* (
  filter: { id?: string; scheduleId?: string; accountIds?: readonly string[] } = {},
) {
  const sql = yield* SqlClient;
  const rows =
    filter.id !== undefined
      ? yield* sql`SELECT * FROM scheduled_occurrences WHERE id=${filter.id}`
      : filter.scheduleId !== undefined
        ? yield* sql`SELECT * FROM scheduled_occurrences WHERE scheduleId=${filter.scheduleId} ORDER BY date,rowid`
        : filter.accountIds !== undefined
          ? yield* sql`SELECT * FROM scheduled_occurrences WHERE accountId IN ${sql.in(filter.accountIds)} ORDER BY date,rowid`
          : yield* sql`SELECT * FROM scheduled_occurrences ORDER BY date,rowid`;
  return yield* Schema.decodeUnknownEffect(Schema.Array(Occurrence))(rows);
});
