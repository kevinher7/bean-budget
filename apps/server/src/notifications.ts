import { randomBytes } from "node:crypto";
import { Clock, Context, Effect, PubSub, Schema } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { empty } from "effect/http/HttpServerResponse";
import { LedgerNotification } from "@bean-budget/protocol";
import { LedgerError } from "./database.ts";

export const Notifications = Context.Service<{
  readonly issueTicket: Effect.Effect<{ ticket: string }>;
  readonly connect: (
    ticket: string,
  ) => Effect.Effect<
    ReturnType<typeof empty>,
    LedgerError | import("effect/http/HttpServerError").HttpServerError,
    HttpServerRequest
  >;
  readonly changed: Effect.Effect<void>;
}>("BeanBudget/Notifications");

export const makeNotifications = Effect.gen(function* () {
  const changes = yield* PubSub.sliding<void>(1);
  const tickets = new Map<string, number>();
  const message = JSON.stringify(Schema.encodeSync(LedgerNotification)({ type: "ledgerChanged" }));
  const issueTicket = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [ticket, expires] of tickets) {
      if (expires > now && tickets.size < 256) break;
      tickets.delete(ticket);
    }
    const ticket = randomBytes(32).toString("hex");
    tickets.set(ticket, now + 30_000);
    return { ticket };
  });
  const connect = Effect.fn("Notifications.connect")(function* (ticket: string) {
    const request = yield* HttpServerRequest;
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin !== undefined && origin !== `https://${host}` && origin !== `http://${host}`)
      return yield* Effect.fail(new LedgerError(403, "Invalid notification origin"));
    if (request.headers.upgrade?.toLowerCase() !== "websocket")
      return yield* Effect.fail(new LedgerError(400, "WebSocket upgrade required"));
    const now = yield* Clock.currentTimeMillis;
    const expires = tickets.get(ticket);
    tickets.delete(ticket);
    if (expires === undefined || expires <= now)
      return yield* Effect.fail(new LedgerError(401, "Invalid notification ticket"));

    const socket = yield* request.upgrade;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        return yield* Effect.raceFirst(
          Effect.forever(reader.pull),
          Effect.forever(PubSub.take(subscription).pipe(Effect.andThen(writer.write(message)))),
        );
      }).pipe(Effect.catchTag("SocketError", () => Effect.void)),
    );
    return empty();
  });
  return Notifications.of({
    issueTicket,
    connect,
    changed: PubSub.publish(changes, undefined).pipe(Effect.asVoid),
  });
});
