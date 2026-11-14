import { Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto/SecureRandom";
import { SqlClient } from "effect/sql/SqlClient";
import { balance, monthStart, summarizePeriods } from "@bean-budget/budget";
import {
  Account,
  Command,
  NamedRecord,
  SummaryQuery,
  CreateAccount,
  CreateTransaction,
  Transaction,
  Transactions,
  TransactionQuery,
  RegisterSnapshot,
} from "@bean-budget/protocol";
import { LedgerError } from "./database.ts";
import { readBudgets, readPeriods } from "./budgets.ts";
import { readOccurrences, readSchedules } from "./schedules.ts";

const AccountRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    currency: Schema.Literals(["JPY", "USD"]),
  }),
);

const ReceiptRows = Schema.Array(Schema.Struct({ payload: Schema.String, result: Schema.String }));

const PayloadJson = Schema.fromJsonString(CreateTransaction);

const TransactionJson = Schema.fromJsonString(Transaction);

const readTransactions = Effect.fn("Ledger.readTransactions")(function* (accountId: string) {
  const sql = yield* SqlClient;
  return yield* Schema.decodeUnknownEffect(Transactions)(
    yield* sql`SELECT * FROM transactions WHERE accountId = ${accountId} ORDER BY date, rowid`,
  );
});

const requireAccount = Effect.fn("Ledger.requireAccount")(function* (id: string) {
  const sql = yield* SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(AccountRows)(
    yield* sql`SELECT * FROM accounts WHERE id = ${id}`,
  );
  if (rows.length === 0) return yield* Effect.fail(new LedgerError(404, "Unknown account"));
});

export const accounts = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(AccountRows)(
    yield* sql`SELECT * FROM accounts ORDER BY rowid`,
  );
  return yield* Effect.forEach(rows, (account) =>
    Effect.gen(function* () {
      const history = yield* readTransactions(account.id);
      return yield* Schema.decodeUnknownEffect(Account)({
        ...account,
        balance: balance(history.filter((t) => t.status !== "pending").map((t) => t.amount)),
        projectedBalance: balance(history.map((t) => t.amount)),
      });
    }),
  );
});

export const createAccount = Effect.fn("Ledger.createAccount")(function* (
  input: typeof CreateAccount.Type,
) {
  const sql = yield* SqlClient;
  const random = yield* SecureRandom;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (input.id && !input.operationId)
        return yield* Effect.fail(new LedgerError(400, "Account ID requires an operation ID"));
      const payload = JSON.stringify({ type: "createAccount", ...input });
      if (input.operationId) {
        const receipts = yield* Schema.decodeUnknownEffect(ReceiptRows)(
          yield* sql`SELECT payload,result FROM receipts WHERE operationId=${input.operationId}`,
        );
        const saved = receipts[0];
        if (saved) {
          if (saved.payload !== payload)
            return yield* Effect.fail(
              new LedgerError(409, "Operation ID already used with different payload"),
            );
          return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Account))(saved.result);
        }
      }
      const id = input.id ?? (yield* random.uuidV4());
      if ((yield* sql`SELECT id FROM accounts WHERE id=${id}`).length)
        return yield* Effect.fail(new LedgerError(409, "Account ID already exists"));
      const openingId = yield* random.uuidV4();
      yield* sql`INSERT INTO accounts (id, name, currency) VALUES (${id}, ${input.name}, ${input.currency ?? "JPY"})`;
      yield* sql`INSERT INTO transactions (id, accountId, amount, date, kind) VALUES (${openingId}, ${id}, ${input.openingBalance}, ${input.date}, 'opening')`;
      const result = yield* Schema.decodeUnknownEffect(Account)({
        id,
        name: input.name,
        currency: input.currency ?? "JPY",
        balance: input.openingBalance,
        projectedBalance: input.openingBalance,
      });
      if (input.operationId) {
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Account))(result);
        yield* sql`INSERT INTO receipts VALUES (${input.operationId},${payload},${encoded})`;
      }
      return result;
    }),
  );
});

export const createTransaction = Effect.fn("Ledger.createTransaction")(function* (
  input: typeof CreateTransaction.Type,
) {
  const sql = yield* SqlClient;
  const random = yield* SecureRandom;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const payload = yield* Schema.encodeEffect(PayloadJson)(input);
      const receipts = yield* Schema.decodeUnknownEffect(ReceiptRows)(
        yield* sql`SELECT payload, result FROM receipts WHERE operationId = ${input.operationId}`,
      );
      const saved = receipts[0];
      if (saved) {
        if (saved.payload !== payload)
          return yield* Effect.fail(
            new LedgerError(409, "Operation ID already used with different payload"),
          );
        return yield* Schema.decodeUnknownEffect(TransactionJson)(saved.result);
      }
      yield* requireAccount(input.accountId);
      if (input.categoryId) yield* requireRecord("category", input.categoryId);
      if (input.payeeId) yield* requireRecord("payee", input.payeeId);
      if (input.importIdentity) {
        const existing =
          yield* sql`SELECT identity FROM import_identities WHERE identity = ${JSON.stringify(input.importIdentity)}`;
        if (existing.length)
          return yield* Effect.fail(new LedgerError(409, "Import identity already recorded"));
      }
      const id = yield* random.uuidV4();
      const result = yield* Schema.decodeUnknownEffect(Transaction)({
        id,
        accountId: input.accountId,
        amount: input.amount,
        date: input.date,
        kind: "transaction",
        categoryId: input.categoryId ?? null,
        payeeId: input.payeeId ?? null,
        status: input.status ?? "posted",
        source: input.source ?? "manual",
        notes: input.notes ?? null,
        revision: 0,
      });
      const encoded = yield* Schema.encodeEffect(TransactionJson)(result);
      yield* sql`INSERT INTO transactions (id,accountId,amount,date,kind,categoryId,payeeId,status,source,notes) VALUES (${id},${input.accountId},${input.amount},${input.date},'transaction',${input.categoryId ?? null},${input.payeeId ?? null},${input.status ?? "posted"},${input.source ?? "manual"},${input.notes ?? null})`;
      yield* validateBalances;
      if (input.importIdentity)
        yield* sql`INSERT INTO import_identities VALUES (${JSON.stringify(input.importIdentity)}, ${id})`;
      yield* sql`INSERT INTO receipts (operationId, payload, result) VALUES (${input.operationId}, ${payload}, ${encoded})`;
      return result;
    }),
  );
});

export const transactions = Effect.fn("Ledger.transactions")(function* (
  input: typeof TransactionQuery.Type,
) {
  yield* requireAccount(input.accountId);
  if (input.from && input.to && input.from > input.to)
    return yield* Effect.fail(new LedgerError(400, "from must not follow to"));
  return (yield* readTransactions(input.accountId)).filter(
    (t) => (!input.from || t.date >= input.from) && (!input.to || t.date <= input.to),
  );
});

export const categories = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* Schema.decodeUnknownEffect(Schema.Array(NamedRecord))(
    yield* sql`SELECT * FROM categories ORDER BY rowid`,
  );
});

export const payees = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* Schema.decodeUnknownEffect(Schema.Array(NamedRecord))(
    yield* sql`SELECT * FROM payees ORDER BY rowid`,
  );
});

const requireRecord = Effect.fn("Ledger.requireRecord")(function* (
  kind: "category" | "payee" | "budget",
  id: string,
) {
  const sql = yield* SqlClient;
  const rows =
    kind === "category"
      ? yield* sql`SELECT id FROM categories WHERE id=${id}`
      : kind === "payee"
        ? yield* sql`SELECT id FROM payees WHERE id=${id}`
        : yield* sql`SELECT id FROM budgets WHERE id=${id}`;
  if (!rows.length) return yield* Effect.fail(new LedgerError(404, "Unknown " + kind));
});

const validateBalances = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* Schema.decodeUnknownEffect(AccountRows)(yield* sql`SELECT * FROM accounts`);
  for (const account of rows) {
    const history = yield* readTransactions(account.id);
    yield* Effect.try({
      try: () => {
        balance(history.map((t) => t.amount));
        balance(history.filter((t) => t.status !== "pending").map((t) => t.amount));
      },
      catch: () => new LedgerError(400, "Balance exceeds supported units"),
    });
  }
});

function commandPayload(input: typeof Command.Type): string {
  if (input.type !== "plan") return JSON.stringify(input);
  return JSON.stringify({
    ...input,
    value: {
      ...input.value,
      allocations: Object.fromEntries(
        Object.entries(input.value.allocations).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ),
    },
  });
}

export const command = Effect.fn("Ledger.command")(function* (input: typeof Command.Type) {
  const sql = yield* SqlClient;
  const random = yield* SecureRandom;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const payload = commandPayload(input);
      const receipts = yield* Schema.decodeUnknownEffect(ReceiptRows)(
        yield* sql`SELECT payload,result FROM receipts WHERE operationId = ${input.operationId}`,
      );
      const receipt = receipts[0];
      if (receipt) {
        const original = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Command))(
          receipt.payload,
        ).pipe(
          Effect.mapError(
            () => new LedgerError(409, "Operation ID already used with different payload"),
          ),
        );
        if (commandPayload(original) !== payload)
          return yield* Effect.fail(
            new LedgerError(409, "Operation ID already used with different payload"),
          );
        if (input.type === "editTransaction" && receipt.result !== "{}")
          return {
            accepted: true,
            transaction: yield* Schema.decodeUnknownEffect(TransactionJson)(receipt.result),
          };
        return { accepted: true };
      }
      switch (input.type) {
        case "category":
        case "payee":
          if (input.value.id === "uncategorized")
            return yield* Effect.fail(new LedgerError(400, "Reserved classification ID"));
          if (input.type === "category")
            yield* sql`INSERT INTO categories (id,name) VALUES (${input.value.id},${input.value.name}) ON CONFLICT(id) DO UPDATE SET name=excluded.name`;
          else
            yield* sql`INSERT INTO payees (id,name) VALUES (${input.value.id},${input.value.name}) ON CONFLICT(id) DO UPDATE SET name=excluded.name`;
          break;
        case "schedule": {
          yield* requireAccount(input.value.accountId);
          if (input.value.categoryId) yield* requireRecord("category", input.value.categoryId);
          if (input.value.payeeId) yield* requireRecord("payee", input.value.payeeId);
          if (input.value.amount === 0)
            return yield* Effect.fail(new LedgerError(400, "Schedule amount must be nonzero"));
          const previous = (yield* readSchedules(input.value.id))[0];
          if (
            previous &&
            (previous.accountId !== input.value.accountId ||
              Math.sign(previous.amount) !== Math.sign(input.value.amount))
          )
            return yield* Effect.fail(
              new LedgerError(400, "Schedule account and direction are immutable"),
            );
          const schedule = input.value;
          yield* sql`INSERT INTO schedules (id,accountId,amount,day,categoryId,payeeId,active) VALUES (${schedule.id},${schedule.accountId},${schedule.amount},${schedule.day},${schedule.categoryId},${schedule.payeeId},${schedule.active ? 1 : 0}) ON CONFLICT(id) DO UPDATE SET amount=excluded.amount, day=excluded.day, categoryId=excluded.categoryId, payeeId=excluded.payeeId, active=excluded.active`;
          break;
        }
        case "budget": {
          const value = input.value;
          if (
            !value.accountIds.length ||
            new Set(value.accountIds).size !== value.accountIds.length
          )
            return yield* Effect.fail(new LedgerError(400, "Budget requires distinct accounts"));
          const all = yield* accounts;
          for (const id of value.accountIds)
            if (!all.some((a) => a.id === id && a.currency === value.currency))
              return yield* Effect.fail(new LedgerError(400, "Budget account currency mismatch"));
          for (const id of value.reservedScheduleIds) {
            const schedule = (yield* readSchedules(id))[0];
            if (!schedule || !value.accountIds.includes(schedule.accountId) || schedule.amount >= 0)
              return yield* Effect.fail(
                new LedgerError(400, "Reserved schedule must be an included expense"),
              );
          }
          const previous = (yield* readBudgets(value.id))[0];
          if (previous && JSON.stringify(previous) !== JSON.stringify(value))
            return yield* Effect.fail(
              new LedgerError(409, "Budget definition is immutable; create an independent budget"),
            );
          if (!previous) {
            yield* sql`INSERT INTO budgets (id,name,currency,startDay,firstMonth) VALUES (${value.id},${value.name},${value.currency},${value.startDay},${value.firstMonth})`;
            for (const accountId of value.accountIds)
              yield* sql`INSERT INTO budget_accounts VALUES (${value.id},${accountId})`;
            for (const scheduleId of new Set(value.reservedScheduleIds))
              yield* sql`INSERT INTO budget_reserved_schedules VALUES (${value.id},${scheduleId})`;
          }
          break;
        }
        case "plan": {
          yield* requireRecord("budget", input.value.budgetId);
          if (
            (input.value.incomeForecast ?? 0) < 0 ||
            Object.values(input.value.allocations).some((n) => n < 0)
          )
            return yield* Effect.fail(
              new LedgerError(400, "Forecast and allocations must be nonnegative"),
            );
          for (const id of Object.keys(input.value.allocations))
            yield* requireRecord("category", id);
          const period = input.value;
          yield* sql`INSERT INTO budget_periods (budgetId,month,incomeForecast) VALUES (${period.budgetId},${period.month},${period.incomeForecast}) ON CONFLICT(budgetId,month) DO UPDATE SET incomeForecast=excluded.incomeForecast`;
          yield* sql`DELETE FROM budget_allocations WHERE budgetId=${period.budgetId} AND month=${period.month}`;
          for (const [categoryId, amount] of Object.entries(period.allocations))
            yield* sql`INSERT INTO budget_allocations VALUES (${period.budgetId},${period.month},${categoryId},${amount})`;
          break;
        }
        case "generate": {
          const schedule = (yield* readSchedules(input.scheduleId))[0];
          if (!schedule) return yield* Effect.fail(new LedgerError(404, "Unknown schedule"));
          const id = yield* random.uuidV4();
          if (
            !(yield* readOccurrences({ scheduleId: schedule.id })).some(
              (o) => o.month === input.month,
            )
          ) {
            if (!schedule.active)
              return yield* Effect.fail(new LedgerError(400, "Inactive schedule"));
            yield* sql`INSERT INTO scheduled_occurrences (id,scheduleId,month,accountId,date,amount,categoryId,payeeId,transactionId) VALUES (${id},${schedule.id},${input.month},${schedule.accountId},${monthStart(input.month, schedule.day)},${schedule.amount},${schedule.categoryId},${schedule.payeeId},NULL)`;
          }
          break;
        }
        case "pendingOccurrence": {
          const occurrence = (yield* readOccurrences({ id: input.occurrenceId }))[0];
          if (!occurrence) return yield* Effect.fail(new LedgerError(404, "Unknown occurrence"));
          if (occurrence.transactionId)
            return yield* Effect.fail(new LedgerError(409, "Occurrence already linked"));
          const id = yield* random.uuidV4();
          yield* sql`INSERT INTO transactions (id,accountId,amount,date,kind,status,categoryId,payeeId) VALUES (${id},${occurrence.accountId},${occurrence.amount},${occurrence.date},'transaction','pending',${occurrence.categoryId},${occurrence.payeeId})`;
          yield* sql`UPDATE scheduled_occurrences SET transactionId=${id} WHERE id=${occurrence.id}`;
          break;
        }
        case "occurrence": {
          const occurrence = (yield* readOccurrences({ id: input.id }))[0];
          if (!occurrence) return yield* Effect.fail(new LedgerError(404, "Unknown occurrence"));
          if (occurrence.transactionId || Math.sign(occurrence.amount) !== Math.sign(input.amount))
            return yield* Effect.fail(
              new LedgerError(400, "Only unmatched same-sign estimates can be changed"),
            );
          yield* sql`UPDATE scheduled_occurrences SET amount=${input.amount} WHERE id=${occurrence.id}`;
          break;
        }
        case "match": {
          const occurrence = (yield* readOccurrences({ id: input.occurrenceId }))[0];
          if (!occurrence) return yield* Effect.fail(new LedgerError(404, "Unknown occurrence"));
          const history = yield* readTransactions(occurrence.accountId);
          const transaction = history.find((t) => t.id === input.transactionId);
          if (
            !transaction ||
            transaction.kind !== "transaction" ||
            transaction.transferId ||
            Math.sign(transaction.amount) !== Math.sign(occurrence.amount)
          )
            return yield* Effect.fail(
              new LedgerError(400, "Match requires same-account same-sign ordinary transaction"),
            );
          if (
            occurrence.transactionId ||
            (yield* sql`SELECT id FROM scheduled_occurrences WHERE transactionId=${transaction.id}`)
              .length > 0
          )
            return yield* Effect.fail(
              new LedgerError(409, "Occurrence or transaction already matched"),
            );
          yield* sql`UPDATE scheduled_occurrences SET transactionId=${transaction.id} WHERE id=${occurrence.id}`;
          break;
        }
        case "editTransaction": {
          const rows = yield* Schema.decodeUnknownEffect(Transactions)(
            yield* sql`SELECT * FROM transactions WHERE id = ${input.id}`,
          );
          const transaction = rows[0];
          if (!transaction) return yield* Effect.fail(new LedgerError(404, "Unknown transaction"));
          if (transaction.revision !== input.revision)
            return yield* Effect.fail(new LedgerError(409, "Stale transaction revision"));
          if (
            transaction.kind !== "transaction" ||
            transaction.transferId ||
            (transaction.status === "posted" && input.status === "pending")
          )
            return yield* Effect.fail(new LedgerError(400, "Unsupported transaction edit"));
          if (input.categoryId) yield* requireRecord("category", input.categoryId);
          if (input.payeeId) yield* requireRecord("payee", input.payeeId);
          yield* sql`UPDATE transactions SET status=${input.status}, categoryId=${input.categoryId}, payeeId=${input.payeeId}, notes=${input.notes}, revision=revision+1 WHERE id=${input.id}`;
          break;
        }
        case "transfer": {
          const all = yield* accounts;
          const from = all.find((a) => a.id === input.fromAccountId);
          const to = all.find((a) => a.id === input.toAccountId);
          if (!from || !to)
            return yield* Effect.fail(new LedgerError(404, "Unknown transfer account"));
          if (
            from.id === to.id ||
            input.outgoing >= 0 ||
            input.incoming <= 0 ||
            (from.currency === to.currency && input.outgoing !== -input.incoming)
          )
            return yield* Effect.fail(new LedgerError(400, "Invalid transfer amounts or accounts"));
          const transferId = yield* random.uuidV4();
          for (const [accountId, amount] of [
            [from.id, input.outgoing],
            [to.id, input.incoming],
          ] as const) {
            const id = yield* random.uuidV4();
            yield* sql`INSERT INTO transactions (id,accountId,amount,date,kind,transferId) VALUES (${id},${accountId},${amount},${input.date},'transaction',${transferId})`;
          }
          break;
        }
      }
      yield* validateBalances;
      if (input.type === "editTransaction") {
        const rows = yield* Schema.decodeUnknownEffect(Transactions)(
          yield* sql`SELECT * FROM transactions WHERE id=${input.id}`,
        );
        const transaction = rows[0];
        if (!transaction) return yield* Effect.fail(new LedgerError(404, "Unknown transaction"));
        const encoded = yield* Schema.encodeEffect(TransactionJson)(transaction);
        yield* sql`INSERT INTO receipts VALUES (${input.operationId},${payload},${encoded})`;
        return { accepted: true, transaction };
      }
      yield* sql`INSERT INTO receipts VALUES (${input.operationId},${payload},'{}')`;
      return { accepted: true };
    }),
  );
});

export const summary = Effect.fn("Ledger.summary")(function* (input: typeof SummaryQuery.Type) {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const budget = (yield* readBudgets(input.budgetId))[0];
      if (!budget) return yield* Effect.fail(new LedgerError(404, "Unknown budget"));
      if (input.month < budget.firstMonth)
        return yield* Effect.fail(new LedgerError(400, "Month precedes budget"));
      const history = (yield* Effect.forEach(budget.accountIds, readTransactions)).flat();
      const occurrences = yield* readOccurrences({ accountIds: budget.accountIds });
      const plans = yield* readPeriods(budget.id, input.month, budget.firstMonth);
      return yield* Effect.try({
        try: () => {
          return summarizePeriods(budget, input.month, history, { occurrences, plans });
        },
        catch: () => new LedgerError(400, "Summary exceeds supported amounts or date range"),
      });
    }),
  );
});

export const registerSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      return yield* Schema.decodeUnknownEffect(RegisterSnapshot)({
        accounts: yield* accounts,
        categories: yield* categories,
        payees: yield* payees,
        transactions: yield* Schema.decodeUnknownEffect(Transactions)(
          yield* sql`SELECT * FROM transactions ORDER BY date,rowid`,
        ),
      });
    }),
  );
});
