import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { make as makeNodeHttpServer } from "@effect/platform-node/NodeHttpServer";
import { ByteSize, Effect, Schema } from "effect";
import { MaxBodySize } from "effect/http/HttpIncomingMessage";
import {
  addAll as addRoutes,
  route,
  toHttpEffect,
  params as routeParams,
} from "effect/http/HttpRouter";
import { isHttpServerError } from "effect/http/HttpServerError";
import {
  HttpServerRequest,
  ParsedSearchParams,
  schemaBodyJson,
} from "effect/http/HttpServerRequest";
import { json as jsonResponse } from "effect/http/HttpServerResponse";
import { SqlClient } from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
import {
  MailStatus,
  MailReviewAction,
  CreateAccount,
  CreateTransaction,
  TransactionQuery,
  Command,
  SummaryQuery,
} from "@bean-budget/protocol";
import { mailReviewQueue, reviewMail } from "./mail/review.ts";
import { Notifications } from "./notifications.ts";
import { LedgerError } from "./database.ts";
import { readBudgets, readPeriods } from "./budgets.ts";
import { readSchedules, readOccurrences } from "./schedules.ts";
import {
  accounts,
  createAccount,
  createTransaction,
  transactions,
  command,
  categories,
  payees,
  summary,
  registerSnapshot,
} from "./ledger.ts";

export class ServerError extends Error {
  readonly _tag = "ServerError";
}

const routes = addRoutes([
  route(
    "GET",
    "/mail/review",
    Effect.flatMap(mailReviewQueue, (queue) =>
      jsonResponse(queue, { headers: { "cache-control": "no-store" } }),
    ),
  ),
  route(
    "POST",
    "/mail/review",
    Effect.gen(function* () {
      const input = yield* schemaBodyJson(MailReviewAction).pipe(
        Effect.mapError((error) =>
          Schema.isSchemaError(error) ? new LedgerError(400, "Invalid review action") : error,
        ),
      );
      return yield* jsonResponse(yield* reviewMail(input), {
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
  route(
    "GET",
    "/mail/status",
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const status = yield* sql.withTransaction(
        Effect.gen(function* () {
          const messages =
            yield* sql`SELECT connectionId,state,reason,count(*) AS count FROM mail_messages GROUP BY connectionId,state,reason ORDER BY connectionId,state,reason`;
          const runs =
            yield* sql`SELECT connectionId,generation,startedAt,finishedAt,status,reason FROM mail_runs ORDER BY startedAt DESC LIMIT 20`;
          return yield* Schema.decodeUnknownEffect(MailStatus)({ messages, runs });
        }),
      );
      return yield* jsonResponse(status, { headers: { "cache-control": "no-store" } });
    }),
  ),
  route(
    "POST",
    "/notifications/ticket",
    Effect.gen(function* () {
      const notifications = yield* Notifications;
      return yield* jsonResponse(yield* notifications.issueTicket, {
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
  route(
    "GET",
    "/register",
    Effect.flatMap(registerSnapshot, (value) =>
      jsonResponse(value, { headers: { "cache-control": "no-store" } }),
    ),
  ),
  route(
    "GET",
    "/categories",
    Effect.flatMap(categories, (value) => jsonResponse(value)),
  ),
  route(
    "GET",
    "/payees",
    Effect.flatMap(payees, (value) => jsonResponse(value)),
  ),
  route(
    "GET",
    "/budgets",
    Effect.flatMap(readBudgets(), (value) => jsonResponse(value)),
  ),
  route(
    "GET",
    "/schedules",
    Effect.flatMap(readSchedules(), (value) => jsonResponse(value)),
  ),
  route(
    "GET",
    "/scheduled-occurrences",
    Effect.flatMap(readOccurrences(), (value) => jsonResponse(value)),
  ),
  ...(
    [
      { method: "POST", path: "/categories", type: "category" },
      { method: "POST", path: "/payees", type: "payee" },
      { method: "POST", path: "/budgets", type: "budget" },
      { method: "POST", path: "/schedules", type: "schedule" },
      { method: "PUT", path: "/budgets/:budgetId/periods/:month", type: "plan" },
      { method: "PUT", path: "/budgets/:budgetId/periods/:month/category-plan", type: "plan" },
      { method: "PUT", path: "/budgets/:budgetId/reservations/:month", type: "reservation" },
      { method: "POST", path: "/schedules/:scheduleId/occurrences", type: "generate" },
      { method: "PUT", path: "/scheduled-occurrences/:id", type: "occurrence" },
      {
        method: "POST",
        path: "/scheduled-occurrences/:occurrenceId/pending-transaction",
        type: "pendingOccurrence",
      },
      { method: "POST", path: "/scheduled-occurrences/:occurrenceId/match", type: "match" },
      { method: "PUT", path: "/transactions/:id", type: "editTransaction" },
      { method: "POST", path: "/transfers", type: "transfer" },
    ] as const
  ).map(({ method, path, type }) =>
    route(
      method,
      path,
      Effect.gen(function* () {
        const body = yield* schemaBodyJson(Schema.Record(Schema.String, Schema.Unknown)).pipe(
          Effect.mapError((error) =>
            Schema.isSchemaError(error) ? new LedgerError(400, "Invalid request") : error,
          ),
        );
        const params = yield* routeParams;
        const value =
          type === "plan" || type === "reservation"
            ? {
                operationId: body.operationId,
                revision: body.revision,
                value: { ...body, budgetId: params.budgetId, month: params.month },
              }
            : { ...body, ...params };
        const input = yield* Schema.decodeUnknownEffect(Command)({ ...value, type }).pipe(
          Effect.mapError(() => new LedgerError(400, "Invalid request")),
        );
        const result = yield* command(input);
        yield* (yield* Notifications).changed;
        return yield* jsonResponse(result);
      }),
    ),
  ),
  route(
    "GET",
    "/budgets/:budgetId/periods/:month/summary",
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(SummaryQuery)(yield* routeParams).pipe(
        Effect.mapError(() => new LedgerError(400, "Invalid path")),
      );
      return yield* jsonResponse(yield* summary(input));
    }),
  ),
  route(
    "GET",
    "/budgets/:budgetId/periods/:month",
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(SummaryQuery)(yield* routeParams).pipe(
        Effect.mapError(() => new LedgerError(400, "Invalid path")),
      );
      const period = (yield* readPeriods(input.budgetId, input.month, input.month)).find(
        (p) => p.month === input.month,
      );
      if (!period) return yield* Effect.fail(new LedgerError(404, "Unknown budget period"));
      return yield* jsonResponse(period);
    }),
  ),
  route(
    "GET",
    "/health",
    jsonResponse({ status: "ok" }, { status: 200, headers: { "cache-control": "no-store" } }),
  ),
  route(
    "GET",
    "/accounts",
    Effect.flatMap(accounts, (value) =>
      jsonResponse(value, { status: 200, headers: { "cache-control": "no-store" } }),
    ),
  ),
  route(
    "POST",
    "/accounts",
    Effect.gen(function* () {
      const input = yield* schemaBodyJson(CreateAccount).pipe(
        Effect.mapError((error) =>
          Schema.isSchemaError(error) ? new LedgerError(400, "Invalid request") : error,
        ),
      );
      const result = yield* createAccount(input);
      yield* (yield* Notifications).changed;
      return yield* jsonResponse(result, {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
  route(
    "GET",
    "/transactions",
    Effect.gen(function* () {
      const params = yield* ParsedSearchParams;
      for (const [key, value] of Object.entries(params)) {
        if (!["accountId", "from", "to"].includes(key) || typeof value !== "string")
          return yield* Effect.fail(new LedgerError(400, "Invalid query"));
      }
      const input = yield* Schema.decodeUnknownEffect(TransactionQuery)(params).pipe(
        Effect.mapError(() => new LedgerError(400, "Invalid query")),
      );
      return yield* jsonResponse(yield* transactions(input), {
        status: 200,
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
  route(
    "POST",
    "/transactions",
    Effect.gen(function* () {
      const input = yield* schemaBodyJson(CreateTransaction).pipe(
        Effect.mapError((error) =>
          Schema.isSchemaError(error) ? new LedgerError(400, "Invalid request") : error,
        ),
      );
      const result = yield* createTransaction(input);
      yield* (yield* Notifications).changed;
      return yield* jsonResponse(result, {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    }),
  ),
]);

function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from("Bearer " + token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const listenServer = Effect.fn("Http.listen")(function* (config: {
  token: string;
  host?: string;
  port?: number;
}) {
  if (!config.token.trim())
    return yield* Effect.fail(new ServerError("BEAN_TOKEN must be nonempty"));

  const router = yield* toHttpEffect(routes);
  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const target = request.url;
    if (!target.startsWith("/") || target.startsWith("//") || /%(?![0-9a-f]{2})/i.test(target))
      return yield* Effect.fail(new LedgerError(400, "Invalid request URL"));
    const url = yield* Effect.try({
      try: () => {
        decodeURI(target);
        return new URL(target, "http://localhost");
      },
      catch: () => new LedgerError(400, "Invalid request URL"),
    });
    if (request.method === "GET" && url.pathname === "/notifications") {
      const notifications = yield* Notifications;
      return yield* notifications.connect(url.searchParams.get("ticket") ?? "");
    }
    const publicRoute = request.method === "GET" && url.pathname === "/health";
    if (!publicRoute && !authorized(request.headers.authorization, config.token))
      return yield* jsonResponse(
        { error: "Unauthorized" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    return yield* router;
  }).pipe(
    Effect.provideService(MaxBodySize, ByteSize.kibibytes(16)),
    Effect.catch((cause) => {
      if (cause instanceof LedgerError)
        return jsonResponse(
          { error: cause.message },
          { status: cause.status, headers: { "cache-control": "no-store" } },
        );
      if (isHttpServerError(cause)) {
        if (cause.reason._tag === "RequestParseError") {
          const oversized = cause.reason.reason === "BodyTooLarge";
          return jsonResponse(
            { error: oversized ? "Body too large" : "Invalid request" },
            { status: oversized ? 413 : 400, headers: { "cache-control": "no-store" } },
          );
        }
        if (cause.reason._tag === "RouteNotFound")
          return jsonResponse(
            { error: "Not found" },
            { status: 404, headers: { "cache-control": "no-store" } },
          );
      }
      // Only log stable classifications; errors may contain SQL values or decoded data.
      const details = isSqlError(cause)
        ? { errorType: "SqlError", reason: cause.reason._tag, retryable: cause.reason.isRetryable }
        : { errorType: Schema.isSchemaError(cause) ? "StoredDataDecodeError" : "InternalError" };
      return Effect.logError("HTTP request failed").pipe(
        Effect.annotateLogs(details),
        Effect.andThen(
          jsonResponse(
            { error: "Internal server error" },
            { status: 500, headers: { "cache-control": "no-store" } },
          ),
        ),
      );
    }),
  );

  const server = yield* makeNodeHttpServer(createServer, {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 3000,
  });
  yield* server.serve(app);
  return server.address;
});

export function startServer(config: { token: string; host?: string; port?: number }) {
  return listenServer(config).pipe(Effect.andThen(Effect.never), Effect.scoped);
}
