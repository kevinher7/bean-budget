import { Schema } from "effect";
import {
  balance,
  Currency,
  FinancialDate,
  Id,
  Money,
  Name,
  PlanningRhythm,
  monthStart,
  nextMonth,
  periodWeeks,
} from "@bean-budget/budget";

export const CreateAccount = Schema.Struct({
  operationId: Schema.optional(Id),
  id: Schema.optional(Id),
  name: Name,
  currency: Schema.optional(Currency),
  openingBalance: Money,
  date: FinancialDate,
});

export const CreateTransaction = Schema.Struct({
  operationId: Id,
  accountId: Id,
  amount: Money,
  date: FinancialDate,
  categoryId: Schema.optional(Id),
  payeeId: Schema.optional(Id),
  status: Schema.optional(Schema.Literals(["pending", "posted"])),
  source: Schema.optional(Schema.Literals(["manual", "mail-bean"])),
  notes: Schema.optional(Name),
  importIdentity: Schema.optional(Schema.Struct({ namespace: Name, key: Name })),
});

export const Transaction = Schema.Struct({
  id: Id,
  accountId: Id,
  amount: Money,
  date: FinancialDate,
  kind: Schema.Literals(["opening", "transaction"]),
  categoryId: Schema.optional(Schema.NullOr(Id)),
  payeeId: Schema.optional(Schema.NullOr(Id)),
  status: Schema.optional(Schema.Literals(["pending", "posted"])),
  source: Schema.optional(Schema.Literals(["manual", "mail-bean"])),
  notes: Schema.optional(Schema.NullOr(Name)),
  transferId: Schema.optional(Schema.NullOr(Id)),
  revision: Schema.optional(Schema.Int),
});

export const Account = Schema.Struct({
  id: Id,
  name: Name,
  currency: Currency,
  projectedBalance: Schema.optional(Money),
  balance: Money,
});

export const TransactionQuery = Schema.Struct({
  accountId: Id,
  from: Schema.optional(FinancialDate),
  to: Schema.optional(FinancialDate),
});

export const Transactions = Schema.Array(Transaction);

export const Month = Schema.String.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/));

export const NamedRecord = Schema.Struct({ id: Id, name: Name });

export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Budget = Schema.Struct({
  id: Id,
  name: Name,
  currency: Currency,
  accountIds: Schema.Array(Id),
  startDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  firstMonth: Month,
  reservedScheduleIds: Schema.Array(Id),
  reservationRevision: Schema.optional(Revision),
});

export const Schedule = Schema.Struct({
  id: Id,
  accountId: Id,
  amount: Money,
  day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  categoryId: Schema.NullOr(Id),
  payeeId: Schema.NullOr(Id),
  active: Schema.Boolean,
  revision: Schema.optional(Revision),
});

export const Occurrence = Schema.Struct({
  id: Id,
  scheduleId: Id,
  month: Month,
  accountId: Id,
  date: FinancialDate,
  amount: Money,
  categoryId: Schema.NullOr(Id),
  payeeId: Schema.NullOr(Id),
  transactionId: Schema.NullOr(Id),
  revision: Schema.optional(Revision),
});

const AllocationAmount = Money.check(Schema.isGreaterThanOrEqualTo(0));

export const CategoryPlans = Schema.Record(
  Id,
  Schema.Struct({
    rhythm: Schema.optional(PlanningRhythm),
    carryIn: Schema.optional(AllocationAmount),
    limits: Schema.optional(
      Schema.Record(
        FinancialDate,
        Schema.Struct({ amount: AllocationAmount, fixedFrom: FinancialDate }),
      ),
    ),
  }),
);

export const BudgetPeriod = Schema.Struct({
  budgetId: Id,
  month: Month,
  allocations: Schema.Record(Id, Money),
  categoryPlans: Schema.optional(CategoryPlans),
  incomeForecast: Schema.NullOr(Money),
  revision: Schema.optional(Revision),
});

export function validCategoryPlans(period: typeof BudgetPeriod.Type, startDay: number) {
  if (!Object.keys(period.categoryPlans ?? {}).length) return true;
  if (period.month === "9999-12") return false;
  const weeks = periodWeeks(
    monthStart(period.month, startDay),
    monthStart(nextMonth(period.month), startDay),
  );
  return Object.values(period.categoryPlans ?? {}).every(
    (setting) =>
      (setting.carryIn === undefined ||
        setting.rhythm === "weekly" ||
        setting.rhythm === "daily") &&
      Object.entries(setting.limits ?? {}).every(([start, edit]) =>
        weeks.some((week) => week.start === start && edit.fixedFrom < week.end),
      ),
  );
}

export const Reservation = Schema.Struct({
  budgetId: Id,
  month: Month,
  scheduleIds: Schema.Array(Id),
});

export const Planning = Schema.Struct({
  budgets: Schema.Array(Budget),
  schedules: Schema.Array(Schedule),
  occurrences: Schema.Array(Occurrence),
  periods: Schema.Array(BudgetPeriod),
  reservations: Schema.Array(Reservation),
});

export const Command = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("pendingOccurrence"),
    operationId: Id,
    occurrenceId: Id,
    revision: Schema.optional(Revision),
    transactionId: Schema.optional(Id),
  }),
  Schema.Struct({ type: Schema.Literal("category"), operationId: Id, value: NamedRecord }),
  Schema.Struct({ type: Schema.Literal("payee"), operationId: Id, value: NamedRecord }),
  Schema.Struct({ type: Schema.Literal("budget"), operationId: Id, value: Budget }),
  Schema.Struct({
    type: Schema.Literal("schedule"),
    operationId: Id,
    revision: Schema.optional(Revision),
    value: Schedule,
  }),
  Schema.Struct({
    type: Schema.Literal("plan"),
    operationId: Id,
    revision: Schema.optional(Revision),
    value: BudgetPeriod,
  }),
  Schema.Struct({
    type: Schema.Literal("reservation"),
    operationId: Id,
    revision: Revision,
    value: Reservation,
  }),
  Schema.Struct({
    type: Schema.Literal("generate"),
    operationId: Id,
    scheduleId: Id,
    month: Month,
    revision: Schema.optional(Revision),
    id: Schema.optional(Id),
  }),
  Schema.Struct({
    type: Schema.Literal("occurrence"),
    operationId: Id,
    id: Id,
    amount: Money,
    revision: Schema.optional(Revision),
  }),
  Schema.Struct({
    type: Schema.Literal("match"),
    operationId: Id,
    revision: Schema.optional(Revision),
    occurrenceId: Id,
    transactionId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("editTransaction"),
    operationId: Id,
    id: Id,
    revision: Schema.Int,
    status: Schema.Literals(["pending", "posted"]),
    categoryId: Schema.NullOr(Id),
    payeeId: Schema.NullOr(Id),
    notes: Schema.NullOr(Name),
  }),
  Schema.Struct({
    type: Schema.Literal("transfer"),
    operationId: Id,
    fromAccountId: Id,
    toAccountId: Id,
    outgoing: Money,
    incoming: Money,
    date: FinancialDate,
  }),
]);

export const CommandReceipt = Schema.Struct({
  accepted: Schema.Literal(true),
  occurrenceId: Schema.optional(Id),
  transactionId: Schema.optional(Id),
});

export const SummaryQuery = Schema.Struct({ budgetId: Id, month: Month });

export const RegisterSnapshot = Schema.Struct({
  accounts: Schema.Array(Account),
  categories: Schema.Array(NamedRecord),
  payees: Schema.Array(NamedRecord),
  transactions: Transactions,
  planning: Planning,
});

// Failed offline matches can compete for one payment. Exports preserve that intent; accepted snapshots remain strict.
export function validatePlanning(
  state: typeof Planning.Type,
  accounts: readonly (typeof Account.Type)[],
  categories: readonly (typeof NamedRecord.Type)[],
  payees: readonly (typeof NamedRecord.Type)[],
  transactions: readonly (typeof Transaction.Type)[],
  allowConflictingMatches = false,
) {
  for (const rows of [state.budgets, state.schedules, state.occurrences])
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new Error("Duplicate planning identity");
  for (const rows of [state.periods, state.reservations])
    if (new Set(rows.map((row) => row.budgetId + "/" + row.month)).size !== rows.length)
      throw new Error("Duplicate budget period");
  for (const schedule of state.schedules) {
    if (
      !accounts.some((row) => row.id === schedule.accountId) ||
      schedule.amount === 0 ||
      (schedule.categoryId && !categories.some((row) => row.id === schedule.categoryId)) ||
      (schedule.payeeId && !payees.some((row) => row.id === schedule.payeeId))
    )
      throw new Error("Invalid schedule reference or amount");
  }
  for (const budget of state.budgets) {
    if (
      new Set(budget.reservedScheduleIds).size !== budget.reservedScheduleIds.length ||
      !budget.reservedScheduleIds.every((id) =>
        state.schedules.some(
          (row) => row.id === id && row.amount < 0 && budget.accountIds.includes(row.accountId),
        ),
      )
    )
      throw new Error("Invalid initial reserved bills");
    if (
      !budget.accountIds.length ||
      new Set(budget.accountIds).size !== budget.accountIds.length ||
      !budget.accountIds.every((id) =>
        accounts.some((row) => row.id === id && row.currency === budget.currency),
      )
    )
      throw new Error("Invalid budget accounts");
    if (
      !state.reservations.some(
        (row) => row.budgetId === budget.id && row.month === budget.firstMonth,
      )
    )
      throw new Error("Missing initial bill selection");
  }
  for (const reservation of state.reservations) {
    const budget = state.budgets.find((row) => row.id === reservation.budgetId);
    if (
      !budget ||
      reservation.month < budget.firstMonth ||
      new Set(reservation.scheduleIds).size !== reservation.scheduleIds.length ||
      !reservation.scheduleIds.every((id) =>
        state.schedules.some(
          (row) => row.id === id && row.amount < 0 && budget.accountIds.includes(row.accountId),
        ),
      )
    )
      throw new Error("Invalid reserved bill selection");
  }
  const linked = new Set<string>();
  const generated = new Set<string>();
  for (const occurrence of state.occurrences) {
    const schedule = state.schedules.find((row) => row.id === occurrence.scheduleId);
    const key = occurrence.scheduleId + "/" + occurrence.month;
    const transaction = transactions.find((row) => row.id === occurrence.transactionId);
    if (
      !schedule ||
      generated.has(key) ||
      occurrence.accountId !== schedule.accountId ||
      occurrence.date.slice(0, 7) !== occurrence.month ||
      Math.sign(occurrence.amount) !== Math.sign(schedule.amount) ||
      (occurrence.categoryId && !categories.some((row) => row.id === occurrence.categoryId)) ||
      (occurrence.payeeId && !payees.some((row) => row.id === occurrence.payeeId)) ||
      (occurrence.transactionId &&
        (!transaction ||
          (!allowConflictingMatches && linked.has(occurrence.transactionId)) ||
          transaction.kind !== "transaction" ||
          transaction.transferId ||
          transaction.accountId !== occurrence.accountId ||
          Math.sign(transaction.amount) !== Math.sign(occurrence.amount)))
    )
      throw new Error("Invalid occurrence or payment match");
    generated.add(key);
    if (occurrence.transactionId) linked.add(occurrence.transactionId);
  }
  for (const period of state.periods) {
    const budget = state.budgets.find((row) => row.id === period.budgetId);
    if (
      !budget ||
      period.month < budget.firstMonth ||
      !validCategoryPlans(period, budget.startDay) ||
      Object.keys(period.categoryPlans ?? {}).some(
        (id) => !categories.some((row) => row.id === id),
      ) ||
      (period.incomeForecast ?? 0) < 0 ||
      !Object.entries(period.allocations).every(
        ([id, amount]) => amount >= 0 && categories.some((row) => row.id === id),
      )
    )
      throw new Error("Invalid forecast or allocation");
    balance(Object.values(period.allocations));
  }
}

export const LedgerNotification = Schema.Struct({ type: Schema.Literal("ledgerChanged") });

export const NotificationTicket = Schema.Struct({
  ticket: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});

export const MailStatus = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      connectionId: Id,
      state: Schema.Literals(["pending", "retry", "review", "ignored", "accepted"]),
      reason: Schema.NullOr(Schema.String),
      count: Schema.Int,
    }),
  ),
  runs: Schema.Array(
    Schema.Struct({
      connectionId: Id,
      generation: Schema.Int,
      startedAt: Schema.Int,
      finishedAt: Schema.NullOr(Schema.Int),
      status: Schema.String,
      reason: Schema.NullOr(Schema.String),
    }),
  ),
});

const MailMessageKey = Schema.Struct({
  connectionId: Id,
  messageId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const MailReviewAction = Schema.Union([
  Schema.Struct({ operationId: Id, message: MailMessageKey, action: Schema.Literal("ignore") }),
  Schema.Struct({ operationId: Id, message: MailMessageKey, action: Schema.Literal("import") }),
  Schema.Struct({
    operationId: Id,
    message: MailMessageKey,
    action: Schema.Literal("link"),
    transactionId: Id,
    revision: Schema.Int,
    status: Schema.Literals(["posted", "pending"]),
  }),
  Schema.Struct({
    operationId: Id,
    message: MailMessageKey,
    action: Schema.Literal("transfer"),
    toAccountId: Id,
    incoming: Money,
  }),
  Schema.Struct({
    operationId: Id,
    message: MailMessageKey,
    action: Schema.Literal("linkTransfer"),
    transactionId: Id,
  }),
]);

export const MailReviewResult = Schema.Struct({ transactionId: Schema.NullOr(Id) });

export const MailReviewQueue = Schema.Array(
  Schema.Struct({
    connectionId: Id,
    messageId: Schema.String,
    reason: Schema.NullOr(Schema.String),
    notice: Schema.NullOr(
      Schema.Struct({
        issuer: Schema.Literals(["smbc", "yucho"]),
        merchant: Name,
        approval: Schema.String,
        date: FinancialDate,
        time: Schema.String,
        amount: Money,
        currency: Schema.Literal("JPY"),
      }),
    ),
    purchase: Schema.NullOr(CreateTransaction),
    candidates: Schema.Array(Transaction),
  }),
);
