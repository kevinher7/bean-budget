import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { layer as nodeFileSystem } from "@effect/platform-node/NodeFileSystem";
import { layerWebSocketConstructor } from "@effect/platform-node/NodeSocket";
import {
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema,
  Scope,
} from "effect";
import { layer as fetchHttpClient, RequestInit } from "effect/http/FetchHttpClient";
import { execute } from "effect/http/HttpClient";
import {
  bearerToken,
  bodyJsonUnsafe,
  get,
  post,
  type HttpClientRequest,
} from "effect/http/HttpClientRequest";
import { CloseEvent, makeWebSocket } from "effect/socket/Socket";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Account,
  LedgerNotification,
  MailReviewAction,
  MailReviewQueue,
  MailReviewResult,
  MailStatus,
  NotificationTicket,
  RegisterSnapshot,
} from "@bean-budget/protocol";
import { databaseLayer } from "../database.ts";
import { listenServer } from "../http.ts";
import { GmailError, type GmailAdapter } from "../mail/gmail.ts";
import { runMailIngestion } from "../mail/ingestion.ts";
import { makeNotifications, Notifications } from "../notifications.ts";
import { inputs } from "./inputs.ts";

export class ExperimentError extends Data.TaggedError("ExperimentError")<{ message: string }> {}

export type ExperimentEvent = {
  sequence: number;
  elapsedMs: number;
  stage: string;
  detail: Schema.JsonObject;
};

type RecordEvent = (stage: string, detail: ExperimentEvent["detail"]) => Effect.Effect<void>;

export type MailReviewSyncOptions = {
  directory: string;
  disconnectAt?: "review" | null;
  observationWindowMs?: number;
  onEvent?: (event: ExperimentEvent) => void;
};

export function mailReviewSyncPlan({
  disconnectAt = null,
  observationWindowMs = 500,
}: Pick<MailReviewSyncOptions, "disconnectAt" | "observationWindowMs"> = {}) {
  return {
    scenario: "mail-review-sync" as const,
    parameters: { disconnectAt, observationWindowMs, httpTimeoutMs: 5_000, socketTimeoutMs: 2_000 },
    inputs,
  };
}

const DurableMailState = Schema.Struct({
  connections: Schema.Array(
    Schema.Struct({
      connectionId: Schema.String,
      historyId: Schema.NullOr(Schema.String),
      generation: Schema.Int,
    }),
  ),
  messages: Schema.Array(
    Schema.Struct({
      connectionId: Schema.String,
      messageId: Schema.String,
      state: Schema.String,
      reason: Schema.NullOr(Schema.String),
      transactionId: Schema.NullOr(Schema.String),
    }),
  ),
  ledgerReceipts: Schema.Array(Schema.Struct({ operationId: Schema.String })),
  reviewReceipts: Schema.Array(
    Schema.Struct({
      operationId: Schema.String,
      payload: Schema.fromJsonString(MailReviewAction),
      result: Schema.fromJsonString(MailReviewResult),
    }),
  ),
  importIdentities: Schema.Array(
    Schema.Struct({
      identity: Schema.fromJsonString(
        Schema.Struct({ namespace: Schema.String, key: Schema.String }),
      ),
      transactionId: Schema.String,
    }),
  ),
});

const durableMailState = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      return yield* Schema.decodeUnknownEffect(DurableMailState)({
        connections:
          yield* sql`SELECT connectionId,historyId,generation FROM mail_connections ORDER BY connectionId`,
        messages:
          yield* sql`SELECT connectionId,messageId,state,reason,transactionId FROM mail_messages ORDER BY connectionId,messageId`,
        ledgerReceipts: yield* sql`SELECT operationId FROM receipts ORDER BY operationId`,
        reviewReceipts:
          yield* sql`SELECT operationId,payload,result FROM mail_review_receipts ORDER BY operationId`,
        importIdentities:
          yield* sql`SELECT identity,transactionId FROM import_identities ORDER BY identity`,
      });
    }),
  );
});

function scriptedGmail(record: RecordEvent): GmailAdapter {
  return {
    profile: () =>
      record("gmail.profile", { historyId: inputs.gmail.profileHistoryId }).pipe(
        Effect.as(inputs.gmail.profileHistoryId),
      ),
    search: (cutoverEpochSeconds, pageToken) =>
      record("gmail.search", {
        cutoverEpochSeconds,
        pageToken: pageToken ?? null,
        ids: [inputs.message.id],
      }).pipe(
        Effect.andThen(
          pageToken === undefined
            ? Effect.succeed({ ids: [inputs.message.id] })
            : Effect.fail(new GmailError("invalid")),
        ),
      ),
    history: (startHistoryId, pageToken) =>
      record("gmail.history", {
        startHistoryId,
        pageToken: pageToken ?? null,
        historyId: inputs.gmail.finalHistoryId,
      }).pipe(
        Effect.andThen(
          startHistoryId === inputs.gmail.profileHistoryId && pageToken === undefined
            ? Effect.succeed({ ids: [], historyId: inputs.gmail.finalHistoryId })
            : Effect.fail(new GmailError("invalid")),
        ),
      ),
    metadata: (id) =>
      record("gmail.metadata", { id }).pipe(
        Effect.andThen(
          id === inputs.message.id
            ? Effect.succeed(inputs.message.metadata)
            : Effect.fail(new GmailError("missing")),
        ),
      ),
    raw: (id) =>
      record("gmail.raw", { id }).pipe(
        Effect.andThen(
          id === inputs.message.id
            ? Effect.succeed(Buffer.from(inputs.message.mime).toString("base64url"))
            : Effect.fail(new GmailError("missing")),
        ),
      ),
  };
}

const decodeNotification = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerNotification));

const openObserver = Effect.fn("Lab.openObserver")(function* <
  E extends { readonly _tag: string },
  R,
>(
  url: string,
  ticket: Effect.Effect<string, E, R>,
  phase: "initial" | "reconnect",
  timeoutMs: number,
  record: RecordEvent,
) {
  const scope = yield* Scope.fork(yield* Effect.scope);
  const connection = yield* Scope.provide(
    Effect.gen(function* () {
      const socket = yield* makeWebSocket(
        url + "/notifications?ticket=" + encodeURIComponent(yield* ticket),
        { openTimeout: timeoutMs },
      );
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      return { reader, writer };
    }),
    scope,
  ).pipe(Effect.result);
  if (connection._tag === "Failure") {
    yield* Scope.close(scope, Exit.void);
    yield* record("socket.open-failed", { phase, error: connection.failure._tag });
    return null;
  }

  yield* record("socket.open", { phase });
  const { reader, writer } = connection.success;
  const frames = { ledgerChanged: 0, unexpected: 0 };
  const stopped = yield* Deferred.make<{ type: string; code: number | null }>();
  const receivedHint = yield* Deferred.make<void>();
  const decoder = new TextDecoder();
  yield* Effect.forever(
    reader.pull.pipe(
      Effect.flatMap((batch) =>
        Effect.forEach(
          batch,
          (frame) => {
            const text = typeof frame === "string" ? frame : decoder.decode(frame);
            const notification = decodeNotification(text);
            if (Option.isSome(notification)) {
              frames.ledgerChanged++;
              return record("socket.frame", { phase, ...notification.value }).pipe(
                Effect.andThen(Deferred.succeed(receivedHint, undefined)),
              );
            }
            frames.unexpected++;
            return record("socket.frame", { phase, type: "unexpected", text });
          },
          { discard: true },
        ),
      ),
    ),
  ).pipe(
    Effect.catchTag("SocketError", (error) => {
      const end = {
        type: error.reason._tag,
        code: error.reason._tag === "SocketCloseError" ? error.reason.code : null,
      };
      return record("socket.ended", { phase, ...end }).pipe(
        Effect.andThen(Deferred.succeed(stopped, end)),
      );
    }),
    Effect.forkIn(scope),
  );

  const disconnect = Effect.gen(function* () {
    const close = yield* writer.write(new CloseEvent(1000)).pipe(Effect.result);
    const observed = yield* Deferred.await(stopped).pipe(Effect.timeoutOption(timeoutMs));
    yield* Scope.close(scope, Exit.void);
    return close._tag === "Success" && Option.isSome(observed) && observed.value.code === 1000;
  });
  return {
    frames,
    disconnect,
    ended: Deferred.isDone(stopped),
    nextHint: Deferred.await(receivedHint),
  };
});

const services = Layer.mergeAll(nodeFileSystem, fetchHttpClient, layerWebSocketConstructor);

export const runMailReviewSync = Effect.fn("Lab.mailReviewSync")(
  function* (options: MailReviewSyncOptions) {
    const plan = mailReviewSyncPlan(options);
    const { disconnectAt, observationWindowMs, httpTimeoutMs, socketTimeoutMs } = plan.parameters;
    const start = yield* Clock.monotonicTimeNanos;
    const timeline: ExperimentEvent[] = [];
    const record: RecordEvent = (stage, detail) =>
      Clock.monotonicTimeNanos.pipe(
        Effect.map((now) => {
          const event = {
            sequence: timeline.length + 1,
            elapsedMs: Number(now - start) / 1_000_000,
            stage,
            detail,
          };
          timeline.push(event);
          options.onEvent?.(event);
        }),
      );

    const dbPath = join(options.directory, "ledger.sqlite");
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(dbPath, "", { flag: "wx", mode: 0o600 });
    const notifications = yield* makeNotifications;
    const token = randomBytes(32).toString("hex");

    return yield* Effect.gen(function* () {
      const address = yield* listenServer({ host: "127.0.0.1", port: 0, token });
      if (address._tag === "UnixPathAddress")
        return yield* new ExperimentError({ message: "Expected an ephemeral TCP listener" });

      const url = "http://127.0.0.1:" + String(address.port);
      const socketUrl = "ws://127.0.0.1:" + String(address.port);
      yield* record("backend.ready", {
        host: "127.0.0.1",
        port: address.port,
        database: "ledger.sqlite",
      });

      const request = Effect.fn("Lab.request")(
        function* (httpRequest: HttpClientRequest) {
          const response = yield* execute(bearerToken(httpRequest, token));
          const body = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
          );
          return { status: response.status, body };
        },
        Effect.timeout(httpTimeoutMs),
        (effect, httpRequest) =>
          Effect.mapError(
            effect,
            (error) =>
              new ExperimentError({
                message: `${httpRequest.method} ${httpRequest.url} failed (${error._tag})`,
              }),
          ),
      );

      const read = Effect.fn("Lab.readJson")(function* <
        S extends Schema.Top & { readonly DecodingServices: never },
      >(schema: S, httpRequest: HttpClientRequest) {
        const response = yield* request(httpRequest);
        if (response.status < 200 || response.status >= 300)
          return yield* new ExperimentError({
            message: `${httpRequest.method} ${httpRequest.url} returned HTTP ${String(response.status)}`,
          });
        return yield* Schema.decodeUnknownEffect(schema)(response.body);
      });

      const snapshot = Effect.gen(function* () {
        return {
          register: yield* read(RegisterSnapshot, get(url + "/register")),
          reviewQueue: yield* read(MailReviewQueue, get(url + "/mail/review")),
          mailStatus: yield* read(MailStatus, get(url + "/mail/status")),
          durable: yield* durableMailState,
        };
      });

      const account = yield* read(Account, bodyJsonUnsafe(post(url + "/accounts"), inputs.account));
      yield* record("account.created", {
        id: account.id,
        balance: account.balance,
        currency: account.currency,
      });
      yield* record("ingestion.start", { connectionId: inputs.ingestion.connectionId });
      const ingestionStatus = yield* runMailIngestion(inputs.ingestion, scriptedGmail(record));
      yield* record("ingestion.finish", { status: ingestionStatus });

      const before = yield* snapshot;
      yield* record("before.captured", {
        queued: before.reviewQueue.length,
        transactions: before.register.transactions.length,
      });

      // Close the observer before NodeHttpServer waits for its WebSocket clients.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const ticket = read(NotificationTicket, post(url + "/notifications/ticket")).pipe(
            Effect.map((response) => response.ticket),
          );
          const initial = yield* openObserver(
            socketUrl,
            ticket,
            "initial",
            socketTimeoutMs,
            record,
          );
          const disconnectConfirmed =
            disconnectAt === "review" && initial !== null ? yield* initial.disconnect : null;
          if (disconnectAt === "review")
            yield* record("fault.disconnect", {
              phase: disconnectAt,
              confirmed: disconnectConfirmed,
            });

          const queued = before.reviewQueue.some(
            ({ connectionId, messageId }) =>
              connectionId === inputs.ingestion.connectionId && messageId === inputs.message.id,
          );
          const action = inputs.reviewAction;
          yield* record("review.start", { action: action.action, message: action.message, queued });
          const attempted = queued
            ? yield* request(bodyJsonUnsafe(post(url + "/mail/review"), action)).pipe(Effect.result)
            : null;
          const review =
            attempted === null
              ? { status: null, transactionId: null, skipped: "message-not-queued" }
              : attempted._tag === "Failure"
                ? { status: null, transactionId: null, failure: attempted.failure.message }
                : {
                    status: attempted.success.status,
                    transactionId:
                      Option.getOrNull(
                        Schema.decodeUnknownOption(MailReviewResult)(attempted.success.body),
                      )?.transactionId ?? null,
                    response: attempted.success.body,
                  };
          yield* record("review.finish", review);

          const reviewHint =
            initial !== null && disconnectAt === null
              ? Option.isSome(
                  yield* initial.nextHint.pipe(Effect.timeoutOption(observationWindowMs)),
                )
              : false;
          const reviewWindow = {
            status:
              initial === null
                ? "open-failed"
                : disconnectAt === "review"
                  ? disconnectConfirmed
                    ? "disconnected"
                    : "disconnect-unconfirmed"
                  : (yield* initial.ended)
                    ? "ended"
                    : "open",
            ledgerChanged: initial?.frames.ledgerChanged ?? 0,
            unexpectedFrames: initial?.frames.unexpected ?? 0,
          };
          yield* record("review.window", reviewWindow);

          const reopened =
            disconnectAt === "review"
              ? yield* openObserver(socketUrl, ticket, "reconnect", socketTimeoutMs, record)
              : null;
          if (disconnectAt === "review") yield* Effect.sleep(observationWindowMs);
          const reconnectWindow =
            disconnectAt === "review"
              ? {
                  status:
                    reopened === null ? "open-failed" : (yield* reopened.ended) ? "ended" : "open",
                  ledgerChanged: reopened?.frames.ledgerChanged ?? 0,
                  unexpectedFrames: reopened?.frames.unexpected ?? 0,
                }
              : null;
          if (reconnectWindow !== null) yield* record("reconnect.window", reconnectWindow);

          const registerFetch =
            reopened !== null
              ? "simulated-client-reconnect"
              : disconnectAt === "review"
                ? "explicit-after-reconnect-failure"
                : reviewHint
                  ? "simulated-client-hint"
                  : initial !== null
                    ? "explicit-after-hint-timeout"
                    : "explicit-after-socket-open-failure";
          yield* record("register.fetch", { trigger: registerFetch });
          const after = yield* snapshot;

          const original = before.register.accounts.find(({ id }) => id === account.id);
          const refreshed = after.register.accounts.find(({ id }) => id === account.id);
          const postedDelta = original && refreshed ? refreshed.balance - original.balance : null;
          const projectedDelta =
            original?.projectedBalance !== undefined && refreshed?.projectedBalance !== undefined
              ? refreshed.projectedBalance - original.projectedBalance
              : null;
          yield* record("after.captured", {
            queued: after.reviewQueue.length,
            transactions: after.register.transactions.length,
            postedDelta,
            projectedDelta,
          });

          return {
            ...plan,
            before,
            after,
            timeline,
            observations: {
              ingestionStatus,
              reconnectWindow,
              disconnectConfirmed,
              reviewHint,
              reviewWindow,
              review,
              registerFetch,
              postedDelta,
              projectedDelta,
            },
          };
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(databaseLayer(dbPath), Layer.succeed(Notifications, notifications)),
      ),
    );
  },
  Effect.provide(services),
  Effect.provideService(RequestInit, { redirect: "error" }),
);

export type MailReviewSyncReport = Effect.Success<ReturnType<typeof runMailReviewSync>>;
