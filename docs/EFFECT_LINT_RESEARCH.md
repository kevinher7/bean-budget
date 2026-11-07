# Effect and TypeScript lint research

Research date: 5 November 2026. This is a recommendation, not an implemented configuration. Bean Budget's architecture keeps budgeting calculations pure, uses Effect for orchestration, and assembles services at application boundaries. Rules should protect those choices without requiring every function to return an Effect.

## Local evidence and recommendation

Bean Budget's newly installed `effect` is **4.1.2** at inspection; `../spend-bean` has 4.0.5. Spend Bean uses TypeScript 6.0.3, Oxlint 1.88, `oxlint-tsgolint`, a separate `tsc` check, strict compiler options, and scoped import/property restrictions. Its `consistent-type-assertions: never` bans all assertions, a stronger policy than necessary here. Its literal `Effect.run*` restrictions are useful guardrails but do not prove runtime boundaries.

Start with strict TypeScript, Oxlint's correctness checks and a small set of typed rules, plus the official Effect language service for editor feedback and an independently verified CI diagnostic command. Keep normal `tsc` as the authoritative compiler check. Add import boundaries when real package paths exist. Avoid adopting a second linter or an opinionated Effect ruleset until a demonstrated gap warrants it.

## What each tool actually checks

- **TypeScript:** `strict` includes `noImplicitAny` and `useUnknownInCatchVariables`; it checks assignability, not whether untrusted data was validated or an Effect was executed. Add `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns` and `noFallthroughCasesInSwitch` where framework types permit; `exactOptionalPropertyTypes` can expose third-party incompatibilities. See [TSConfig reference](https://www.typescriptlang.org/tsconfig/).
- **Oxlint:** native rules run without types; `oxlint --type-aware` needs `oxlint-tsgolint` and a resolvable TypeScript project. Current [Oxlint documentation](https://oxc.rs/docs/guide/usage/linter/type-aware) says its type engine uses TypeScript 7 semantics, with removed legacy options such as `baseUrl` unsupported; this does not mean the project's installed `tsc` is upgraded. Project references and declarations must resolve. Verify the pinned versions against actual Expo configs. `--type-check` is optional and is not the same as running the Effect language service.
- **Effect language service:** the [official diagnostics table](https://github.com/Effect-TS/language-service) explicitly marks the named diagnostics below as supporting v4. A TypeScript `compilerOptions.plugins` entry is an editor language-service plugin; ordinary `tsc` does not load it. The official `effect-language-service diagnostics --project <tsconfig>` runs diagnostics without patching TypeScript. Test its exit status and severity handling with deliberate positive and negative fixtures before making it a CI gate. The alternative `effect-language-service patch` modifies installed TypeScript files and must be reapplied after installs/upgrades; avoid that maintenance burden initially. For TypeScript 7+, the service directs users to [@effect/tsgo](https://github.com/Effect-TS/tsgo), which also documents an Oxlint wrapper; do not assume plain `oxlint --type-aware` loads Effect diagnostics. Pin and test the chosen integration.
- **ESLint plugins:** the official [`@effect/eslint-plugin` source](https://github.com/Effect-TS/eslint-plugin/blob/main/src/plugin.ts) exports `dprint` and `no-import-from-barrel-package`, not an Effect safety ruleset; its [package](https://github.com/Effect-TS/eslint-plugin/blob/main/package.json) is 0.3.2 in the inspected source. Its v4 safety coverage is not established. The independent [oxc-effect-linting-rules](https://github.com/shekohex/oxc-effect-linting-rules) claims v4 support, but is opinionated and needs individual rule and maintenance evaluation. [Oxlint JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins) are alpha; custom type-aware ESLint rules are not generally supported. Do not assume an arbitrary ESLint plugin works in Oxlint. ESLint with typescript-eslint is a viable fallback if a specifically needed typed plugin is unsupported; avoid duplicate overlapping checks.

## Minimal enforceable baseline

1. Run `tsc --noEmit` per actual app/package project and Oxlint's correctness category. Enable typed `typescript/no-floating-promises` and `typescript/no-misused-promises` once project resolution is proven. The latter catches promises in conditions and many void-return callbacks, but not every async Effect callback: `Effect.map` can legitimately infer `Promise` as its success value. React event callbacks may need explicit error-handling wrappers. `no-floating-promises` allows `void` by default; `void` alone does **not** handle rejection. Consider `ignoreVoid: false`, with explicit handling for intentional background work. See [floating promises](https://typescript-eslint.io/rules/no-floating-promises/) and [misused promises](https://typescript-eslint.io/rules/no-misused-promises/).
2. Enable `typescript/no-explicit-any` and typed `typescript/no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, and `no-unsafe-return` (all in the `typescript/` Oxlint namespace). They reduce propagation of `any`, not all unsoundness. Treat external JSON, database rows and caught failures as `unknown`, then decode with Schema or narrow deliberately. Some library interop may need a localized, explained exception. See [typescript-eslint rules](https://typescript-eslint.io/rules/) and verify each rule in the installed Oxlint version.
3. Configure the official language service's v4 `floatingEffect` and `missingStarInYieldEffectGen` as errors, and evaluate `lazyPromiseInEffectSync`, `effectInVoidSuccess`, `returnEffectInGen`, `runEffectInsideEffect`, and `unsafeEffectTypeAssertion`. The latter two default to suggestion/off in the documented service; raise severity only after testing. `floatingEffect` catches discarded Effect expressions, not every value assigned and later forgotten. `lazyPromiseInEffectSync` covers `sync`, not all callbacks. `unsafeEffectTypeAssertion` targets narrowed Effect/Stream/Layer channels, not all unsafe assertions. Diagnostics have different defaults and may evolve; pin the service and consult its installed schema/table.
4. Restrict imports in `packages/budget` from React, platform APIs, database drivers, apps and protocol; restrict `packages/protocol` from apps. Use scoped `no-restricted-imports` patterns for actual package names and aliases once established. Include `node:*`, relevant bare built-ins, subpaths and relative/alias bypasses as appropriate. These syntactic checks are not a complete dependency graph; test representative allowed and forbidden imports.

A documented candidate plugin entry for a TypeScript 6 project, merged into its existing `compilerOptions`, is:

```json
{
  "plugins": [
    {
      "name": "@effect/language-service",
      "diagnosticSeverity": {
        "floatingEffect": "error",
        "missingStarInYieldEffectGen": "error",
        "unsafeEffectTypeAssertion": "warning"
      }
    }
  ]
}
```

This syntax comes from the [official language-service configuration](https://github.com/Effect-TS/language-service); it is not a complete tsconfig or a CI setup. Ensure editors use the workspace TypeScript version. Confirm diagnostics work on Effect 4.1.2 and every actual project before relying on them.

## Boundaries, gaps and optional additions

- Run effects at real framework edges: server entry/request handlers, mobile app/widget entry points, web integration, and tests. Not every edge will be a file named `runtime.ts`. `no-restricted-properties` scoped to shared packages can flag literal `Effect.runPromise`, `runSync`, `runFork` and related `*With`/`*Exit` APIs, as Spend Bean does; named imports, aliases, destructuring, other runner objects and wrappers bypass it, and identically named objects can false-positive. Also review `ManagedRuntime` usage. Do not ban `Effect.provide` everywhere: local provisioning and tests can be valid. The service's `runEffectInsideEffect` and optional `strictEffectProvide` are useful signals, not a complete architecture proof. Add a tested symbol-aware custom rule only if recurring violations justify its upkeep.
- A callback passed to `Effect.sync` or `Effect.map` should not accidentally return a Promise or throw an expected operational failure. Use `Effect.tryPromise` for promise rejection mapping, `Effect.try` for expected synchronous throws, and use `Effect.promise` only when rejection is appropriately treated as a defect. Preserve cancellation where the adapter supports its `AbortSignal`. Sibling v4 types confirm `sync` and `map` are generic enough to accept a Promise as a value, while `tryPromise` is the boundary constructor. A narrowly scoped, type-aware custom rule could detect async/Promise-returning callbacks for specific synchronous APIs; account for aliases and legitimate Promise-valued data. A blanket async, Promise, throw or class ban would break adapters, framework interfaces and valid Effect types.
- `typescript/no-unsafe-type-assertion` is an optional typed rule against narrowing casts; `consistent-type-assertions` with `assertionStyle: never` is broader and can obstruct valid interop. Neither proves runtime validity; use decoding and justified local exceptions. Review `anyUnknownInErrorContext` as a warning: `unknown` can be correct at an external boundary before conversion into a meaningful typed failure. Avoid blanket `no-throw` and requirements to wrap pure arithmetic or create a service for every entity.
- Consider `no-non-null-assertion` and `switch-exhaustiveness-check` after representative code exists. Strict checks and lint do not prove atomicity, financial correctness, idempotency, cancellation, or conflict recovery; those need design review and behavioral tests.

## Adoption plan

1. Pin compatible TypeScript, Effect, Oxlint, tsgolint and language-service versions; create real per-package tsconfigs and verify editor project selection. Keep the existing compiler and framework requirements in view.
2. Add checks incrementally with small representative fixtures: discarded Effect, missing `yield*`, Promise-returning `Effect.sync`/`map`, unsafe JSON, rejected promise, prohibited import and a permitted runtime edge. Confirm both diagnostics and process exit codes in CI, including a passing fixture. Note the known misses rather than claiming coverage.
3. Enable high-signal errors, document intentional exceptions and their reason, and run typecheck, lint, Effect diagnostics and tests independently. Add scope-specific restrictions as directories materialize; revisit plugin and version compatibility on upgrades.
