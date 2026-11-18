import { basename } from "node:path";
import { parseArgs } from "node:util";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as nodeServices } from "@effect/platform-node/NodeServices";
import { Cause, Clock, Console, Effect, Exit, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  artifactPaths,
  compareRuns,
  decodeRun,
  LabError,
  labDirectory,
  listRunIds,
  readCode,
  readRun,
  writeRun,
} from "./artifacts.ts";
import type { RunArtifact } from "./artifacts.ts";
import type { ExperimentEvent } from "./experiment.ts";

const scenario = {
  name: "mail-review-sync",
  description: "Ingest synthetic mail, approve it, and observe WebSocket and HTTP behavior.",
  variant: "--disconnect-at review",
};

const help = `Bean Budget lab

  npm run lab -- list
  npm run lab -- runs
  npm run lab -- run mail-review-sync [--disconnect-at review]
  npm run lab -- show <run-id>
  npm run lab -- diff <baseline-run-id> <variant-run-id>

Every run starts with synthetic mail and a fresh SQLite file in .local/lab/.
Use a full run ID or unique suffix with show and diff.
Use --json for structured output. Run npm run --silent lab -- ... --json for JSON alone.
`;

function timestamp(milliseconds: number) {
  return new Date(milliseconds).toISOString();
}

const runExperiment = Effect.fn("Lab.runExperiment")(function* (disconnectAt: "review" | null) {
  const { ExperimentError, mailReviewSyncPlan, runMailReviewSync } = yield* Effect.tryPromise({
    try: () => import("./experiment.ts"),
    catch: () => new LabError({ message: "Could not load the mail-review-sync experiment." }),
  });
  const fs = yield* FileSystem;
  const code = yield* readCode;
  const startedAt = timestamp(yield* Clock.currentTimeMillis);
  const prefix = startedAt.replace(/[.:]/g, "-") + "-";
  yield* fs.makeDirectory(labDirectory, { recursive: true, mode: 0o700 });
  const directory = yield* fs.makeTempDirectory({ directory: labDirectory, prefix });
  const plan = mailReviewSyncPlan({ disconnectAt });
  const replay = `npm run lab -- run ${scenario.name}${disconnectAt ? ` ${scenario.variant}` : ""}`;
  const started: RunArtifact = {
    ...plan,
    version: 1,
    id: basename(directory),
    status: "running",
    startedAt,
    finishedAt: null,
    replay,
    code,
    artifacts: artifactPaths(directory),
    timeline: [],
    before: null,
    after: null,
    observations: null,
    failure: null,
  };
  yield* writeRun(directory, started);
  const timeline: ExperimentEvent[] = [];
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.exit(
        restore(
          runMailReviewSync({
            directory,
            disconnectAt,
            onEvent: (event) => timeline.push(event),
          }),
        ),
      );
      const finishedAt = timestamp(yield* Clock.currentTimeMillis);
      const data = { ...started, status: "completed", finishedAt };
      if (Exit.isFailure(outcome)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(outcome.cause));
        let reason = "Unexpected workflow error";
        if (Cause.hasInterruptsOnly(outcome.cause)) reason = "Interrupted";
        else if (error instanceof ExperimentError) reason = error.message;
        else if (error instanceof Error) reason = error.name;
        data.status = "failed";
        data.timeline = timeline;
        data.failure = `${reason}\nLast recorded stage  ${timeline.at(-1)?.stage ?? "setup"}`;
      }
      const report = yield* decodeRun(
        JSON.stringify(Exit.isSuccess(outcome) ? { ...data, ...outcome.value } : data),
      );
      yield* writeRun(directory, report);
      return report;
    }),
  );
});

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function fieldLines(value: Schema.JsonObject | null) {
  if (value === null) return ["  Missing"];
  return Object.entries(value).map(([field, data]) => `  ${field}  ${JSON.stringify(data)}`);
}

const isJsonObject = Schema.is(Schema.JsonObject);

function describeWindow(value: Schema.Json | undefined) {
  if (!isJsonObject(value)) return "unknown";
  const count = typeof value.ledgerChanged === "number" ? value.ledgerChanged : "unknown";
  const status = typeof value.status === "string" ? value.status : "unknown";
  return `${count} (${status})`;
}

function outcome(run: Pick<RunArtifact, "observations" | "status">) {
  const observed = run.observations;
  if (!observed) return run.status;
  const review = isJsonObject(observed.review) ? observed.review.status : null;
  const parts = [
    run.status,
    typeof review === "number" ? `review HTTP ${review}` : "no review response",
    `frames during review ${describeWindow(observed.reviewWindow)}`,
  ];
  if (observed.reconnectWindow)
    parts.push(`frames after reconnect ${describeWindow(observed.reconnectWindow)}`);
  if (typeof observed.registerFetch === "string") parts.push(`fetch ${observed.registerFetch}`);
  if (typeof observed.postedDelta === "number")
    parts.push(`posted balance change ${observed.postedDelta} JPY`);
  return parts.join(" | ");
}

function showRun(run: RunArtifact, includeTimeline: boolean) {
  const lines = [
    `${run.scenario} / ${run.id} / ${run.status}`,
    `Report  ${run.artifacts.report}`,
    `SQLite  ${run.artifacts.database}`,
    `Code    ${run.code.commit}${run.code.sourceDirty ? " (source changes in working tree)" : ""}`,
    `Replay  ${run.replay}`,
    `Outcome  ${outcome(run)}`,
    "",
    "Parameters",
    ...fieldLines(run.parameters),
    "",
    "Observations",
    ...fieldLines(run.observations),
  ];
  if (run.failure) lines.push("", run.failure);
  if (!includeTimeline) lines.push("", `Timeline  npm run lab -- show ${run.id}`);
  if (includeTimeline && run.timeline.length > 0) {
    lines.push(
      "",
      "Timeline",
      ...run.timeline.map(
        ({ elapsedMs, stage, detail }) =>
          `  +${elapsedMs.toFixed(1)} ms  ${stage}  ${JSON.stringify(detail)}`,
      ),
    );
  }
  return lines.join("\n");
}

function shortValue(value: Schema.Json | undefined) {
  if (value === undefined) return "missing";
  const encoded = JSON.stringify(value);
  return encoded.length > 140 ? encoded.slice(0, 137) + "..." : encoded;
}

function showDiff(diff: ReturnType<typeof compareRuns>) {
  const lines = [
    `${diff.scenario} / ${diff.baseline.id} → ${diff.variant.id}`,
    `Baseline  ${outcome(diff.baseline)}`,
    ...(diff.baseline.failure ? [`  ${diff.baseline.failure}`] : []),
    `Variant   ${outcome(diff.variant)}`,
    ...(diff.variant.failure ? [`  ${diff.variant.failure}`] : []),
    "",
    "Shared parameters",
    ...fieldLines(diff.sharedParameters),
  ];
  for (const section of ["parameters", "inputs", "code", "timeline"] as const) {
    const differences = diff.changed[section];
    if (differences.length === 0) continue;
    lines.push("", `Changes in ${section}`);
    for (const { path, baseline, variant } of differences.slice(0, 20)) {
      lines.push(
        `  ${path.join(".") || section}  ${shortValue(baseline)} → ${shortValue(variant)}`,
      );
    }
    if (differences.length > 20)
      lines.push(`  ${differences.length - 20} more changes. Use --json for the full diff.`);
  }
  lines.push("", "Use --json for the full comparison, including before and after records.");
  return lines.join("\n");
}

const args = process.argv.slice(2);

const program = Effect.gen(function* () {
  const { values, positionals } = yield* Effect.try({
    try: () =>
      parseArgs({
        args,
        allowPositionals: true,
        options: {
          "disconnect-at": { type: "string", multiple: true },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
        },
      }),
    catch: (error) =>
      new LabError({
        message: error instanceof Error ? error.message : "Invalid lab arguments.",
      }),
  });
  const [action, first, second] = positionals;
  const variants = values["disconnect-at"] ?? [];
  if (values.help || args.length === 0 || (action === "help" && positionals.length === 1))
    return yield* Console.log(help);
  if (action !== "run" && variants.length > 0)
    return yield* new LabError({ message: "Use --disconnect-at only with run." });
  if (action === "list" && positionals.length === 1 && variants.length === 0)
    return yield* Console.log(
      values.json
        ? json([scenario])
        : `${scenario.name}\n  ${scenario.description}\n  Variant  ${scenario.variant}`,
    );
  if (action === "runs" && positionals.length === 1) {
    const ids = yield* listRunIds;
    return yield* Console.log(
      values.json ? json(ids) : ids.length ? ids.join("\n") : "No saved runs yet.",
    );
  }
  if (action === "run") {
    if (!first || positionals.length !== 2)
      return yield* new LabError({ message: "Usage: npm run lab -- run <scenario>." });
    if (first !== scenario.name)
      return yield* new LabError({
        message: `Unknown scenario ${first}. See npm run lab -- list.`,
      });
    if (variants.length > 1)
      return yield* new LabError({ message: "Use --disconnect-at at most once." });
    if (variants[0] !== undefined && variants[0] !== "review")
      return yield* new LabError({
        message: `Unknown disconnect stage ${variants[0]}. Use --disconnect-at review.`,
      });
    const report = yield* runExperiment(variants[0] === "review" ? "review" : null);
    yield* Console.log(values.json ? json(report) : showRun(report, false));
    if (report.status === "failed")
      return yield* new LabError({
        message: `The run failed. Report at ${report.artifacts.report}.`,
      });
    return;
  }
  if (action === "show") {
    if (!first || positionals.length !== 2)
      return yield* new LabError({ message: "Usage: npm run lab -- show <run-id>." });
    const report = yield* readRun(first);
    return yield* Console.log(values.json ? json(report) : showRun(report, true));
  }
  if (action === "diff") {
    if (!first || !second || positionals.length !== 3)
      return yield* new LabError({ message: "Usage: npm run lab -- diff <baseline> <variant>." });
    const [baseline, variant] = yield* Effect.all([readRun(first), readRun(second)]);
    if (baseline.scenario !== variant.scenario)
      return yield* new LabError({ message: "Choose two runs of the same scenario." });
    const compared = compareRuns(baseline, variant);
    return yield* Console.log(values.json ? json(compared) : showDiff(compared));
  }
  return yield* new LabError({
    message: `Unknown or incomplete command ${action ?? ""}. See npm run lab -- --help.`,
  });
});

runMain(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(nodeServices),
  ),
  { disableErrorReporting: true },
);
