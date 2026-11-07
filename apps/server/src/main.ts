import { runMain } from "@effect/platform-node/NodeRuntime";
import { Config, Effect, Redacted } from "effect";
import { databaseLayer } from "./database.ts";
import { ServerError, startServer } from "./http.ts";

const program = Effect.gen(function* () {
  const token = yield* Config.Redacted("BEAN_TOKEN");
  if (!Redacted.value(token).trim())
    return yield* Effect.fail(new ServerError("BEAN_TOKEN must be nonempty"));

  const port = yield* Config.Port("BEAN_PORT").pipe(Config.withDefault(3000));
  const host = yield* Config.String("BEAN_HOST").pipe(Config.withDefault("127.0.0.1"));
  const path = yield* Config.String("BEAN_DATABASE").pipe(Config.withDefault("bean-budget.sqlite"));

  return yield* startServer({ token: Redacted.value(token), host, port }).pipe(
    Effect.scoped,
    Effect.provide(databaseLayer(path)),
  );
});

runMain(program);
