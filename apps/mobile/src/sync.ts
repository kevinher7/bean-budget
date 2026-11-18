import { LedgerNotification, NotificationTicket } from "@bean-budget/protocol";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const decodeNotification = Schema.decodeUnknownOption(Schema.fromJsonString(LedgerNotification));

const requestTicket = Effect.fn("requestNotificationTicket")(
  function* (connection: { url: string; token: string }) {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(connection.url + "/notifications/ticket").pipe(
        HttpClientRequest.bearerToken(connection.token),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail(response.status);
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(NotificationTicket)),
    );
  },
  Effect.timeout("10 seconds"),
  Effect.provide(FetchHttpClient.layer),
);

export function watchLedgerChanges(
  connection: { url: string; token: string },
  requestSync: () => void,
) {
  const lifetime = new AbortController();
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attemptTimeout: ReturnType<typeof setTimeout> | undefined;
  let delay = 1000;

  function reconnect() {
    if (lifetime.signal.aborted || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 60_000);
  }

  function connect() {
    Effect.runPromise(requestTicket(connection), { signal: lifetime.signal })
      .then(({ ticket }) => {
        if (lifetime.signal.aborted) return;
        const url = connection.url.replace(/^http/, "ws");
        const current = new WebSocket(url + "/notifications?ticket=" + encodeURIComponent(ticket));
        socket = current;

        function disconnect() {
          if (socket !== current) return;
          socket = undefined;
          clearTimeout(attemptTimeout);
          current.close();
          reconnect();
        }

        attemptTimeout = setTimeout(disconnect, 10_000);
        current.onopen = () => {
          if (socket !== current) return;
          clearTimeout(attemptTimeout);
          delay = 1000;
          requestSync();
        };
        current.onclose = disconnect;
        current.onerror = disconnect;
        current.onmessage = ({ data }) => {
          if (socket === current && decodeNotification(data)._tag === "Some") requestSync();
        };
      })
      .catch(reconnect);
  }

  requestSync();
  const refresh = setInterval(requestSync, 60_000);
  connect();

  return () => {
    lifetime.abort();
    clearInterval(refresh);
    clearTimeout(retry);
    clearTimeout(attemptTimeout);
    const current = socket;
    socket = undefined;
    current?.close();
  };
}
