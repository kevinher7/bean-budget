# Bean Budget

Read `docs/ARCHITECTURE.md` before adding application code. Keep implementations compact and share domain rules without introducing a service or abstraction for every entity.

Inline trivial forwarding wrappers rather than creating abstractions just to shorten calls; small duplication is acceptable.

## Effect and TypeScript

- Use Effect 4. Check the installed types before copying examples; many online examples target v3.
- Use explicit named imports instead of `import * as` namespace imports. Alias generic export names where needed for clarity.
- Keep budget arithmetic pure. Use Effect for application orchestration and external dependencies.
- Prefer Effect's HTTP, configuration, and resource APIs over handwritten async/Promise plumbing. Keep plain callbacks at actual native-library boundaries, such as synchronous SQLite transactions.
- Define generator callbacks inline. Use named `Effect.fn` for reusable effectful functions and `Effect.gen` for program values. `Effect.gen(...).pipe(...)` is valid.
- Use `yield*` to execute an Effect inside a generator. Return `yield* effect` when delegating the final result; returning an Effect directly usually creates unintended nested work.
- Use `Effect.tryPromise` or another appropriate async constructor for promise-based adapters. `Effect.sync` does not await promises or handle their rejections.
- Decode external data and preserve meaningful error and service channels. Do not silence failures with unsafe casts, detached promises, or successful defaults without an explicit recovery policy.
- Run effects at host/framework boundaries. Compose services and resource ownership deliberately; lint cannot prove cleanup, transaction atomicity, or financial correctness.
- Prefer narrow, explained exceptions over disabling rules globally. Some community rules are syntax-based and do not understand aliases or every valid framework integration.

## Checks

Keep `tools/` for lint and repository checks. Put operational commands with their owning app.

- Use `npm run format` for Oxfmt formatting. Separate top-level function, class, and schema declarations with a blank line; Oxfmt preserves these lines but does not insert them automatically.
- Run `npm run check` before declaring a code or configuration change complete. It runs Oxfmt, TypeScript, import boundary checks, typed Oxlint, and the official Effect diagnostic CLI; warnings fail the check.
- Do not add tests or test fixtures unless the user explicitly requests them. This project uses typechecking, import boundary checks, and linting.
- Plain `tsc` does not run Effect diagnostics. Keep `lint:effect` in the check pipeline; no TypeScript installation patch is required.

See `docs/LINTING.md` for commands, policy, and current limitations.
