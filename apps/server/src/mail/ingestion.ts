import { createHash } from "node:crypto";
import { Clock, Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { FinancialDate, Id, Name } from "@bean-budget/budget";
import { CreateTransaction } from "@bean-budget/protocol";
import { createTransaction } from "../ledger.ts";
import { Notifications } from "../notifications.ts";
import { type GmailAdapter } from "./gmail.ts";
import { issuerDomain, matchesMailHeaders, normalizeMerchant, parseMail } from "./parser.ts";

const HistoryId = Schema.String.check(Schema.isPattern(/^\d{1,100}$/));

const MessageId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,200}$/));

const FrozenCommand = Schema.fromJsonString(CreateTransaction);

export const MailIngestionConfig = Schema.Struct({
  connectionId: Id,
  cutover: FinancialDate,
  accounts: Schema.Struct({ smbc: Schema.optional(Id), yucho: Schema.optional(Id) }),
  trustGmailAuthenticationResults: Schema.optional(Schema.Boolean),
  status: Schema.optional(Schema.Literals(["pending", "posted"])),
  merchants: Schema.optional(
    Schema.Array(
      Schema.Struct({
        merchant: Name,
        categoryId: Schema.optional(Id),
        payeeId: Schema.optional(Id),
        transfer: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});

type MailConfig = typeof MailIngestionConfig.Type;

class LeaseExpired extends Data.TaggedError("MailLeaseExpired") {}

const leaseDuration = 5 * 60_000;

export const runMailIngestion = Effect.fn("Mail.ingest")(function* (
  config: MailConfig,
  gmail: GmailAdapter,
) {
  const sql = yield* SqlClient;
  const notifications = yield* Notifications;
  const { connectionId } = config;
  const cutover = Date.parse(`${config.cutover}T00:00:00+09:00`) / 1000;
  const now = yield* Clock.currentTimeMillis;
  const connection = yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO mail_connections VALUES (${connectionId},NULL,0,0)
        ON CONFLICT(connectionId) DO NOTHING`;
      const [lease] = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ generation: Schema.Int, historyId: Schema.NullOr(HistoryId) }),
        ),
      )(
        yield* sql`UPDATE mail_connections SET generation=generation+1,leaseUntil=${now + leaseDuration}
        WHERE connectionId=${connectionId} AND leaseUntil <= ${now} RETURNING generation,historyId`,
      );
      if (!lease) return null;
      yield* sql`UPDATE mail_runs SET status='expired',finishedAt=${now},reason='lease-expired'
        WHERE connectionId=${connectionId} AND status='running'`;
      yield* sql`INSERT INTO mail_runs (connectionId,generation,startedAt,status)
        VALUES (${connectionId},${lease.generation},${now},'running')`;
      return lease;
    }),
  );
  if (!connection) return "busy" as const;
  const { generation } = connection;

  const fenced = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const renewed = yield* sql`UPDATE mail_connections SET leaseUntil=${now + leaseDuration}
          WHERE connectionId=${connectionId} AND generation=${generation} AND leaseUntil > ${now}
          RETURNING generation`;
        if (!renewed.length) return yield* Effect.fail(new LeaseExpired());
        return yield* operation;
      }),
    );

  const persistPage = Effect.fn("Mail.persistDiscovery")(function* (
    ids: readonly string[],
    cursor?: string,
  ) {
    const decodedIds = yield* Schema.decodeUnknownEffect(Schema.Array(MessageId))(ids);
    const historyId =
      cursor === undefined ? undefined : yield* Schema.decodeUnknownEffect(HistoryId)(cursor);
    yield* fenced(
      Effect.gen(function* () {
        const [first, ...rest] = decodedIds;
        if (first !== undefined) {
          const pending = (messageId: string) => ({ connectionId, messageId, state: "pending" });
          yield* sql`INSERT INTO mail_messages ${sql.insert([pending(first), ...rest.map(pending)])}
            ON CONFLICT(connectionId,messageId) DO NOTHING`;
        }
        if (historyId !== undefined)
          yield* sql`UPDATE mail_connections SET historyId=${historyId} WHERE connectionId=${connectionId}`;
      }),
    );
  });

  const drainHistory = Effect.fn("Mail.drainHistory")(function* (baseline: string) {
    let pageToken: string | undefined;
    do {
      yield* fenced(Effect.void);
      const page = yield* gmail.history(baseline, pageToken);
      pageToken = page.nextPageToken;
      yield* persistPage(page.ids, pageToken === undefined ? page.historyId : undefined);
    } while (pageToken !== undefined);
  });

  const bootstrap = Effect.gen(function* () {
    yield* fenced(Effect.void);
    const baseline = yield* gmail.profile();
    let pageToken: string | undefined;
    do {
      yield* fenced(Effect.void);
      const page = yield* gmail.search(cutover, pageToken);
      pageToken = page.nextPageToken;
      yield* persistPage(page.ids);
    } while (pageToken !== undefined);
    yield* drainHistory(baseline);
  });

  const discover =
    connection.historyId === null
      ? bootstrap
      : drainHistory(connection.historyId).pipe(
          Effect.catchTag("GmailError", (error) =>
            error.kind === "missing" ? bootstrap : Effect.fail(error),
          ),
        );

  const updateMessage = (
    messageId: string,
    state: "retry" | "review" | "ignored",
    reason: string,
    provenance?: string,
  ) =>
    fenced(sql`UPDATE mail_messages SET state=${state},reason=${reason},
      provenance=COALESCE(${provenance ?? null},provenance)
      WHERE connectionId=${connectionId} AND messageId=${messageId} AND state IN ('pending','retry')`);

  const accept = Effect.fn("Mail.accept")(function* (messageId: string, payload: string) {
    const command = yield* Schema.decodeUnknownEffect(FrozenCommand)(payload);
    yield* fenced(
      Effect.gen(function* () {
        const work =
          yield* sql`SELECT messageId FROM mail_messages WHERE connectionId=${connectionId}
        AND messageId=${messageId} AND state IN ('pending','retry')`;
        if (!work.length) return;
        const [account] = yield* sql`SELECT currency FROM accounts WHERE id=${command.accountId}`;
        if (account?.currency !== "JPY") {
          yield* sql`UPDATE mail_messages SET state='review',reason='account-currency-or-missing'
          WHERE connectionId=${connectionId} AND messageId=${messageId}`;
          return;
        }
        const candidates =
          yield* sql`SELECT id FROM transactions WHERE accountId=${command.accountId}
        AND date=${command.date} AND amount=${command.amount} AND kind='transaction' AND transferId IS NULL LIMIT 1`;
        if (candidates.length) {
          yield* sql`UPDATE mail_messages SET state='review',reason='possible-duplicate'
          WHERE connectionId=${connectionId} AND messageId=${messageId}`;
          return;
        }
        const transaction = yield* createTransaction(command);
        yield* sql`UPDATE mail_messages SET state='accepted',reason=NULL,transactionId=${transaction.id}
        WHERE connectionId=${connectionId} AND messageId=${messageId}`;
        yield* sql.afterCommit(notifications.changed);
      }),
    ).pipe(
      Effect.catchTag("LedgerError", (error) =>
        updateMessage(messageId, "review", `ledger-${error.status}`).pipe(Effect.asVoid),
      ),
    );
  });

  const processMessage = Effect.fn("Mail.processMessage")(function* (
    messageId: string,
    frozen: string | null,
  ) {
    if (frozen !== null) return yield* accept(messageId, frozen);
    yield* fenced(Effect.void);
    const headers = yield* gmail.metadata(messageId);
    if (!matchesMailHeaders(headers)) {
      yield* updateMessage(messageId, "ignored", "unsupported-headers");
      return;
    }
    if (headers.internalDate === undefined || !/^\d{1,16}$/.test(headers.internalDate)) {
      yield* updateMessage(messageId, "review", "invalid-receipt-time");
      return;
    }
    if (Number(headers.internalDate) < cutover * 1000) {
      yield* updateMessage(messageId, "ignored", "before-cutover");
      return;
    }
    const parsed = yield* parseMail(messageId, yield* gmail.raw(messageId));
    if (parsed.kind !== "parsed") {
      yield* updateMessage(
        messageId,
        parsed.kind === "ignored" ? "ignored" : "review",
        parsed.reason,
      );
      return;
    }
    const provenance = JSON.stringify(parsed);
    const accountId = config.accounts[parsed.issuer];
    if (accountId === undefined) {
      yield* updateMessage(messageId, "review", "account-unmapped", provenance);
      return;
    }
    const merchant = normalizeMerchant(parsed.merchant);
    const mapping = config.merchants?.find(
      (entry) => normalizeMerchant(entry.merchant) === merchant,
    );
    const command = yield* Schema.decodeUnknownEffect(CreateTransaction)({
      operationId: `mail-${createHash("sha256")
        .update(JSON.stringify([connectionId, messageId]))
        .digest("hex")}`,
      accountId,
      amount: parsed.amount,
      date: parsed.date,
      categoryId: mapping?.categoryId,
      payeeId: mapping?.payeeId,
      status: config.status ?? "pending",
      source: "mail-bean",
      importIdentity: { namespace: `gmail:${connectionId}`, key: messageId },
    });
    const payload = yield* Schema.encodeEffect(FrozenCommand)(command);
    const authenticated =
      config.trustGmailAuthenticationResults === true &&
      headers.authenticatedFromDomain === issuerDomain(parsed.issuer);
    const reviewReason = mapping?.transfer
      ? "transfer-review"
      : authenticated
        ? null
        : "sender-unverified";
    yield* fenced(sql`UPDATE mail_messages SET command=${payload},provenance=${provenance},
      state=${reviewReason === null ? "pending" : "review"},
      reason=${reviewReason}
      WHERE connectionId=${connectionId} AND messageId=${messageId} AND state IN ('pending','retry')`);
    if (reviewReason === null) yield* accept(messageId, payload);
  });

  const work = Effect.gen(function* () {
    let after = "";
    let retryable = false;
    while (true) {
      const [next] = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ messageId: MessageId, command: Schema.NullOr(Schema.String) }),
        ),
      )(
        yield* sql`SELECT messageId,command FROM mail_messages WHERE connectionId=${connectionId}
        AND state IN ('pending','retry') AND messageId > ${after} ORDER BY messageId LIMIT 1`,
      );
      if (!next) return retryable;
      after = next.messageId;
      yield* processMessage(next.messageId, next.command).pipe(
        Effect.catchTag("GmailError", (error) =>
          Effect.gen(function* () {
            if (error.kind === "auth" || error.kind === "transient") {
              yield* updateMessage(next.messageId, "retry", `gmail-${error.kind}`);
              if (error.kind === "auth") return yield* Effect.fail(error);
              retryable = true;
            } else {
              yield* updateMessage(next.messageId, "review", `gmail-${error.kind}`);
            }
          }),
        ),
      );
    }
  });

  const finish = (status: "complete" | "failed" | "blocked", reason: string | null) =>
    fenced(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE mail_runs SET status=${status},reason=${reason},finishedAt=${now}
          WHERE connectionId=${connectionId} AND generation=${generation}`;
        yield* sql`UPDATE mail_connections SET leaseUntil=0 WHERE connectionId=${connectionId}`;
      }),
    );

  return yield* Effect.gen(function* () {
    // Pending work survives discovery failure and can still be accepted during this run.
    const discovery = yield* Effect.result(discover);
    if (
      discovery._tag === "Failure" &&
      discovery.failure._tag === "GmailError" &&
      discovery.failure.kind === "auth"
    )
      return yield* Effect.fail(discovery.failure);
    const retryable = yield* work;
    if (discovery._tag === "Failure") return yield* Effect.fail(discovery.failure);
    const status = retryable ? "failed" : "complete";
    yield* finish(status, retryable ? "retryable-messages" : null);
    return status;
  }).pipe(
    Effect.catchTag("MailLeaseExpired", () => Effect.succeed("expired" as const)),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const status = error._tag === "GmailError" && error.kind === "auth" ? "blocked" : "failed";
        const reason = error._tag === "GmailError" ? `gmail-${error.kind}` : error._tag;
        yield* finish(status, reason);
        return status;
      }).pipe(Effect.catchTag("MailLeaseExpired", () => Effect.succeed("expired" as const))),
    ),
  );
});
