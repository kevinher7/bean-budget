import { Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto/SecureRandom";
import { SqlClient } from "effect/sql/SqlClient";
import { balance } from "@bean-budget/budget";
import {
  Account,
  CreateAccount,
  CreateTransaction,
  Transaction,
  Transactions,
  TransactionQuery,
} from "@bean-budget/protocol";
import { LedgerError } from "./database.ts";

const AccountRows = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }));

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
        currency: "JPY",
        balance: balance(history.map((t) => t.amount)),
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
      const id = yield* random.uuidV4();
      const openingId = yield* random.uuidV4();
      yield* sql`INSERT INTO accounts (id, name) VALUES (${id}, ${input.name})`;
      yield* sql`INSERT INTO transactions (id, accountId, amount, date, kind) VALUES (${openingId}, ${id}, ${input.openingBalance}, ${input.date}, 'opening')`;
      return yield* Schema.decodeUnknownEffect(Account)({
        id,
        name: input.name,
        currency: "JPY",
        balance: input.openingBalance,
      });
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
        const original = yield* Schema.decodeUnknownEffect(PayloadJson)(saved.payload);
        if (
          original.operationId !== input.operationId ||
          original.accountId !== input.accountId ||
          original.amount !== input.amount ||
          original.date !== input.date
        )
          return yield* Effect.fail(
            new LedgerError(409, "Operation ID already used with different payload"),
          );
        return yield* Schema.decodeUnknownEffect(TransactionJson)(saved.result);
      }
      yield* requireAccount(input.accountId);
      const history = yield* readTransactions(input.accountId);
      yield* Effect.try(() => balance([...history.map((t) => t.amount), input.amount])).pipe(
        Effect.catch((error) =>
          error.cause instanceof RangeError
            ? Effect.fail(new LedgerError(400, error.cause.message))
            : Effect.die(error.cause),
        ),
      );
      const id = yield* random.uuidV4();
      const result = yield* Schema.decodeUnknownEffect(Transaction)({
        id,
        accountId: input.accountId,
        amount: input.amount,
        date: input.date,
        kind: "transaction",
      });
      const encoded = yield* Schema.encodeEffect(TransactionJson)(result);
      yield* sql`INSERT INTO transactions (id, accountId, amount, date, kind) VALUES (${result.id}, ${result.accountId}, ${result.amount}, ${result.date}, ${result.kind})`;
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
