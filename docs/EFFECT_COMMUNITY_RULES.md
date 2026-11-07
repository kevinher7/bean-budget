# Effect community rules for Bean Budget

Research: 2026-11-05. Implementation handoff, not installed configuration. Effect **4.1.2** confirmed from this checkout's installed package. Only this report was written in the project. Package downloads, installs and executable checks were isolated under `/tmp/bean-effect-research`.

## Recommended decisions

1. Install pinned Oxlint **1.91.0**, `oxlint-tsgolint` **7.0.2005**, TypeScript **6.0.3**, and `@effect/language-service` **0.87.5**. Use separate compiler, typed Oxlint and Effect diagnostic CI steps. The last pair was exercised against Effect 4.1.2 in a temporary project.
2. Make floating Effects, missing delegation, accidentally nested Effects, Promise-returning `sync`, unsafe Effect assertions and lifecycle composition mistakes errors. Promote selected official diagnostics explicitly; several ship as suggestions/off.
3. Make generator simplification, `Effect.fn` opportunities, map/flatMap simplification and pipe cleanup warnings. Use named `Effect.fn` for reusable operations; retain `Effect.gen` for program values, scoped workflows and inline transactions.
4. Add **selected** `@shekohex/oxc-effect@0.2.1` rules, particularly callback aliases. Do not extend its full/core preset wholesale: it includes restrictions on valid `Effect.as`, `switch`, React state, `null`, `try/catch`, nested combinators and legitimate boundary code. Some replacement advice is stale even though it claims v4 support.
5. Keep runtime execution at application/host edges; keep domain calculations pure. Apply ambient API, runtime, logging and import restrictions by package/path. Use review and behavioral checks for resource lifetimes and swallowed failures; syntax rules cannot establish these properties.

## The remembered generator pattern: evidence and exact distinctions

I inspected `../spend-bean` at `3daab25178a3719923b861e4f34dc8b4bb7aea47`, its current `AGENTS.md`, `.oxlintrc.json`, scripts and all available Git history including checkpoint refs. Searches of historical markdown/configs for `Effect.gen`, generators, stored/piped patterns found **no generator-specific rule**. Commit `e204f359dc9bb7ee66fe75d51624a5582ec75927` adds the actual architectural rules: no casts, `Effect.provide`, or `Effect.runPromise/runSync/runFork` in core. It does not forbid generators or pipes. Commit `c24a9ca37956ded63634bdf64f6095296ce477b3` deliberately consolidates fetching, selecting and saving into a single generator followed by provisioning. Current `src/core/program.ts`, adapters, widget handler and app still store `Effect.gen(...).pipe(...)` values. Thus the recollection cannot honestly be attributed to a checked-in Spend Bean generator rule.

The **exact matching community rule** is `effect/no-effect-gen-callback-alias`: it rejects passing an **identifier as the generator callback**, separating the body from its construction site. The companion is `effect/no-effect-fn-callback-alias`. This is readability policy, not a resource-safety error. [Published implementation source](https://github.com/shekohex/oxc-effect-linting-rules/blob/master/rules/core.js).

```ts
// Callback alias: rejected by no-effect-gen-callback-alias
const savedGenerator = function* () {
  return yield* Effect.succeed(1);
};
const workflow = Effect.gen(savedGenerator).pipe(Effect.asVoid);

// Inline callback: allowed by that rule, including the pipe
const workflow2 = Effect.gen(function* () {
  yield* Effect.log("starting");
  return yield* Effect.succeed(1);
}).pipe(Effect.asVoid);

// A reusable function returning gen: separate prefer-effect-fn policy
const load = (id: string) =>
  Effect.gen(function* () {
    /* ... */
  });
const load2 = Effect.fn("Budget.load")(function* (id: string) {
  /* ... */
});
```

Do not conflate these further patterns:

- `no-pipeline-fragment-staging` flags a block that stores a `.pipe(...)` fragment in a `const`, then returns another pipe referencing the fragment. It is generic AST policy, not specifically a generator rule. Example: `function f() { const stage = source.pipe(transform); return stage.pipe(finish) }`.
- `no-pipe-ladder` flags a pipe nested within arguments of another pipe. It can reject intentional local error/retry boundaries; avoid a global ban.
- Official `nestedEffectGenYield` flags **bare** `yield* Effect.gen(...)` inside a generator. Its implementation tests the yielded expression directly; a meaningful piped nested scope is a different case. Spend Bean's refresh has a nested piped generator for localized error handling. Do not mechanically flatten away that boundary.
- Official `unnecessaryEffectGen` simplifies a trivial single statement generator, including a single delegated yield (verified), not every stored generator.
- Official `returnEffectInGen` detects `return effect` producing an Effect as the success value; usually write `return yield* effect`. This is a real accidental non-execution hazard.

## Tooling and version compatibility

Versions below are npm `latest` observations on the research date, except where explicitly described as repository HEAD. Primary metadata can be reproduced with `npm view <package> version peerDependencies engines --json`.

| Package                     | Version          | Decision / compatibility                                                                                                      |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `effect`                    | 4.1.2            | Installed locally and in smoke test                                                                                           |
| `typescript`                | 6.0.3 tested     | Keep normal `tsc`; no project compiler was installed here                                                                     |
| `oxlint`                    | 1.91.0           | Requires Node `^20.19.0                                                                                                       |     | >=22.12.0`; fits this repo's Node 22.22.3 |
| `oxlint-tsgolint`           | 7.0.2005         | Oxlint 1.91 peer range is `>=7.0.2005`; do not copy sibling's older 2004 blindly                                              |
| `@effect/language-service`  | 0.87.5           | Tested with TS 6.0.3 / Effect 4.1.2; standalone CLI works                                                                     |
| `@effect/eslint-plugin`     | 0.3.2            | Official, but exports only `dprint` and `no-import-from-barrel-package`                                                       |
| `@shekohex/oxc-effect`      | 0.2.1            | Oxlint JS plugin, Effect peer `^4.0.0-beta.0`, optional atom peer; tested custom subset                                       |
| `@effect/tsgo`              | 0.67.1 published | Alternative native integration; HEAD README advertises **0.67.2**, so do not apply HEAD compatibility table blindly to 0.67.1 |
| `@enfect/oxlint`            | 0.10.0           | Current successor to `mpsuesser/oxlint-plugin-effect`; repo targets stable Effect 4.1.0                                       |
| `oxlint-plugin-effect`      | 0.32.1           | cevr repository, different from mpsuesser; peer `>=4.1.0 <5`                                                                  |
| `effect-rules`              | 0.3.6            | EduSantosBrito; opinionated boundary/error/style rules                                                                        |
| `@opsydyn/oxlint-effect`    | 2.0.1            | 2.x defaults to v4; 1.x defaults to v3; exports separate legacy `effect3` policy                                              |
| `@catenarycloud/linteffect` | 0.1.0            | Biome Grit antecedent; not an Oxlint plugin                                                                                   |

Oxlint's JS plugin interface is alpha. Register a plugin with `jsPlugins`, not the built-in `plugins` list. Its ESLint-compatible visitor API does not mean arbitrary ESLint typed plugins can access a TS checker. `@shekohex/oxc-effect` is syntax-based, uses `eslintCompatPlugin`/`createOnce`, and depends on Oxlint itself. Pin the root binary and check deduplication in the lockfile. [Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins), [typed linting](https://oxc.rs/docs/guide/usage/linter/type-aware).

The official [ESLint exports](https://github.com/Effect-TS/eslint-plugin/blob/main/src/plugin.ts) provide formatting/import policy, not floating Effects or resource safety. No reason to add ESLint solely for those two rules when using Oxfmt/Oxlint and the official semantic diagnostics.

### Community alternatives actually found

These are independent authors' policies, not evidence that every Effect project uses every rule. Avoid loading several plugins under the same `effect` name.

- [Enfect](https://github.com/mpsuesser/enfect/tree/main/plugins/oxlint): 74 advertised rules, stable v4 focus. The older `mpsuesser/oxlint-plugin-effect` repository points here; do not confuse that move with cevr's npm package. Candidate alternative to investigate if a broader maintained pack is desired.
- [cevr/effect-oxlint](https://github.com/cevr/effect-oxlint): strict syntax-based package `oxlint-plugin-effect`. Exact candidates include `effect/noEagerAcquire`, `effect/noManagedRuntimeInEffect`, `effect/requireNamedEffectFn`, `effect/requireSuppressionReason`. Its recommended preset also bans all async functions, try/finally, ternaries, most comments and nullish values; unsuitable wholesale for Bean Budget. API advice requires 4.1 crypto services.
- [EduSantosBrito/effect-rules](https://github.com/EduSantosBrito/effect-rules): exact candidates `effect/no-silent-error-swallow`, `effect/no-schema-error-response-leak`, `effect/prefer-fork-scoped-in-layer`, `effect/no-unsupported-effect-api`. Global bans on casts, errors, escapes and Promise constructs need scoped exceptions. Its current API guide correctly identifies removed `Effect.async`; inspect implementation before enabling name-based migration bans.
- [zaniluca/effect-rules](https://github.com/zaniluca/effect-rules): package `@zaniluca/effect-rules`; explicitly complements `@effect/tsgo`, exposes `recommendedConfig`, `strictConfig` and adapter boundary rules. Do not confuse with the unscoped package above. Not executable-tested here.
- [opsydyn/oxlint-effect](https://github.com/opsydyn/oxlint-effect): advertises 146 rules, 141 qualified v4 cases and five legacy policies. Good audit example, but its broad DDD/architecture policies require selection. Version-major compatibility matters; not executable-tested here.
- [Biome antecedent](https://github.com/OperationalFallacy/biome-effect-linting-rules): useful history of community preferences, not drop-in Oxlint configuration.

## Safety errors to enforce first

Use official diagnostics for semantic checks; use scoped syntax policy only to fill deliberate gaps.

| Official diagnostic                                                       | Action / practical meaning                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `floatingEffect`                                                          | Error. Discarded cold Effect never executes. Assignment satisfies the rule; it does not prove later use.                                               |
| `missingStarInYieldEffectGen`                                             | Error. Delegate Effects with `yield*`, not bare `yield`.                                                                                               |
| `missingReturnYieldStar`                                                  | Error. Preserve termination/narrowing when yielding failures or other `never` successes.                                                               |
| `returnEffectInGen`, `effectInVoidSuccess`, `effectInFailure`             | Error. Usually accidental nested Effects or Effect-valued failures; explicitly document intentional Effect-valued data.                                |
| `lazyPromiseInEffectSync`                                                 | Error. `sync` returning a Promise does not await it or track rejection. Use `tryPromise` and meaningful error mapping.                                 |
| `unsafeEffectTypeAssertion`                                               | Error. Do not erase error/requirement channels with assertions.                                                                                        |
| `missingEffectContext`, `missingEffectError`, `missingLayerContext`       | Retain errors. Exposes gaps in Effect/Layer channel declarations.                                                                                      |
| `classSelfMismatch`, `effectFnImplicitAny`, `overriddenSchemaConstructor` | Retain errors. Broken Self types, implicit parameters and Schema construction.                                                                         |
| `layerMergeAllWithDependencies`                                           | Error. Merging does not wire one sibling's outputs into another sibling's inputs.                                                                      |
| `multipleEffectProvide`                                                   | Error initially, allow justified exceptions. Separate provisioning can duplicate scoped services; compose the intended layer graph.                    |
| `runEffectInsideEffect`                                                   | Error initially. Keep work in the existing fiber/context; bridge foreign callbacks deliberately rather than calling a runner in ordinary Effect logic. |
| `outdatedApi`, `duplicatePackage`                                         | Error. Particularly valuable during v4 adoption and in a workspace.                                                                                    |

For error hygiene use warnings first: `anyUnknownInErrorContext`, `globalErrorInEffectFailure`, `globalErrorInEffectCatch`, `unknownInEffectCatch`, `tryCatchInEffectGen`. Use tagged domain errors, preserve causes privately, and decode external `unknown`. Unknown at a raw adapter boundary is legitimate; widen it into a stable application error before exposing the service. Do not turn defects/cancellation into successful defaults. `catchTag` for expected domain recovery is preferable to broad `catchCause` recovery. Broad cause handlers remain valid for reporting/finalization at host boundaries. `try/catch` around a `yield*` does not substitute for typed Effect failure recovery.

`catchUnfailableEffect` catches dead handlers; it does not catch all swallowed failures. A `catchTag(..., () => Effect.succeed(default))` may be intentional. If swallowing becomes recurrent, adopt a narrowly scoped community rule with positive/negative fixtures for expected fallback versus unreported data loss. No lint rule proves transaction rollback or accounting correctness.

### Resource, runtime and logging policy

Use `Effect.acquireRelease` under `Effect.scoped` or a layer-owned scope; use `acquireUseRelease` for a lexical acquire/use/release lifetime. Acquisition must happen inside the lazy constructor, not before `Effect.succeed(resource)`. Return cleanup Effects; don't merely construct and discard them. Exercise release on success, typed failure, defect and interruption. Fork layer-owned background work with `forkScoped`; choose child ownership deliberately with v4 `forkChild`. Avoid detached lifetime work unless a host edge owns its shutdown. [Official v4 finalization](https://effect.website/docs/v4/resource-management/introduction), [official scoped service example](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/01_effect/05_resources/10_acquire-release.ts).

There is no general acquire/release pairing proof in the JS language-service inventory. `multipleEffectProvide` and `layerMergeAllWithDependencies` address particular composition hazards. cevr's `noEagerAcquire` and Edu's `prefer-fork-scoped-in-layer` are candidate additional guards, not leak proofs.

Effect 4.1.2 `Layer.effect` owns Scope requirements; **do not enable v3-only `scopeInLayerEffect` or recommend `Layer.scoped` from old examples**. Local provisioning can be meaningful. Leave `strictEffectProvide` off globally; enforce concrete shared-package boundaries separately. Spend Bean's literal `no-restricted-properties` policy misses renamed imports, destructuring, runtime instances and wrappers; enumerate installed v4 runner exports and review aliases before claiming comprehensive coverage.

Enable `globalConsoleInEffect` as a warning or scoped error, using `Effect.log*` and Logger layers for structured, fiber-aware logs. Prefer `Clock`/`DateTime`, Random, Config and HttpClient in effectful service code. Pure budget functions should receive time/data as arguments. Adapters and build/config tools may need native APIs. Avoid logging credentials, email bodies or full Schema failures in HTTP responses; logging policy does not redact by itself.

## Runnable initial configuration

Merge with actual project tsconfigs and boundaries. Both complete JSON snippets below were extracted back out of this report and executed in the temporary project: typed Oxlint and the standalone Effect CLI accepted the clean generator/pipe fixture with exit 0. Run every workspace project explicitly; a solution tsconfig containing only references may not scan source files with the standalone diagnostic CLI.

```sh
npm install -D --save-exact typescript@6.0.3 oxlint@1.91.0 oxlint-tsgolint@7.0.2005 @effect/language-service@0.87.5 @shekohex/oxc-effect@0.2.1
```

`compilerOptions.plugins` entry (editor must select workspace TypeScript):

```json
{
  "name": "@effect/language-service",
  "diagnosticSeverity": {
    "floatingEffect": "error",
    "missingStarInYieldEffectGen": "error",
    "missingReturnYieldStar": "error",
    "returnEffectInGen": "error",
    "effectInVoidSuccess": "error",
    "effectInFailure": "error",
    "lazyPromiseInEffectSync": "error",
    "unsafeEffectTypeAssertion": "error",
    "layerMergeAllWithDependencies": "error",
    "multipleEffectProvide": "error",
    "runEffectInsideEffect": "error",
    "outdatedApi": "error",
    "duplicatePackage": "error",
    "anyUnknownInErrorContext": "warning",
    "tryCatchInEffectGen": "warning",
    "globalConsoleInEffect": "warning",
    "effectFnOpportunity": "warning",
    "unnecessaryEffectGen": "warning",
    "nestedEffectGenYield": "warning",
    "effectFnIife": "warning",
    "catchUnfailableEffect": "warning",
    "catchAllToMapError": "warning",
    "flatMapToMap": "warning",
    "effectMapFlatten": "warning",
    "unnecessaryPipe": "warning",
    "unnecessaryPipeChain": "warning"
  }
}
```

Initial `.oxlintrc.json` (scope the Effect style rules further as source packages develop):

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "import", "promise"],
  "categories": { "correctness": "error" },
  "jsPlugins": [{ "name": "effect", "specifier": "@shekohex/oxc-effect" }],
  "rules": {
    "typescript/no-floating-promises": ["error", { "ignoreVoid": false }],
    "typescript/no-misused-promises": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "effect/no-effect-gen-callback-alias": "warn",
    "effect/no-effect-fn-callback-alias": "warn",
    "effect/prefer-effect-fn": "warn"
  }
}
```

Promises and Effects require different floating-value checks. `no-floating-promises` does not check cold Effects; `floatingEffect` does not replace Promise rejection handling. `void` doesn't handle rejection. `no-misused-promises` doesn't reject every Promise-valued `Effect.map` callback; the native `promiseInEffectSuccess` diagnostic provides broader semantic coverage if moving to the native toolchain. See [typescript-eslint floating promises](https://typescript-eslint.io/rules/no-floating-promises/) and [Oxlint rule reference](https://oxc.rs/docs/guide/usage/linter/rules.html).

CI commands:

```sh
npx tsc --noEmit -p path/to/tsconfig.json
npx oxlint --type-aware .
npx effect-language-service diagnostics --project path/to/tsconfig.json
```

Ordinary `tsc` **does not load** language-service plugins. Neither `oxlint --type-aware` nor `--type-check` automatically runs the JS Effect service. The standalone command above needs no patch. Errors fail it; warnings fail only with `--strict` (verified). Keep warnings advisory initially; later gate cleanup with `diagnostics --strict` and Oxlint `--deny-warnings`. Do not treat message/suggestion defaults as CI failures. [Official CLI source](https://github.com/Effect-TS/language-service/blob/main/packages/language-service/src/cli/diagnostics.ts).

### Native alternative, not an extra parallel requirement

The [official native wrapper](https://github.com/Effect-TS/tsgo) offers `effect-tsgo diagnostics --project ...` and `effect-tsgo oxlint --type-aware`. The latter loads patched native bindings and tsgolint; it is materially different from plain Oxlint. It exposes more diagnostics than the JS plugin (inventory below). Prefer wrapper commands over mutating `node_modules`; do not run duplicate native and JS diagnostic gates without a migration reason.

HEAD README for unpublished 0.67.2 supports TS 7.0.2 / 7.1 beta, Oxlint 1.88–1.91, and tsgolint 2004/2005, and excludes musl for patched native builds. Read the **selected release's** supported-component metadata before installation. This report smoke-tested the TS6/JS route, not native binaries. TS7 requires the native service instead of `@effect/language-service`. Config names are camelCase under `diagnosticSeverity`; native Oxlint identifiers use its `effecttsgo` namespace and rule-specific kebab names—copy from that release's docs rather than mechanically prefixing camelCase names.

## Executed acceptance checks and fixtures to retain during implementation

In the isolated project with the pinned versions above:

| Fixture / command                                                                                             | Observed                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Discarded `Effect.succeed(1)` + Promise-returning sync + generator `return Effect.succeed(1)`; `tsc --noEmit` | Exit 0                                                                                     |
| Same fixture; Effect diagnostics CLI with promoted severities                                                 | Exit 1; exact `floatingEffect`, `lazyPromiseInEffectSync`, `returnEffectInGen` diagnostics |
| `const saved = function* ...; Effect.gen(saved).pipe(...)`; selected Oxlint plugin                            | Exit 1; `no-effect-gen-callback-alias`                                                     |
| Inline generator with two delegated log operations followed by `.pipe(Effect.asVoid)`                         | Compiler, Effect CLI, Oxlint all exit 0                                                    |
| Single `return yield* Effect.succeed(1)` generator; `unnecessaryEffectGen: warning`                           | CLI exit 0; `--strict` exit 1                                                              |

Implementation should additionally verify missing `yield*`, unsafe channel narrowing, nested void effects, dead catches, explicit callback aliases, and permitted host runners. Add negative cases for named import aliases and local objects named `Effect` to document syntax-plugin misses/false positives. Run typed rules against a rejected Promise and unsafe JSON assignment. Check actual workspace traversal and CI exit status, not only whether the config parses. Test resource cleanup behavior where resources exist, including interruption. The tests above are lint-tool smoke checks, not application tests.

## Full official JavaScript language-service inventory

Every diagnostic in the inspected official catalog is included below; the v4 column is the upstream support declaration, not a claim that every case was executed here. Source snapshot `cb91d700a10e86de46d57b94261d4dcc9c92fc20`. [Catalog](https://github.com/Effect-TS/language-service#diagnostics), [individual implementations](https://github.com/Effect-TS/language-service/tree/main/packages/language-service/src/diagnostics). Defaults are especially relevant: suggestions are not the same as lint warnings.

| Group         | Exact diagnostic                 | Default    | v4              |
| ------------- | -------------------------------- | ---------- | --------------- |
| Correctness   | `anyUnknownInErrorContext`       | off        | yes             |
| Correctness   | `classSelfMismatch`              | error      | yes             |
| Correctness   | `duplicatePackage`               | warning    | yes             |
| Correctness   | `effectFnImplicitAny`            | error      | yes             |
| Correctness   | `floatingEffect`                 | error      | yes             |
| Correctness   | `genericEffectServices`          | warning    | yes             |
| Correctness   | `missingEffectContext`           | error      | yes             |
| Correctness   | `missingEffectError`             | error      | yes             |
| Correctness   | `missingLayerContext`            | error      | yes             |
| Correctness   | `missingReturnYieldStar`         | error      | yes             |
| Correctness   | `missingStarInYieldEffectGen`    | error      | yes             |
| Correctness   | `nonObjectEffectServiceType`     | error      | **no: v3 only** |
| Correctness   | `outdatedApi`                    | warning    | yes             |
| Correctness   | `outdatedEffectCodegen`          | warning    | yes             |
| Correctness   | `overriddenSchemaConstructor`    | error      | yes             |
| Correctness   | `unsupportedServiceAccessors`    | warning    | yes             |
| Anti-pattern  | `catchUnfailableEffect`          | suggestion | yes             |
| Anti-pattern  | `effectFnIife`                   | warning    | yes             |
| Anti-pattern  | `effectGenUsesAdapter`           | warning    | yes             |
| Anti-pattern  | `effectInFailure`                | warning    | yes             |
| Anti-pattern  | `effectInVoidSuccess`            | warning    | yes             |
| Anti-pattern  | `globalErrorInEffectCatch`       | warning    | yes             |
| Anti-pattern  | `globalErrorInEffectFailure`     | warning    | yes             |
| Anti-pattern  | `layerMergeAllWithDependencies`  | warning    | yes             |
| Anti-pattern  | `lazyPromiseInEffectSync`        | warning    | yes             |
| Anti-pattern  | `leakingRequirements`            | suggestion | yes             |
| Anti-pattern  | `multipleEffectProvide`          | warning    | yes             |
| Anti-pattern  | `returnEffectInGen`              | suggestion | yes             |
| Anti-pattern  | `runEffectInsideEffect`          | suggestion | yes             |
| Anti-pattern  | `schemaSyncInEffect`             | suggestion | **no: v3 only** |
| Anti-pattern  | `scopeInLayerEffect`             | warning    | **no: v3 only** |
| Anti-pattern  | `strictEffectProvide`            | off        | yes             |
| Anti-pattern  | `tryCatchInEffectGen`            | suggestion | yes             |
| Anti-pattern  | `unknownInEffectCatch`           | warning    | yes             |
| Effect-native | `asyncFunction`                  | off        | yes             |
| Effect-native | `cryptoRandomUUID`               | off        | yes             |
| Effect-native | `cryptoRandomUUIDInEffect`       | off        | yes             |
| Effect-native | `extendsNativeError`             | off        | yes             |
| Effect-native | `globalConsole`                  | off        | yes             |
| Effect-native | `globalConsoleInEffect`          | off        | yes             |
| Effect-native | `globalDate`                     | off        | yes             |
| Effect-native | `globalDateInEffect`             | off        | yes             |
| Effect-native | `globalFetch`                    | off        | yes             |
| Effect-native | `globalFetchInEffect`            | off        | yes             |
| Effect-native | `globalRandom`                   | off        | yes             |
| Effect-native | `globalRandomInEffect`           | off        | yes             |
| Effect-native | `globalTimers`                   | off        | yes             |
| Effect-native | `globalTimersInEffect`           | off        | yes             |
| Effect-native | `instanceOfSchema`               | off        | yes             |
| Effect-native | `newPromise`                     | off        | yes             |
| Effect-native | `nodeBuiltinImport`              | off        | yes             |
| Effect-native | `preferSchemaOverJson`           | off        | yes             |
| Effect-native | `processEnv`                     | off        | yes             |
| Effect-native | `processEnvInEffect`             | off        | yes             |
| Effect-native | `unsafeEffectTypeAssertion`      | off        | yes             |
| Style         | `catchAllToMapError`             | suggestion | yes             |
| Style         | `deterministicKeys`              | off        | yes             |
| Style         | `effectDoNotation`               | off        | yes             |
| Style         | `effectFnOpportunity`            | suggestion | yes             |
| Style         | `effectMapFlatten`               | suggestion | yes             |
| Style         | `effectMapVoid`                  | suggestion | yes             |
| Style         | `effectSucceedWithVoid`          | suggestion | yes             |
| Style         | `flatMapToMap`                   | suggestion | yes             |
| Style         | `importFromBarrel`               | off        | yes             |
| Style         | `missedPipeableOpportunity`      | off        | yes             |
| Style         | `missingEffectServiceDependency` | off        | **no: v3 only** |
| Style         | `nestedEffectGenYield`           | off        | yes             |
| Style         | `redundantSchemaTagIdentifier`   | suggestion | yes             |
| Style         | `schemaStructWithTag`            | suggestion | yes             |
| Style         | `schemaUnionOfLiterals`          | off        | **no: v3 only** |
| Style         | `serviceNotAsClass`              | off        | yes             |
| Style         | `strictBooleanExpressions`       | off        | yes             |
| Style         | `unnecessaryArrowBlock`          | off        | yes             |
| Style         | `unnecessaryEffectGen`           | suggestion | yes             |
| Style         | `unnecessaryFailYieldableError`  | suggestion | yes             |
| Style         | `unnecessaryPipe`                | suggestion | yes             |
| Style         | `unnecessaryPipeChain`           | suggestion | yes             |

Count: **77**. V3-only rules must stay disabled in this project even when their descriptions sound useful. Off-by-default Effect-native rules are policy choices; enable ambient APIs inside service code selectively, not globally over adapters and tooling.

## Native official catalog: full name inventory and differences

The native catalog evolves independently. This is the complete HEAD README name inventory inspected during research, grouped as upstream groups it. It is **not** a promise these all exist in published 0.67.1 or JS 0.87.5. Individual linked rule pages specify version support/defaults/examples. Particularly useful extra native checks are `promiseInEffectSuccess`, `floatingEffectInVitest`, and `effectTryWithoutCatch`. Resource helpers such as `acquireReleaseDisposable` are cleanup guidance and require checking the exact installed API.

Correctness:

- [`anyUnknownInErrorContext`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/any-unknown-in-error-context.md)
- [`classSelfMismatch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/class-self-mismatch.md)
- [`duplicatePackage`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/duplicate-package.md)
- [`effectFnImplicitAny`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-implicit-any.md)
- [`errorPayloadShadowsName`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/error-payload-shadows-name.md) (native catalog addition)
- [`experimentalApiUsage`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/experimental-api-usage.md) (native catalog addition)
- [`floatingEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/floating-effect.md)
- [`floatingEffectInVitest`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/floating-effect-in-vitest.md) (native catalog addition)
- [`genericEffectServices`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/generic-effect-services.md)
- [`missingEffectContext`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-context.md)
- [`missingEffectError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-error.md)
- [`missingLayerContext`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-layer-context.md)
- [`missingReturnYieldStar`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-return-yield-star.md)
- [`missingStarInYieldEffectGen`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-star-in-yield-effect-gen.md)
- [`nonObjectEffectServiceType`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/non-object-effect-service-type.md)
- [`obsoleteMatchImport`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/obsolete-match-import.md) (native catalog addition)
- [`obsoleteSchemaImport`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/obsolete-schema-import.md) (native catalog addition)
- [`outdatedApi`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/outdated-api.md)
- [`overriddenSchemaConstructor`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/overridden-schema-constructor.md)
- [`promiseInEffectSuccess`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/promise-in-effect-success.md) (native catalog addition)
- [`schemaClassMissingBrand`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-class-missing-brand.md) (native catalog addition)
- [`schemaClassObjectLiteral`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-class-object-literal.md) (native catalog addition)
- [`schemaLiteralNonFinite`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-literal-non-finite.md) (native catalog addition)
- [`schemaOpaqueInstanceMember`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-opaque-instance-member.md) (native catalog addition)
- [`unsafeEffectTypeAssertion`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unsafe-effect-type-assertion.md)
- [`unstableApiUsage`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unstable-api-usage.md) (native catalog addition)

Anti-pattern:

- [`catchUnfailableEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-unfailable-effect.md)
- [`effectFnIife`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-iife.md)
- [`effectGenUsesAdapter`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-gen-uses-adapter.md)
- [`effectInFailure`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-in-failure.md)
- [`effectInVoidSuccess`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-in-void-success.md)
- [`effectTryWithoutCatch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-try-without-catch.md) (native catalog addition)
- [`globalErrorInEffectCatch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-error-in-effect-catch.md)
- [`globalErrorInEffectFailure`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-error-in-effect-failure.md)
- [`layerMergeAllWithDependencies`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/layer-merge-all-with-dependencies.md)
- [`lazyEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/lazy-effect.md) (native catalog addition)
- [`lazyPromiseInEffectSync`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/lazy-promise-in-effect-sync.md)
- [`leakingRequirements`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/leaking-requirements.md)
- [`multipleEffectProvide`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/multiple-effect-provide.md)
- [`preferUnsafeConstructor`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-unsafe-constructor.md) (native catalog addition)
- [`returnEffectInGen`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/return-effect-in-gen.md)
- [`runEffectInsideEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/run-effect-inside-effect.md)
- [`schemaSyncInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-sync-in-effect.md)
- [`scopeInLayerEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/scope-in-layer-effect.md)
- [`strictEffectProvide`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-effect-provide.md)
- [`tryCatchInEffectGen`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/try-catch-in-effect-gen.md)
- [`unknownInEffectCatch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unknown-in-effect-catch.md)

Effect-native:

- [`abortControllerInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/abort-controller-in-effect.md) (native catalog addition)
- [`asyncFunction`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/async-function.md)
- [`cryptoRandomUUID`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/crypto-random-uuid.md)
- [`cryptoRandomUUIDInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/crypto-random-uuid-in-effect.md)
- [`extendsNativeError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/extends-native-error.md)
- [`globalConsole`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-console.md)
- [`globalConsoleInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-console-in-effect.md)
- [`globalDate`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-date.md)
- [`globalDateInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-date-in-effect.md)
- [`globalFetch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-fetch.md)
- [`globalFetchInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-fetch-in-effect.md)
- [`globalJson`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-json.md) (native catalog addition)
- [`globalJsonInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-json-in-effect.md) (native catalog addition)
- [`globalRandom`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-random.md)
- [`globalRandomInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-random-in-effect.md)
- [`globalTimers`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-timers.md)
- [`globalTimersInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-timers-in-effect.md)
- [`instanceOfSchema`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/instance-of-schema.md)
- [`newPromise`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/new-promise.md)
- [`nodeBuiltinImport`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/node-builtin-import.md)
- [`preferEffectArray`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-array.md) (native catalog addition)
- [`preferEffectRecord`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-record.md) (native catalog addition)
- [`preferEffectString`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-string.md) (native catalog addition)
- [`preferSchemaOverJson`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-over-json.md)
- [`processEnv`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/process-env.md)
- [`processEnvInEffect`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/process-env-in-effect.md)
- [`schemaSync`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-sync.md) (native catalog addition)

Style:

- [`acquireReleaseDisposable`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/acquire-release-disposable.md) (native catalog addition)
- [`allOfMapToForEach`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/all-of-map-to-for-each.md) (native catalog addition)
- [`catchAllTagDispatchToCatchTag`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-all-tag-dispatch-to-catch-tag.md) (native catalog addition)
- [`catchAllToMapError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-all-to-map-error.md)
- [`catchChainToFirstSuccessOf`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-chain-to-first-success-of.md) (native catalog addition)
- [`catchConditionalRefailToCatchIf`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-conditional-refail-to-catch-if.md) (native catalog addition)
- [`catchDieToOrDie`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-die-to-or-die.md) (native catalog addition)
- [`catchIfTagToCatchTag`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-if-tag-to-catch-tag.md) (native catalog addition)
- [`catchRefailToTapError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-refail-to-tap-error.md) (native catalog addition)
- [`catchTagToCatchReason`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-tag-to-catch-reason.md) (native catalog addition)
- [`catchToIgnore`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-to-ignore.md) (native catalog addition)
- [`catchToOrElseSucceed`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-to-or-else-succeed.md) (native catalog addition)
- [`deterministicKeys`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/deterministic-keys.md)
- [`effectDoNotation`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-do-notation.md)
- [`effectFnOpportunity`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-opportunity.md)
- [`effectMapFlatten`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-map-flatten.md)
- [`effectMapVoid`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-map-void.md)
- [`effectSleepZeroToYieldNow`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-sleep-zero-to-yield-now.md) (native catalog addition)
- [`effectSucceedWithUndefined`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-succeed-with-undefined.md) (native catalog addition)
- [`effectSucceedWithVoid`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-succeed-with-void.md)
- [`failCauseToConstructor`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/fail-cause-to-constructor.md) (native catalog addition)
- [`flatMapConditionalToFilterOrFail`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-conditional-to-filter-or-fail.md) (native catalog addition)
- [`flatMapIdentityToFlatten`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-identity-to-flatten.md) (native catalog addition)
- [`flatMapIgnoredParamToAndThen`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-ignored-param-to-and-then.md) (native catalog addition)
- [`flatMapToMap`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-to-map.md)
- [`flatMapToTap`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-to-tap.md) (native catalog addition)
- [`manualMetricTapToTrack`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/manual-metric-tap-to-track.md) (native catalog addition)
- [`mapConstToAs`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/map-const-to-as.md) (native catalog addition)
- [`mapMapErrorToMapBoth`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/map-map-error-to-map-both.md) (native catalog addition)
- [`mapSomeCatchNoSuchElement`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/map-some-catch-no-such-element.md) (native catalog addition)
- [`mapSomeToAsSome`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/map-some-to-as-some.md) (native catalog addition)
- [`matchBooleanToIsSuccess`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-boolean-to-is-success.md) (native catalog addition)
- [`matchEffectToMapBoth`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-effect-to-map-both.md) (native catalog addition)
- [`matchEffectToMatch`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-effect-to-match.md) (native catalog addition)
- [`matchToResultOrOption`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-to-result-or-option.md) (native catalog addition)
- [`missedPipeableOpportunity`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missed-pipeable-opportunity.md)
- [`missingEffectServiceDependency`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-service-dependency.md)
- [`missingPipeableSignature`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-pipeable-signature.md) (native catalog addition)
- [`multipleCatchTag`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/multiple-catch-tag.md) (native catalog addition)
- [`nestedEffectGenYield`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/nested-effect-gen-yield.md)
- [`newSchemaClass`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/new-schema-class.md) (native catalog addition)
- [`optionMatchToFromOption`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/option-match-to-from-option.md) (native catalog addition)
- [`preferBarrelImport`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-barrel-import.md) (native catalog addition)
- [`preferNamespaceImport`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-namespace-import.md) (native catalog addition)
- [`preferSchemaTaggedError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-tagged-error.md) (native catalog addition)
- [`preferSchemaTypeProperty`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-type-property.md) (native catalog addition)
- [`preferSucceedSomeOrNone`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-succeed-some-or-none.md) (native catalog addition)
- [`preferTypedSchemaDecoder`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-typed-schema-decoder.md) (native catalog addition)
- [`provideLayerSucceedToProvideService`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/provide-layer-succeed-to-provide-service.md) (native catalog addition)
- [`provideMergeAllToArray`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/provide-merge-all-to-array.md) (native catalog addition)
- [`raceFirstWithSleepToTimeout`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/race-first-with-sleep-to-timeout.md) (native catalog addition)
- [`redundantMapError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-map-error.md) (native catalog addition)
- [`redundantOrDie`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-or-die.md) (native catalog addition)
- [`redundantSchemaTagIdentifier`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-schema-tag-identifier.md)
- [`resultMatchToFromResult`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/result-match-to-from-result.md) (native catalog addition)
- [`runOfExitToRunExit`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/run-of-exit-to-run-exit.md) (native catalog addition)
- [`schemaNumber`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-number.md) (native catalog addition)
- [`schemaStructWithTag`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-struct-with-tag.md)
- [`schemaUnionOfLiterals`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-union-of-literals.md)
- [`serviceNotAsClass`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/service-not-as-class.md)
- [`strictBooleanExpressions`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-boolean-expressions.md)
- [`suspendFailToFailSync`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/suspend-fail-to-fail-sync.md) (native catalog addition)
- [`syncToSucceed`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/sync-to-succeed.md) (native catalog addition)
- [`timeoutCatchTagToTimeoutOrElse`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/timeout-catch-tag-to-timeout-or-else.md) (native catalog addition)
- [`typeUnionToSchemaUnion`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/type-union-to-schema-union.md) (native catalog addition)
- [`unnecessaryArrowBlock`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-arrow-block.md)
- [`unnecessaryEffectGen`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-effect-gen.md)
- [`unnecessaryFailYieldableError`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-fail-yieldable-error.md)
- [`unnecessaryPipe`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-pipe.md)
- [`unnecessaryPipeChain`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-pipe-chain.md)
- [`unnecessaryTypeofType`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-typeof-type.md) (native catalog addition)
- [`yieldInCallArgument`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/yield-in-call-argument.md) (native catalog addition)

Maintainers:

- [`apiStabilityLeak`](https://github.com/Effect-TS/tsgo/blob/main/docs/rules/api-stability-leak.md) (native catalog addition)

Native catalog count: **147**. Do not import native-only diagnostic names into the JS config above.

## Full `@shekohex/oxc-effect` published preset inventory

Read from **0.2.1 npm tarball**, not inferred from the README. All names below have the `effect/` prefix in Oxlint. Preset severity is the author’s choice, not this report’s safety classification. [Preset source](https://github.com/shekohex/oxc-effect-linting-rules/tree/master/configs), [rule implementations](https://github.com/shekohex/oxc-effect-linting-rules/tree/master/rules), [author remediation guide](https://github.com/shekohex/oxc-effect-linting-rules/blob/master/docs/linting.md). Snapshot `d33f808bf3edd91193f5b36b0e847649fa9bc4b1`.

| Preset  | Rule                                          | Upstream severity | Adoption                              |
| ------- | --------------------------------------------- | ----------------- | ------------------------------------- |
| core    | `effect/no-arrow-ladder`                      | error             | optional opinion; leave off initially |
| core    | `effect/no-branch-in-object`                  | error             | optional opinion; leave off initially |
| core    | `effect/no-call-tower`                        | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-all-step-sequencing`        | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-as`                         | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-callback`                   | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-bind`                       | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-do`                         | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-fn-callback-alias`          | error             | warning subset                        |
| core    | `effect/no-effect-fn-untraced`                | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-gen-callback-alias`         | error             | warning subset                        |
| core    | `effect/no-effect-ladder`                     | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-never`                      | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-catch-ladder`               | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-side-effect-wrapper`        | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-succeed-variable`           | warn              | optional opinion; leave off initially |
| core    | `effect/no-effect-sync-console`               | error             | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-fn`                     | error             | warning subset                        |
| core    | `effect/no-flatmap-ladder`                    | warn              | optional opinion; leave off initially |
| core    | `effect/no-fragmented-const-assembly`         | error             | optional opinion; leave off initially |
| core    | `effect/no-iife-wrapper`                      | error             | optional opinion; leave off initially |
| core    | `effect/no-inline-runtime-provide`            | error             | scoped candidate; verify fixtures     |
| core    | `effect/no-match-effect-branch`               | error             | optional opinion; leave off initially |
| core    | `effect/no-match-tag-neutral-fallback`        | warn              | optional opinion; leave off initially |
| core    | `effect/no-match-void-branch`                 | error             | optional opinion; leave off initially |
| core    | `effect/no-native-current-time`               | error             | scoped candidate; verify fixtures     |
| core    | `effect/no-effect-sleep-in-test`              | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-run-in-test`                | error             | optional opinion; leave off initially |
| core    | `effect/no-throw-in-effect-generator`         | error             | scoped candidate; verify fixtures     |
| core    | `effect/no-schema-sync-in-effect-generator`   | error             | **avoid: stale replacement**          |
| core    | `effect/no-nested-effect-call`                | error             | optional opinion; leave off initially |
| core    | `effect/no-option-as`                         | error             | optional opinion; leave off initially |
| core    | `effect/no-option-effect-branch`              | warn              | optional opinion; leave off initially |
| core    | `effect/no-pipe-ladder`                       | error             | optional opinion; leave off initially |
| core    | `effect/no-pipeline-fragment-staging`         | error             | optional opinion; leave off initially |
| core    | `effect/prefer-effect-async`                  | warn              | **avoid: stale replacement**          |
| core    | `effect/prefer-assert-in-effect-test`         | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-cache`                  | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-child-process`          | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-config`                 | error             | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-date-time`              | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-file-system`            | error             | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-http-client`            | warn              | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-logging`                | error             | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-random`                 | error             | scoped candidate; verify fixtures     |
| core    | `effect/prefer-effect-scheduling`             | warn              | scoped candidate; verify fixtures     |
| core    | `effect/prefer-match-tags`                    | error             | optional opinion; leave off initially |
| core    | `effect/prefer-match-value-tags`              | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-test-layer`             | warn              | optional opinion; leave off initially |
| core    | `effect/prefer-effect-vitest`                 | error             | optional opinion; leave off initially |
| core    | `effect/prefer-schema-json`                   | warn              | scoped candidate; verify fixtures     |
| core    | `effect/require-return-yield-effect-terminal` | error             | scoped candidate; verify fixtures     |
| core    | `effect/no-return-in-arrow`                   | warn              | optional opinion; leave off initially |
| core    | `effect/no-return-in-callback`                | warn              | optional opinion; leave off initially |
| core    | `effect/no-return-null`                       | error             | optional opinion; leave off initially |
| core    | `effect/no-effect-runfork`                    | error             | optional opinion; leave off initially |
| core    | `effect/no-switch-statement`                  | error             | optional opinion; leave off initially |
| core    | `effect/no-try-catch`                         | error             | optional opinion; leave off initially |
| core    | `effect/no-wrapgraphql-catch`                 | error             | optional opinion; leave off initially |
| core    | `effect/prevent-dynamic-imports`              | error             | optional opinion; leave off initially |
| core    | `effect/warn-effect-sync-wrapper`             | warn              | optional opinion; leave off initially |
| ts-type | `effect/no-effect-type-alias`                 | error             | optional opinion; leave off initially |
| ts-type | `effect/no-option-nullish-rewrap`             | error             | optional opinion; leave off initially |
| ts-type | `effect/no-manual-data-guard`                 | error             | optional opinion; leave off initially |
| ts-type | `effect/no-model-overlay-cast`                | error             | scoped candidate; verify fixtures     |
| ts-type | `effect/no-option-boolean-normalization`      | error             | optional opinion; leave off initially |
| ts-type | `effect/no-unknown-boolean-coercion-helper`   | error             | optional opinion; leave off initially |
| web     | `effect/no-atom-registry-effect-sync`         | error             | optional opinion; leave off initially |
| web     | `effect/no-family-collection-read`            | error             | optional opinion; leave off initially |
| web     | `effect/no-inline-runtime-provide`            | error             | scoped candidate; verify fixtures     |
| web     | `effect/no-naked-object-state-update`         | error             | optional opinion; leave off initially |
| web     | `effect/no-react-state`                       | error             | optional opinion; leave off initially |
| web     | `effect/no-render-side-effects`               | error             | scoped candidate; verify fixtures     |

### Rules unsuitable as blanket safety policy

- `prefer-effect-async` recommends an API missing in 4.1.2: use `Effect.callback` for callback registration and return an interruption cleanup Effect where applicable. The installed source exports `callback`, not `async`. The peer range admitting v4 stable is not proof that remediation text tracks it.
- `no-schema-sync-in-effect-generator` needs v4 API verification before adoption; do not assume v3 `Schema.decodeUnknownSync` advice maps directly to v4 constructors/decoders.
- `no-effect-fn-untraced` bans valid untraced functions. Named tracing is a useful app convention, not a correctness law.
- `no-effect-as`, `no-effect-succeed-variable`, `no-effect-all-step-sequencing`, `no-nested-effect-call` and pipe/flatMap ladders express code-shape preferences. Valid combinator composition and local resource/error boundaries must remain expressible.
- `no-react-state` forces an Atom architecture; `no-return-null` rejects normal React/adapter protocols; `no-switch-statement` excludes ordinary exhaustive TypeScript; `no-try-catch` affects legitimate foreign API boundaries; dynamic imports can be required for platform splitting. Leave off.
- `no-effect-run-in-test` and `prefer-effect-vitest` make sense for effectful lifecycle tests, not pure calculation golden tests. `prefer-assert-in-effect-test` chooses an assertion style rather than proving execution.
- `no-inline-runtime-provide` and `no-effect-runfork` are too broad globally. Framework edges legitimately own runtime construction and fiber execution.
- `no-effect-type-alias` conflicts with compact domain-specific signatures; `no-manual-data-guard` may forbid legitimate refinement. Decode real boundaries, but do not mandate Schema for all pure values.

## Remaining implementation choices and limitations

The report recommends selected community conventions, not a universal community consensus. Exact JS diagnostic defaults and v4 flags are inventoried above; native additions are deliberately separated. The report verified published custom plugin loading and several decisive failure/pass fixtures, not every plugin rule or the native toolchain. Rule names in the runnable subset exist in published 0.2.1; official diagnostic names exist in 0.87.5/catalog. Finish integration by running the actual project graph, checking workspace imports and expected framework exceptions, and confirming that a deliberately broken fixture fails CI before removing that fixture.

Prefer documented narrow suppressions with reasons over changing valid behavior simply to appease a code-shape rule. Pin versions, commit the lockfile during implementation, and rerun these lint acceptance checks when updating Effect or its tooling.
