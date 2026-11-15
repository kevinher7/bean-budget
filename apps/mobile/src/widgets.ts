import { Data, Effect } from "effect";
import { requireNativeModule } from "expo";

class WidgetRefreshError extends Data.TaggedError("WidgetRefreshError")<{
  cause: unknown;
}> {}

export const refreshWidgets = Effect.tryPromise({
  try: () => requireNativeModule<{ refresh(): Promise<void> }>("BeanWidgets").refresh(),
  catch: (cause) => new WidgetRefreshError({ cause }),
});
