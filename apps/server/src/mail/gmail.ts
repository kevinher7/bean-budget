import { Clock, Effect, Redacted, Schedule, Schema } from "effect";
import { layer as fetchHttpClientLayer, RequestInit } from "effect/http/FetchHttpClient";
import { execute } from "effect/http/HttpClient";
import type { HttpClientRequest } from "effect/http/HttpClientRequest";
import { bearerToken, bodyUrlParams, get, post, setUrlParams } from "effect/http/HttpClientRequest";
import { mailSenders, mailSubject } from "./parser.ts";

export class GmailError extends Error {
  readonly _tag = "GmailError";

  readonly kind: "auth" | "transient" | "missing" | "invalid";

  constructor(kind: GmailError["kind"]) {
    super(`Gmail request failed (${kind})`);
    this.kind = kind;
  }
}

type Page = { ids: readonly string[]; nextPageToken?: string };

export type GmailMetadata = {
  from?: string;
  subject?: string;
  internalDate?: string;
};

export type GmailAdapter = {
  profile(): Effect.Effect<string, GmailError>;
  search(cutoverEpochSeconds: number, pageToken?: string): Effect.Effect<Page, GmailError>;
  history(
    startHistoryId: string,
    pageToken?: string,
  ): Effect.Effect<Page & { historyId: string }, GmailError>;
  metadata(id: string): Effect.Effect<GmailMetadata, GmailError>;
  raw(id: string): Effect.Effect<string, GmailError>;
};

const messageId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,100}$/));
const historyId = Schema.String.check(Schema.isPattern(/^\d{1,30}$/));
const nextPageToken = Schema.optional(Schema.String.check(Schema.isMinLength(1)));
const messageRef = Schema.Struct({ id: messageId });
const messagePage = Schema.Struct({
  nextPageToken,
  messages: Schema.optional(Schema.Array(messageRef)),
});
const historyPage = Schema.Struct({
  nextPageToken,
  historyId,
  history: Schema.optional(
    Schema.Array(
      Schema.Struct({
        messagesAdded: Schema.optional(Schema.Array(Schema.Struct({ message: messageRef }))),
      }),
    ),
  ),
});
const profileResponse = Schema.Struct({ historyId });
const metadataResponse = Schema.Struct({
  id: messageId,
  internalDate: Schema.optional(Schema.String.check(Schema.isPattern(/^\d{1,15}$/))),
  payload: Schema.Struct({
    headers: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    ),
  }),
});
const rawResponse = Schema.Struct({
  id: messageId,
  raw: Schema.String.check(Schema.isMinLength(1)),
});
const tokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  expires_in: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
const forbiddenResponse = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.optional(Schema.Array(Schema.Struct({ reason: Schema.String }))),
  }),
});

const requestJson = Effect.fn("Gmail.request")(function* (
  request: HttpClientRequest,
  endpoint: "token" | "api",
) {
  const response = yield* execute(request).pipe(Effect.mapError(() => new GmailError("transient")));
  if (response.status >= 200 && response.status < 300) {
    return yield* response.json.pipe(Effect.mapError(() => new GmailError("invalid")));
  }
  if (response.status === 429 || response.status >= 500)
    return yield* Effect.fail(new GmailError("transient"));

  if (endpoint === "token" || response.status === 401)
    return yield* Effect.fail(new GmailError("auth"));

  if (response.status === 403) {
    const parsed = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(forbiddenResponse)),
      Effect.result,
    );
    const rateLimited =
      parsed._tag === "Success" &&
      parsed.success.error.errors?.some(
        ({ reason }) => reason === "userRateLimitExceeded" || reason === "rateLimitExceeded",
      );
    return yield* Effect.fail(new GmailError(rateLimited ? "transient" : "auth"));
  }

  return yield* Effect.fail(new GmailError(response.status === 404 ? "missing" : "invalid"));
});

function request<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  httpRequest: HttpClientRequest,
  endpoint: "token" | "api",
): Effect.Effect<S["Type"], GmailError> {
  return requestJson(httpRequest, endpoint).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () => Effect.fail(new GmailError("transient")),
    }),
    Effect.retry({
      times: 3,
      schedule: Schedule.exponential("500 millis").pipe(Schedule.jittered),
      while: (error) => error.kind === "transient",
    }),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((error) => (error instanceof GmailError ? error : new GmailError("invalid"))),
    Effect.provide(fetchHttpClientLayer),
    Effect.provideService(RequestInit, { redirect: "error" }),
  );
}

const gmailBase = "https://gmail.googleapis.com/gmail/v1/users/me";

export function createGmailAdapter(config: {
  clientId: string;
  clientSecret: Redacted.Redacted<string>;
  refreshToken: Redacted.Redacted<string>;
}): GmailAdapter {
  let accessToken: { token: string; expiresAt: number } | undefined;

  const token = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (accessToken && accessToken.expiresAt > now) return accessToken.token;
    const response = yield* request(
      tokenResponse,
      bodyUrlParams(post("https://oauth2.googleapis.com/token"), {
        client_id: config.clientId,
        client_secret: Redacted.value(config.clientSecret),
        refresh_token: Redacted.value(config.refreshToken),
        grant_type: "refresh_token",
      }),
      "token",
    );
    accessToken = {
      token: response.access_token,
      expiresAt: now + Math.max(0, response.expires_in - 60) * 1_000,
    };
    return response.access_token;
  });

  function call<S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    path: string,
    params: URLSearchParams,
  ) {
    const httpRequest = setUrlParams(get(gmailBase + path), params);
    return token.pipe(
      Effect.flatMap((value) =>
        request(schema, bearerToken(httpRequest, value), "api").pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.kind === "auth") accessToken = undefined;
            }),
          ),
        ),
      ),
    );
  }

  return {
    profile: () =>
      call(profileResponse, "/profile", new URLSearchParams({ fields: "historyId" })).pipe(
        Effect.map((response) => response.historyId),
      ),
    search: (cutoverEpochSeconds, pageToken) => {
      const params = new URLSearchParams({
        q: `from:{${mailSenders.join(" ")}} subject:"${mailSubject}" after:${cutoverEpochSeconds}`,
        maxResults: "500",
        fields: "messages(id),nextPageToken",
      });
      if (pageToken) params.set("pageToken", pageToken);
      return call(messagePage, "/messages", params).pipe(
        Effect.map((response) => ({
          ids: response.messages?.map(({ id }) => id) ?? [],
          ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
        })),
      );
    },
    history: (startHistoryId, pageToken) => {
      const params = new URLSearchParams({
        startHistoryId,
        historyTypes: "messageAdded",
        maxResults: "500",
        fields: "history(messagesAdded(message(id))),historyId,nextPageToken",
      });
      if (pageToken) params.set("pageToken", pageToken);
      return call(historyPage, "/history", params).pipe(
        Effect.map((response) => ({
          ids:
            response.history?.flatMap(
              (entry) => entry.messagesAdded?.map(({ message }) => message.id) ?? [],
            ) ?? [],
          historyId: response.historyId,
          ...(response.nextPageToken ? { nextPageToken: response.nextPageToken } : {}),
        })),
      );
    },
    metadata: (id) => {
      const params = new URLSearchParams({
        format: "metadata",
        fields: "id,internalDate,payload(headers)",
      });
      params.append("metadataHeaders", "From");
      params.append("metadataHeaders", "Subject");
      return call(metadataResponse, `/messages/${encodeURIComponent(id)}`, params).pipe(
        Effect.flatMap((response) => {
          if (response.id !== id) return Effect.fail(new GmailError("invalid"));
          const header = (name: string) =>
            response.payload.headers?.find((value) => value.name.toLowerCase() === name)?.value;
          const from = header("from");
          const subject = header("subject");
          return Effect.succeed({
            ...(from === undefined ? {} : { from }),
            ...(subject === undefined ? {} : { subject }),
            ...(response.internalDate === undefined ? {} : { internalDate: response.internalDate }),
          });
        }),
      );
    },
    raw: (id) =>
      call(
        rawResponse,
        `/messages/${encodeURIComponent(id)}`,
        new URLSearchParams({
          format: "raw",
          fields: "id,raw",
        }),
      ).pipe(
        Effect.flatMap((response) =>
          response.id === id
            ? Effect.succeed(response.raw)
            : Effect.fail(new GmailError("invalid")),
        ),
      ),
  };
}
