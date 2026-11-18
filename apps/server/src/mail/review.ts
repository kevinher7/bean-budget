import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  CreateTransaction,
  MailReviewAction,
  MailReviewQueue,
  MailReviewResult,
  Transaction,
} from "@bean-budget/protocol";
import { LedgerError } from "../database.ts";
import { accounts, command, createTransaction } from "../ledger.ts";
import { Notifications } from "../notifications.ts";

const ReviewJson = Schema.fromJsonString(MailReviewAction);
const ResultJson = Schema.fromJsonString(MailReviewResult);
const TransactionCommandJson = Schema.fromJsonString(CreateTransaction);

export const reviewMail = Effect.fn("Mail.review")(function* (input: typeof MailReviewAction.Type) {
  const sql = yield* SqlClient;
  const notifications = yield* Notifications;
  const payload = yield* Schema.encodeEffect(ReviewJson)(input);
  const { connectionId, messageId } = input.message;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const receipts = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            payload: Schema.String,
            result: Schema.String,
          }),
        ),
      )(
        yield* sql`SELECT payload,result FROM mail_review_receipts WHERE operationId=${input.operationId}`,
      );
      const receipt = receipts[0];
      if (receipt) {
        if (receipt.payload !== payload)
          return yield* Effect.fail(new LedgerError(409, "Review operation already used"));
        return yield* Schema.decodeUnknownEffect(ResultJson)(receipt.result);
      }

      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            state: Schema.String,
            command: Schema.NullOr(Schema.String),
          }),
        ),
      )(
        yield* sql`SELECT state,command FROM mail_messages WHERE connectionId=${connectionId} AND messageId=${messageId}`,
      );
      const message = rows[0];
      if (!message) return yield* Effect.fail(new LedgerError(404, "Unknown mail message"));
      if (message.state !== "review")
        return yield* Effect.fail(new LedgerError(409, "Message is no longer awaiting review"));

      let transactionId: string | null = null;
      if (input.action !== "ignore") {
        if (!message.command)
          return yield* Effect.fail(
            new LedgerError(409, "Message has no validated account mapping"),
          );
        const purchase = yield* Schema.decodeUnknownEffect(TransactionCommandJson)(message.command);
        const identity = purchase.importIdentity;
        if (!identity)
          return yield* Effect.fail(new LedgerError(409, "Message has no import identity"));
        const account = (yield* accounts).find((row) => row.id === purchase.accountId);
        if (account?.currency !== "JPY")
          return yield* Effect.fail(new LedgerError(409, "Mapped account must use JPY"));

        switch (input.action) {
          case "import":
            transactionId = (yield* createTransaction(purchase)).id;
            break;
          case "transfer": {
            const operationId =
              "mail-transfer-" + createHash("sha256").update(purchase.operationId).digest("hex");
            const result = yield* command({
              type: "transfer",
              operationId,
              date: purchase.date,
              fromAccountId: purchase.accountId,
              toAccountId: input.toAccountId,
              outgoing: purchase.amount,
              incoming: input.incoming,
            });
            if (!("transactionId" in result) || !result.transactionId)
              return yield* Effect.fail(new LedgerError(409, "Transfer has no outgoing leg"));
            transactionId = result.transactionId;
            yield* sql`UPDATE transactions SET source='mail-bean' WHERE transferId=(SELECT transferId FROM transactions WHERE id=${transactionId})`;
            break;
          }
          case "link":
          case "linkTransfer": {
            const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(Transaction))(
              yield* sql`SELECT * FROM transactions WHERE id=${input.transactionId}`,
            );
            const candidate = candidates[0];
            if (
              !candidate ||
              candidate.kind !== "transaction" ||
              candidate.accountId !== purchase.accountId ||
              candidate.amount !== purchase.amount
            )
              return yield* Effect.fail(
                new LedgerError(409, "Transaction no longer matches this message"),
              );
            if (input.action === "link") {
              if (
                candidate.transferId ||
                candidate.source !== "manual" ||
                candidate.status !== input.status ||
                candidate.revision !== input.revision
              )
                return yield* Effect.fail(new LedgerError(409, "Manual transaction changed"));
              const scheduled =
                yield* sql`SELECT transactionId FROM scheduled_occurrences WHERE transactionId=${candidate.id}`;
              if (scheduled.length)
                return yield* Effect.fail(
                  new LedgerError(409, "Scheduled payments require separate reconciliation"),
                );
            } else if (!candidate.transferId || candidate.status !== "posted") {
              return yield* Effect.fail(
                new LedgerError(409, "Select a posted outgoing transfer leg"),
              );
            }
            transactionId = candidate.id;
            break;
          }
        }
        if (input.action !== "import") {
          const encodedIdentity = JSON.stringify(identity);
          const used =
            yield* sql`SELECT transactionId FROM import_identities WHERE identity=${encodedIdentity}`;
          if (used.length)
            return yield* Effect.fail(new LedgerError(409, "Mail identity already accepted"));
          yield* sql`INSERT INTO import_identities VALUES (${encodedIdentity},${transactionId})`;
        }
      }
      const result = { transactionId };
      yield* sql`UPDATE mail_messages SET state=${transactionId ? "accepted" : "ignored"}, transactionId=${transactionId} WHERE connectionId=${connectionId} AND messageId=${messageId}`;
      const encoded = yield* Schema.encodeEffect(ResultJson)(result);
      yield* sql`INSERT INTO mail_review_receipts (operationId,payload,result) VALUES (${input.operationId},${payload},${encoded})`;
      if (transactionId) yield* sql.afterCommit(notifications.changed);
      return result;
    }),
  );
});

export const mailReviewQueue = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql`
      SELECT m.connectionId,m.messageId,m.reason,
        CASE WHEN json_extract(m.provenance,'$.kind')='parsed' THEN m.provenance END AS notice,
        m.command AS purchase
      FROM mail_messages m
      WHERE m.state='review'
      ORDER BY m.connectionId,m.messageId
      LIMIT 100
    `;
      const pending = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            connectionId: Schema.String,
            messageId: Schema.String,
            reason: Schema.NullOr(Schema.String),
            notice: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
            purchase: Schema.NullOr(TransactionCommandJson),
          }),
        ),
      )(rows);
      const result = [];
      for (const item of pending) {
        const purchase = item.purchase;
        const candidates = purchase
          ? yield* sql`
        SELECT t.* FROM transactions t
        WHERE t.accountId=${purchase.accountId} AND t.amount=${purchase.amount}
          AND t.kind='transaction' AND t.date=${purchase.date}
          AND (t.transferId IS NOT NULL OR
            (t.source='manual' AND NOT EXISTS (
              SELECT 1 FROM scheduled_occurrences o WHERE o.transactionId=t.id
            )))
        ORDER BY t.id
      `
          : [];
        result.push({ ...item, candidates });
      }
      return yield* Schema.decodeUnknownEffect(MailReviewQueue)(result);
    }),
  );
});
