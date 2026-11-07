import { Data, Effect, Schema } from "effect";
import { getItemAsync, setItemAsync } from "expo-secure-store";

class ConnectionError extends Data.TaggedError("ConnectionError")<{ message: string }> {}

const Connection = Schema.Struct({ url: Schema.String, token: Schema.String });

export const loadConnection = Effect.tryPromise({
  try: () => getItemAsync("bean-connection"),
  catch: () =>
    new ConnectionError({ message: "Cannot read saved connection. Try reopening the app." }),
}).pipe(
  Effect.flatMap((value) =>
    value === null
      ? Effect.succeed(null)
      : Schema.decodeUnknownEffect(Schema.fromJsonString(Connection))(value),
  ),
);

export const saveConnection = Effect.fn("saveConnection")(function* (url: string, token: string) {
  const normalized = url.trim().replace(/\/+$/, "");
  const valid = yield* Effect.try({
    try: () => {
      const parsed = new URL(normalized);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== "/"
      )
        throw new Error("URL");
      if (
        parsed.protocol === "http:" &&
        !["10.0.2.2", "127.0.0.1", "localhost"].includes(parsed.hostname)
      )
        throw new Error("HTTPS");
      if (!token.trim()) throw new Error("Token");
      return { url: normalized, token: token.trim() };
    },
    catch: () =>
      new ConnectionError({
        message: "Enter an HTTPS server URL and token. Local emulator addresses may use HTTP.",
      }),
  });
  const previous = yield* loadConnection;
  if (previous && previous.url !== valid.url)
    return yield* Effect.fail(
      new ConnectionError({
        message:
          "This register is connected to another server. Keep its saved server URL to protect account mappings.",
      }),
    );
  yield* Effect.tryPromise({
    try: () => setItemAsync("bean-connection", JSON.stringify(valid)),
    catch: () => new ConnectionError({ message: "Cannot save connection securely. Try again." }),
  });
  return valid;
});
