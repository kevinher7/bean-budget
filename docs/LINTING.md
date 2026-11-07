# TypeScript and Effect checks

The project uses Oxfmt for formatting, TypeScript for types, Oxlint with tsgolint for TypeScript safety and selected community rules, and the official Effect language-service CLI for semantic Effect diagnostics.

```sh
npm ci
npm run format        # format the repository with Oxfmt
npm run format:check  # check formatting without changing files
npm run check         # formatting, typecheck, import boundaries, lint
npm run lint:fix      # apply available safe Oxlint fixes; review the diff
```

Both lint commands fail on warnings as well as errors. Safety rules are errors; cleanup preferences are warnings in the editor but still need resolving for `check` to pass. Default informational suggestions are not a validation gate. The Effect CLI runs separately because ordinary `tsc` and plain Oxlint do not load the Effect semantic diagnostics. TypeScript is not patched.

Oxfmt uses a 100-character print width, with generated files and build outputs excluded in `.oxfmtrc.json`. Put a blank line between top-level function, class, and schema declarations. Oxfmt preserves this spacing but does not add missing blank lines, so the convention is also recorded in `AGENTS.md`.

## Applied rules

`import/no-namespace` requires explicit imports instead of `import * as` namespace imports. Generic exports such as `layer` can be aliased to a descriptive local name. This is an import-style convention; it does not prohibit named module exports such as `import { Effect } from "effect"`.

`.oxlintrc.json` enables correctness checks, type-aware Promise handling, explicit and propagated `any` checks, unsafe narrowing assertions, non-null assertions, and exhaustive switches. `void promise` does not count as rejection handling.

The selected community plugin rules reject separately stored callbacks passed to `Effect.gen` and `Effect.fn`, and recommend `Effect.fn` for reusable operations. These are readability conventions. An inline generator followed by `.pipe(...)` remains valid, as does a stored Effect program value.

The Effect plugin configuration in `tsconfig.json` promotes discarded Effects, missing delegation, accidental nesting, unsafe Effect assertions, Promise-returning `sync`, layer dependency mistakes, repeated provisioning, nested runtime execution, obsolete APIs, and duplicate Effect packages to errors. It retains the official correctness defaults and enables cleanup and error-hygiene warnings. Ambient time, randomness, fetch, timers, environment access, and console logging inside generators receive warnings to encourage injected Effect services. Native APIs are still available at appropriate adapter and tooling boundaries.

The full community preset is deliberately not enabled. It includes unrelated architecture preferences, blanket bans on valid language features, and some stale API replacements. For example, `prefer-effect-async` recommends an API missing from Effect 4.1.2; callback registration uses `Effect.callback`.

## Verification and limits

The project does not include automated tests or test fixtures. `npm run check` runs static checks against the implementation.

The community rules are syntax-based: aliases and identically named unrelated objects can bypass checks or produce false positives. The diagnostic suite does not prove that every assigned Effect is eventually executed, that all promises are handled, or that resources are released. Transaction safety, idempotency, cancellation, and budget semantics require behavioral verification when implemented.

The current root TypeScript project includes TypeScript under `apps`, `packages`, and `scripts`. When individual workspace and framework projects are added, wire their actual tsconfigs into both typechecking and Effect diagnostics, including TSX sources. The root NodeNext configuration is not an Expo or browser configuration. Architecture import boundaries should be added and verified against the real workspace package names at that point.

Use the workspace TypeScript version in the editor to load the configured Effect plugin. Dependencies are pinned for the lint toolchain; run `npm run check` after upgrades. Oxlint's JavaScript plugin interface is still experimental.

## Research

- [Community inventory and implementation recommendations](EFFECT_COMMUNITY_RULES.md)
- [Initial lint tooling research](EFFECT_LINT_RESEARCH.md)

The research reports describe available options. The checked-in configuration and this document describe the applied policy.

## Initial workspaces

The budget, protocol, and server source exports share the root NodeNext TypeScript project; both TypeScript and Effect diagnostics check their actual source. `npm run check` also runs `check:boundaries` before lint. The boundary checker resolves static imports and exports with TypeScript: budget may depend only on itself and Effect, protocol additionally on budget. Dynamic imports and require are forbidden in shared packages. Runtime platform dependencies stay in the server workspace. No lint safety exceptions were added.

The server uses pinned `@effect/sql-sqlite-node` 4.1.2 with Effect 4.1.2 and Node’s built-in SQLite driver. Direct better-sqlite3 and its type dependency have been removed. SQL, migrations, SecureRandom IDs, and receipt codecs are checked by the same TypeScript and Effect diagnostics pipeline. Static checks do not exercise migration adoption or transaction behavior.
