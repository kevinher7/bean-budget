import { Schema } from "effect";
import { Currency, FinancialDate, Id, Money, Name } from "@bean-budget/budget";

export const CreateAccount = Schema.Struct({
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

export const Budget = Schema.Struct({
  id: Id,
  name: Name,
  currency: Currency,
  accountIds: Schema.Array(Id),
  startDay: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  firstMonth: Month,
  reservedScheduleIds: Schema.Array(Id),
});

export const Schedule = Schema.Struct({
  id: Id,
  accountId: Id,
  amount: Money,
  day: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  categoryId: Schema.NullOr(Id),
  payeeId: Schema.NullOr(Id),
  active: Schema.Boolean,
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
});

export const BudgetPeriod = Schema.Struct({
  budgetId: Id,
  month: Month,
  allocations: Schema.Record(Id, Money),
  incomeForecast: Schema.NullOr(Money),
});

export const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("pendingOccurrence"), operationId: Id, occurrenceId: Id }),
  Schema.Struct({ type: Schema.Literal("category"), operationId: Id, value: NamedRecord }),
  Schema.Struct({ type: Schema.Literal("payee"), operationId: Id, value: NamedRecord }),
  Schema.Struct({ type: Schema.Literal("budget"), operationId: Id, value: Budget }),
  Schema.Struct({ type: Schema.Literal("schedule"), operationId: Id, value: Schedule }),
  Schema.Struct({ type: Schema.Literal("plan"), operationId: Id, value: BudgetPeriod }),
  Schema.Struct({
    type: Schema.Literal("generate"),
    operationId: Id,
    scheduleId: Id,
    month: Month,
  }),
  Schema.Struct({ type: Schema.Literal("occurrence"), operationId: Id, id: Id, amount: Money }),
  Schema.Struct({
    type: Schema.Literal("match"),
    operationId: Id,
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

export const SummaryQuery = Schema.Struct({ budgetId: Id, month: Month });
