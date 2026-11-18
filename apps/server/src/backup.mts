import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Id, Name } from "@bean-budget/budget";
import {
  Account,
  Command,
  CommandReceipt,
  CreateAccount,
  CreateTransaction,
  MailReviewAction,
  MailReviewResult,
  Transaction,
  validatePlanning,
  Month,
} from "@bean-budget/protocol";
import { databaseLayer } from "./database.ts";
import { registerSnapshot } from "./ledger.ts";
import { readBudgets, readPeriods } from "./budgets.ts";
import { readOccurrences, readSchedules } from "./schedules.ts";

class BackupError extends Data.TaggedError("BackupError")<{ message: string }> {}

const Manifest = Schema.Struct({
  kind: Schema.Literal("bean-budget-server"),
  version: Schema.Literal(1),
  schemaVersion: Schema.Literals([3, 4, 5, 6]),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  bytes: Schema.Int.check(Schema.isGreaterThan(0)),
});

const ReceiptPayload = Schema.Union([
  CreateTransaction,
  Command,
  Schema.Struct({ ...CreateAccount.fields, type: Schema.Literal("createAccount") }),
]);

const validateContent = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const register = yield* registerSnapshot;
  yield* Effect.try({
    try: () =>
      validatePlanning(
        register.planning,
        register.accounts,
        register.categories,
        register.payees,
        register.transactions,
      ),
    catch: () => new BackupError({ message: "Invalid planning relationships" }),
  });
  yield* readSchedules();
  yield* readOccurrences();
  yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ month: Month })))(
    yield* sql`SELECT month FROM budget_periods`,
  );
  for (const budget of yield* readBudgets()) yield* readPeriods(budget.id, "9999-12");
  const identities = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ identity: Schema.String, transactionId: Id })),
  )(yield* sql`SELECT identity,transactionId FROM import_identities`);
  for (const identity of identities)
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Struct({ namespace: Name, key: Name })),
    )(identity.identity);
  const mailCommands = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        connectionId: Id,
        messageId: Name,
        command: Schema.fromJsonString(CreateTransaction),
      }),
    ),
  )(yield* sql`SELECT connectionId,messageId,command FROM mail_messages WHERE command IS NOT NULL`);
  for (const row of mailCommands) {
    if (
      row.command.importIdentity?.namespace !== `gmail:${row.connectionId}` ||
      row.command.importIdentity.key !== row.messageId ||
      row.command.source !== "mail-bean"
    )
      return yield* Effect.fail(
        new BackupError({ message: "Invalid saved mail command identity" }),
      );
  }
  const acceptedWithoutIdentity = yield* sql`SELECT m.messageId FROM mail_messages m
    LEFT JOIN import_identities i ON i.identity=json_object('namespace','gmail:' || m.connectionId,'key',m.messageId)
      AND i.transactionId=m.transactionId
    WHERE m.state='accepted' AND i.identity IS NULL LIMIT 1`;
  if (acceptedWithoutIdentity.length)
    return yield* Effect.fail(
      new BackupError({ message: "Accepted mail is missing its import identity" }),
    );
  const reviewReceipts = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        operationId: Id,
        payload: Schema.fromJsonString(MailReviewAction),
        result: Schema.fromJsonString(MailReviewResult),
        state: Schema.NullOr(Schema.String),
        transactionId: Schema.NullOr(Id),
      }),
    ),
  )(
    yield* sql`
    SELECT r.*,m.state,m.transactionId
    FROM mail_review_receipts r
    LEFT JOIN mail_messages m
      ON m.connectionId=json_extract(r.payload,'$.message.connectionId')
      AND m.messageId=json_extract(r.payload,'$.message.messageId')
  `,
  );
  for (const receipt of reviewReceipts) {
    const ignored = receipt.payload.action === "ignore";
    if (
      receipt.payload.operationId !== receipt.operationId ||
      receipt.state !== (ignored ? "ignored" : "accepted") ||
      receipt.result.transactionId !== receipt.transactionId ||
      ignored !== (receipt.transactionId === null)
    )
      return yield* Effect.fail(
        new BackupError({ message: "Mail review receipt differs from its message" }),
      );
  }
  const receipts = yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({ operationId: Schema.String, payload: Schema.String, result: Schema.String }),
    ),
  )(yield* sql`SELECT operationId,payload,result FROM receipts`);
  for (const receipt of receipts) {
    const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReceiptPayload))(
      receipt.payload,
    );
    if (payload.operationId !== receipt.operationId)
      return yield* Effect.fail(
        new BackupError({ message: "Receipt operation identity differs from its payload" }),
      );
    if (!("type" in payload)) {
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Transaction))(
        receipt.result,
      );
      const stored = register.transactions.find((transaction) => transaction.id === result.id);
      if (
        result.accountId !== payload.accountId ||
        result.amount !== payload.amount ||
        result.date !== payload.date ||
        result.kind !== "transaction" ||
        (result.transferId ?? null) !== null ||
        (result.status ?? "posted") !== (payload.status ?? "posted") ||
        (result.source ?? "manual") !== (payload.source ?? "manual") ||
        (result.categoryId ?? null) !== (payload.categoryId ?? null) ||
        (result.payeeId ?? null) !== (payload.payeeId ?? null) ||
        (result.notes ?? null) !== (payload.notes ?? null) ||
        !stored ||
        result.accountId !== stored.accountId ||
        result.amount !== stored.amount ||
        result.date !== stored.date ||
        result.kind !== stored.kind ||
        (result.transferId ?? null) !== (stored.transferId ?? null) ||
        (result.source ?? "manual") !== (stored.source ?? "manual")
      )
        return yield* Effect.fail(
          new BackupError({ message: "Transaction receipt does not match its ledger record" }),
        );
    } else if (payload.type === "createAccount") {
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Account))(
        receipt.result,
      );
      const stored = register.accounts.find((account) => account.id === result.id);
      const opening = register.transactions.find(
        (transaction) => transaction.accountId === result.id && transaction.kind === "opening",
      );
      if (
        (payload.id !== undefined && result.id !== payload.id) ||
        !stored ||
        result.name !== stored.name ||
        result.currency !== stored.currency ||
        result.name !== payload.name ||
        result.currency !== (payload.currency ?? "JPY") ||
        result.balance !== payload.openingBalance ||
        (result.projectedBalance ?? result.balance) !== payload.openingBalance ||
        !opening ||
        opening.amount !== payload.openingBalance ||
        opening.date !== payload.date
      )
        return yield* Effect.fail(
          new BackupError({ message: "Account receipt does not match its ledger record" }),
        );
    } else if (payload.type === "editTransaction" && receipt.result !== "{}") {
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Transaction))(
        receipt.result,
      );
      const stored = register.transactions.find((transaction) => transaction.id === result.id);
      if (
        result.id !== payload.id ||
        result.revision !== payload.revision + 1 ||
        result.status !== payload.status ||
        (result.categoryId ?? null) !== payload.categoryId ||
        (result.payeeId ?? null) !== payload.payeeId ||
        (result.notes ?? null) !== payload.notes ||
        !stored ||
        result.accountId !== stored.accountId ||
        result.amount !== stored.amount ||
        result.date !== stored.date ||
        result.kind !== stored.kind ||
        (result.transferId ?? null) !== (stored.transferId ?? null) ||
        (result.source ?? "manual") !== (stored.source ?? "manual")
      )
        return yield* Effect.fail(
          new BackupError({ message: "Edit receipt does not match its ledger record" }),
        );
    } else if (receipt.result !== "{}") {
      const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CommandReceipt))(
        receipt.result,
      );
      if (
        payload.type === "generate" &&
        (!result.occurrenceId ||
          !register.planning.occurrences.some(
            (row) =>
              row.id === result.occurrenceId &&
              row.scheduleId === payload.scheduleId &&
              row.month === payload.month,
          ))
      )
        return yield* Effect.fail(
          new BackupError({ message: "Generation receipt differs from occurrence" }),
        );
      if (
        payload.type === "pendingOccurrence" &&
        (!result.transactionId ||
          result.occurrenceId !== payload.occurrenceId ||
          !register.planning.occurrences.some(
            (row) => row.id === payload.occurrenceId && row.transactionId === result.transactionId,
          ))
      )
        return yield* Effect.fail(
          new BackupError({ message: "Payment receipt differs from occurrence" }),
        );
    }
  }
});

function schema(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
    )
    .all();
}

async function validateDatabase(path: string, scratch: string, version?: number) {
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    const actualVersion = source
      .prepare("SELECT max(migration_id) AS version FROM effect_sql_migrations")
      .get()?.version;
    if (
      (actualVersion !== 3 && actualVersion !== 4 && actualVersion !== 5 && actualVersion !== 6) ||
      (version !== undefined && actualVersion !== version)
    )
      throw new BackupError({ message: "Unsupported database version" });
    version = actualVersion;
  } finally {
    source.close();
  }
  const expectedPath = join(scratch, "expected.sqlite");
  await Effect.runPromise(Effect.void.pipe(Effect.provide(databaseLayer(expectedPath, version))));
  const expected = new DatabaseSync(expectedPath, { readOnly: true });
  let actual: DatabaseSync | undefined;
  try {
    actual = new DatabaseSync(path, { readOnly: true });
    if (JSON.stringify(schema(actual)) !== JSON.stringify(schema(expected)))
      throw new BackupError({ message: "Database schema differs from the current server schema" });
    const journal = actual
      .prepare("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    const expectedJournal = expected
      .prepare("SELECT migration_id,name FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    if (JSON.stringify(journal) !== JSON.stringify(expectedJournal))
      throw new BackupError({ message: "Unsupported database version" });
    const integrity = actual.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new BackupError({ message: "SQLite integrity check failed" });
    if (actual.prepare("PRAGMA foreign_key_check").all().length)
      throw new BackupError({ message: "SQLite foreign-key check failed" });
  } finally {
    actual?.close();
    expected.close();
  }
  await Effect.runPromise(validateContent.pipe(Effect.provide(databaseLayer(path))));
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec("PRAGMA journal_mode = DELETE");
  } finally {
    database.close();
  }
}

async function assertAbsent(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new BackupError({ message: "Destination already exists; choose a new path" });
}

async function verifiedCopy(directory: string, scratch: string) {
  const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
    await readFile(join(directory, "manifest.json"), "utf8"),
    { onExcessProperty: "error" },
  );
  const bytes = await readFile(join(directory, "server.sqlite"));
  if (
    bytes.length !== manifest.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.sha256
  )
    throw new BackupError({ message: "Backup size or SHA-256 does not match its manifest" });
  const path = join(scratch, "verified.sqlite");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await validateDatabase(path, scratch, manifest.schemaVersion);
  return path;
}

async function main() {
  const [action, input, destination, ...extra] = process.argv.slice(2);
  if (
    !input ||
    extra.length ||
    !["export", "verify", "restore"].includes(action ?? "") ||
    (action === "verify" ? destination !== undefined : !destination)
  )
    throw new BackupError({
      message:
        "Usage: npm run server:backup -- export DATABASE BACKUP_DIRECTORY | verify BACKUP_DIRECTORY | restore BACKUP_DIRECTORY NEW_DATABASE",
    });
  const scratch = await mkdtemp(join(tmpdir(), "bean-server-backup-"));
  try {
    if (action === "export" && destination) {
      const path = join(scratch, "snapshot.sqlite");
      const source = new DatabaseSync(resolve(input), { readOnly: true });
      try {
        await backup(source, path);
      } finally {
        source.close();
      }
      await validateDatabase(path, scratch);
      const bytes = await readFile(path);
      const manifest = {
        kind: "bean-budget-server",
        version: 1,
        schemaVersion: 6,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
      await mkdir(destination, { mode: 0o700 });
      await copyFile(path, join(destination, "server.sqlite"), constants.COPYFILE_EXCL);
      await chmod(join(destination, "server.sqlite"), 0o600);
      await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      console.log("Server backup exported and verified. Keep both files together.");
    } else {
      const path = await verifiedCopy(resolve(input), scratch);
      if (action === "restore" && destination) {
        const target = resolve(destination);
        for (const suffix of ["", "-wal", "-shm", "-journal"]) await assertAbsent(target + suffix);
        const staging = await mkdtemp(join(dirname(target), ".bean-restore-"));
        try {
          const staged = join(staging, "server.sqlite");
          await copyFile(path, staged, constants.COPYFILE_EXCL);
          await link(staged, target);
        } finally {
          await rm(staging, { recursive: true, force: true });
        }
        console.log("Server backup restored and verified at the new database path.");
      } else
        console.log(
          "Server backup version, digest, schema, integrity, references and records verified.",
        );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await Effect.runPromise(
  Effect.tryPromise({
    try: main,
    catch: (error) =>
      error instanceof BackupError
        ? error
        : new BackupError({
            message:
              "Server backup failed. Check file permissions and backup content. Existing databases are never replaced.",
          }),
  }).pipe(
    Effect.match({
      onFailure: (error) => {
        console.error(error.message);
        process.exitCode = 1;
      },
      onSuccess: () => {},
    }),
  ),
);
