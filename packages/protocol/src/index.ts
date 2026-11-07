import { Schema } from "effect";
import { FinancialDate, Id, Money, Name } from "@bean-budget/budget";

export const CreateAccount = Schema.Struct({
  name: Name,
  openingBalance: Money,
  date: FinancialDate,
});

export const CreateTransaction = Schema.Struct({
  operationId: Id,
  accountId: Id,
  amount: Money,
  date: FinancialDate,
});

export const Transaction = Schema.Struct({
  id: Id,
  accountId: Id,
  amount: Money,
  date: FinancialDate,
  kind: Schema.Literals(["opening", "transaction"]),
});

export const Account = Schema.Struct({
  id: Id,
  name: Name,
  currency: Schema.Literal("JPY"),
  balance: Money,
});

export const TransactionQuery = Schema.Struct({
  accountId: Id,
  from: Schema.optional(FinancialDate),
  to: Schema.optional(FinancialDate),
});

export const Transactions = Schema.Array(Transaction);
