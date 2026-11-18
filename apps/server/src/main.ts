import { runMain } from "@effect/platform-node/NodeRuntime";
import { Config, Effect, Redacted, Schedule, Schema } from "effect";
import { databaseLayer } from "./database.ts";
import { ServerError, startServer } from "./http.ts";

import { createGmailAdapter } from "./mail/gmail.ts";
import { MailIngestionConfig, runMailIngestion } from "./mail/ingestion.ts";
import { makeNotifications, Notifications } from "./notifications.ts";

const loadMail = Effect.gen(function* () {
  const encoded = yield* Config.Redacted("BEAN_MAIL_CONFIG");
  const config = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MailIngestionConfig))(
    Redacted.value(encoded),
  ).pipe(Effect.mapError(() => new ServerError("Invalid BEAN_MAIL_CONFIG")));
  if (!config.accounts.smbc && !config.accounts.yucho)
    return yield* Effect.fail(new ServerError("BEAN_MAIL_CONFIG requires an account mapping"));
  const clientId = yield* Config.NonEmptyString("BEAN_GMAIL_CLIENT_ID");
  const clientSecret = yield* Config.Redacted("BEAN_GMAIL_CLIENT_SECRET");
  const refreshToken = yield* Config.Redacted("BEAN_GMAIL_REFRESH_TOKEN");
  if (!Redacted.value(clientSecret).trim() || !Redacted.value(refreshToken).trim())
    return yield* Effect.fail(new ServerError("Gmail credentials must be nonempty"));
  return { config, adapter: createGmailAdapter({ clientId, clientSecret, refreshToken }) };
});

const program = Effect.gen(function* () {
  const token = yield* Config.Redacted("BEAN_TOKEN");
  if (!Redacted.value(token).trim())
    return yield* Effect.fail(new ServerError("BEAN_TOKEN must be nonempty"));

  const port = yield* Config.Port("BEAN_PORT").pipe(Config.withDefault(3000));
  const host = yield* Config.String("BEAN_HOST").pipe(Config.withDefault("127.0.0.1"));
  const path = yield* Config.String("BEAN_DATABASE").pipe(Config.withDefault("bean-budget.sqlite"));

  const mail = (yield* Config.Boolean("BEAN_MAIL_ENABLED").pipe(Config.withDefault(false)))
    ? yield* loadMail
    : null;

  const notifications = yield* makeNotifications;
  return yield* Effect.gen(function* () {
    if (mail) {
      yield* runMailIngestion(mail.config, mail.adapter).pipe(
        Effect.catch(() => Effect.logError("Mail ingestion could not update saved progress")),
        Effect.repeat(Schedule.spaced("15 minutes")),
        Effect.forkScoped,
      );
    }
    return yield* startServer({ token: Redacted.value(token), host, port });
  }).pipe(
    Effect.scoped,
    Effect.provideService(Notifications, notifications),
    Effect.provide(databaseLayer(path)),
  );
});

runMain(program);
