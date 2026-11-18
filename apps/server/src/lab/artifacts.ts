import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { make as childCommand } from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

export class LabError extends Data.TaggedError("LabError")<{ message: string }> {}

const root = fileURLToPath(new URL("../../../../", import.meta.url));
export const labDirectory = join(root, ".local", "lab");
export const databaseName = "ledger.sqlite";
const sourcePaths = [
  "apps/server/src",
  "apps/server/migrations",
  "packages",
  "package.json",
  "package-lock.json",
];

const RunArtifact = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  scenario: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  replay: Schema.String,
  code: Schema.Struct({
    commit: Schema.String,
    sourceDirty: Schema.Boolean,
    labSourceSha256: Schema.String,
    trackedSourceDiffSha256: Schema.String,
    node: Schema.String,
  }),
  artifacts: Schema.Struct({ report: Schema.String, database: Schema.String }),
  parameters: Schema.JsonObject,
  inputs: Schema.JsonObject,
  timeline: Schema.Array(
    Schema.Struct({
      sequence: Schema.Int,
      elapsedMs: Schema.Number,
      stage: Schema.String,
      detail: Schema.JsonObject,
    }),
  ),
  before: Schema.NullOr(Schema.JsonObject),
  after: Schema.NullOr(Schema.JsonObject),
  observations: Schema.NullOr(Schema.JsonObject),
  failure: Schema.NullOr(Schema.String),
});

export type RunArtifact = typeof RunArtifact.Type;

export const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(RunArtifact));

const git = Effect.fn("Lab.git")(function* (args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner;
  const child = yield* spawner.spawn(childCommand("git", args, { cwd: root, stderr: "ignore" }));
  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(child.stdout)), child.exitCode],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new LabError({ message: `Git ${args[0]} failed with exit status ${code}.` });
  return output;
}, Effect.scoped);

export const readCode = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const commit = (yield* git(["rev-parse", "--verify", "HEAD"])).trim();
  const status = yield* git([
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--",
    ...sourcePaths,
  ]);
  const trackedDiff = yield* git([
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    commit,
    "--",
    ...sourcePaths,
  ]);
  const hash = createHash("sha256");
  for (const file of ["artifacts.ts", "cli.ts", "experiment.ts", "inputs.ts"]) {
    const path = fileURLToPath(new URL(file, import.meta.url));
    hash
      .update(file)
      .update("\0")
      .update(yield* fs.readFile(path))
      .update("\0");
  }
  return {
    commit,
    sourceDirty: status.length > 0,
    labSourceSha256: hash.digest("hex"),
    trackedSourceDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
    node: process.version,
  };
});

export function artifactPaths(directory: string) {
  return {
    report: relative(root, join(directory, "run.json")),
    database: relative(root, join(directory, databaseName)),
  };
}

export const writeRun = Effect.fn("Lab.writeRun")(function* (directory: string, run: RunArtifact) {
  const fs = yield* FileSystem;
  const staging = join(directory, ".run.json.tmp");
  yield* fs.writeFileString(staging, JSON.stringify(run, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  yield* fs.rename(staging, join(directory, "run.json"));
});

export const listRunIds = Effect.gen(function* () {
  const fs = yield* FileSystem;
  const entries = yield* fs.readDirectory(labDirectory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  return entries
    .filter((entry) => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-z\d]+$/i.test(entry))
    .sort()
    .reverse();
});

export const readRun = Effect.fn("Lab.readRun")(function* (reference: string) {
  if (!/^[a-z\d][a-z\d_-]{0,99}$/i.test(reference))
    return yield* new LabError({ message: "Enter a run ID or suffix from npm run lab -- runs." });
  const ids = yield* listRunIds;
  const matches = ids.includes(reference)
    ? [reference]
    : ids.filter((id) => id.endsWith(reference));
  const [id] = matches;
  if (id === undefined)
    return yield* new LabError({
      message: `No saved run matches ${reference}. See npm run lab -- runs.`,
    });
  if (matches.length > 1)
    return yield* new LabError({
      message: `Several runs match ${reference}. Use a longer suffix.`,
    });
  const fs = yield* FileSystem;
  const path = join(labDirectory, id, "run.json");
  const encoded = yield* fs.readFileString(path).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.fail(new LabError({ message: `No saved lab run named ${id}.` })),
    ),
  );
  const run = yield* decodeRun(encoded).pipe(
    Effect.mapError(
      () => new LabError({ message: `Invalid lab report at ${relative(root, path)}.` }),
    ),
  );
  if (run.id !== id)
    return yield* new LabError({
      message: `Run ID in ${relative(root, path)} differs from ${id}.`,
    });
  return run;
});

type Change = {
  path: readonly (string | number)[];
  baseline?: Schema.Json;
  variant?: Schema.Json;
};

function isArray(value: Schema.Json | undefined): value is Schema.JsonArray {
  return Array.isArray(value);
}

function isObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !isArray(value);
}

function changes(
  baseline: Schema.Json | undefined,
  variant: Schema.Json | undefined,
  path: readonly (string | number)[] = [],
): Change[] {
  if (baseline === variant) return [];
  if (isObject(baseline) && isObject(variant)) {
    return [...new Set([...Object.keys(baseline), ...Object.keys(variant)])]
      .sort()
      .flatMap((key) =>
        changes(
          Object.hasOwn(baseline, key) ? baseline[key] : undefined,
          Object.hasOwn(variant, key) ? variant[key] : undefined,
          [...path, key],
        ),
      );
  }
  if (isArray(baseline) && isArray(variant)) {
    return Array.from({ length: Math.max(baseline.length, variant.length) }, (_, index) =>
      changes(baseline[index], variant[index], [...path, index]),
    ).flat();
  }
  return [
    {
      path,
      ...(baseline === undefined ? {} : { baseline }),
      ...(variant === undefined ? {} : { variant }),
    },
  ];
}

function eventCounts(timeline: RunArtifact["timeline"]) {
  const counts = new Map<string, number>();
  for (const { stage } of timeline) counts.set(stage, (counts.get(stage) ?? 0) + 1);
  return Object.fromEntries(counts);
}

export function compareRuns(baseline: RunArtifact, variant: RunArtifact) {
  const parameterChanges = changes(baseline.parameters, variant.parameters);
  const describeRun = (run: RunArtifact) => ({
    id: run.id,
    status: run.status,
    code: run.code,
    artifacts: run.artifacts,
    observations: run.observations,
    failure: run.failure,
  });
  return {
    scenario: baseline.scenario,
    baseline: describeRun(baseline),
    variant: describeRun(variant),
    sharedParameters: Object.fromEntries(
      Object.entries(baseline.parameters).filter(
        ([key]) => !parameterChanges.some(({ path }) => path[0] === key),
      ),
    ),
    changed: {
      parameters: parameterChanges,
      inputs: changes(baseline.inputs, variant.inputs),
      observations: changes(baseline.observations, variant.observations),
      code: changes(baseline.code, variant.code),
      before: changes(baseline.before, variant.before),
      after: changes(baseline.after, variant.after),
      timeline: changes(eventCounts(baseline.timeline), eventCounts(variant.timeline)),
    },
  };
}
