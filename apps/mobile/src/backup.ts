import { Data, Effect, Schema } from "effect";
import { Directory, File } from "expo-file-system";
import { balance, Id } from "@bean-budget/budget";
import {
  Account,
  Command,
  CreateAccount,
  CreateTransaction,
  NamedRecord,
  Transaction,
  Planning,
  validatePlanning,
} from "@bean-budget/protocol";

import { emptyPlanning, planningCommands, projectPlanning } from "./planning.ts";

export const Operation = Schema.Struct({
  operationId: Id,
  kind: Schema.Literals(["account", "category", "payee", "create", "edit", "planning"]),
  localId: Id,
  payload: Schema.String,
  error: Schema.NullOr(Schema.String),
});

export const MobileBackup = Schema.Struct({
  format: Schema.Literal("bean-budget-mobile"),
  version: Schema.Literal(2),
  planning: Planning,
  deferredTransactions: Schema.Array(Transaction),
  createdAt: Schema.String,
  serverUrl: Schema.NullOr(Schema.String),
  accounts: Schema.Array(Account),
  categories: Schema.Array(NamedRecord),
  payees: Schema.Array(NamedRecord),
  transactions: Schema.Array(Transaction),
  accepted: Schema.Array(Transaction),
  outbox: Schema.Array(Operation),
});

export type MobileBackup = typeof MobileBackup.Type;

export const MAX_BACKUP_BYTES = 20_000_000;

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol === "http:" && !["10.0.2.2", "127.0.0.1", "localhost"].includes(url.hostname))
  )
    throw new Error("Invalid backup server URL");
  return url.origin;
}

function uniqueIds(rows: readonly { readonly id: string }[], label: string) {
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error(`Duplicate ${label}`);
  return ids;
}

export function decodeBackup(text: string): MobileBackup {
  if (text.length > MAX_BACKUP_BYTES) throw new Error("Backup exceeds 20 MB");
  let bytes = 0;
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_BACKUP_BYTES) throw new Error("Backup exceeds 20 MB");
  }
  const raw: unknown = JSON.parse(text);
  const normalized =
    typeof raw === "object" && raw !== null && "version" in raw && raw.version === 1
      ? { ...raw, version: 2, planning: emptyPlanning, deferredTransactions: [] }
      : raw;
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    raw.version === 1 &&
    ("planning" in raw || "deferredTransactions" in raw)
  )
    throw new Error("Unexpected planning fields in legacy backup");
  const backup = Schema.decodeUnknownSync(MobileBackup, {
    onExcessProperty: "error",
  })(normalized);
  if (new Date(backup.createdAt).toISOString() !== backup.createdAt)
    throw new Error("Invalid backup creation date");
  if (backup.serverUrl !== null && normalizeServerUrl(backup.serverUrl) !== backup.serverUrl)
    throw new Error("Invalid backup server URL");
  const accounts = uniqueIds(backup.accounts, "account");
  const categories = uniqueIds(backup.categories, "category");
  const payees = uniqueIds(backup.payees, "payee");
  uniqueIds(backup.transactions, "transaction");
  uniqueIds(backup.accepted, "accepted transaction");
  if (new Set(backup.outbox.map((row) => row.operationId)).size !== backup.outbox.length)
    throw new Error("Duplicate operation");
  for (const row of [...backup.transactions, ...backup.accepted, ...backup.deferredTransactions]) {
    if (
      !accounts.has(row.accountId) ||
      (row.categoryId && !categories.has(row.categoryId)) ||
      (row.payeeId && !payees.has(row.payeeId)) ||
      (row.revision !== undefined && row.revision < 0)
    )
      throw new Error("Invalid transaction reference or revision");
  }
  for (const row of backup.accepted) {
    const local = backup.transactions.find((value) => value.id === row.id);
    if (
      !local ||
      local.accountId !== row.accountId ||
      local.amount !== row.amount ||
      local.date !== row.date ||
      local.kind !== row.kind ||
      (local.transferId ?? null) !== (row.transferId ?? null) ||
      (local.source ?? "manual") !== (row.source ?? "manual")
    )
      throw new Error("Accepted transaction does not match its local record");
  }
  for (const account of backup.accounts) {
    const rows = backup.transactions.filter((row) => row.accountId === account.id);
    if (rows.filter((row) => row.kind === "opening").length > 1)
      throw new Error("Duplicate opening balance");
    balance(rows.map((row) => row.amount));
    balance(rows.filter((row) => row.status !== "pending").map((row) => row.amount));
  }
  validatePlanning(backup.planning, backup.accounts, backup.categories, backup.payees, [
    ...backup.transactions,
    ...backup.deferredTransactions,
  ]);
  uniqueIds(backup.deferredTransactions, "deferred transaction");
  const plannedPayments = new Set(
    planningCommands(backup.outbox).flatMap((command) =>
      command.type === "pendingOccurrence" && command.transactionId ? [command.transactionId] : [],
    ),
  );
  const created = new Set<string>();
  const pendingAccounts = new Set(
    backup.outbox.filter((row) => row.kind === "account").map((row) => row.localId),
  );
  const pendingCategories = new Set(
    backup.outbox.filter((row) => row.kind === "category").map((row) => row.localId),
  );
  const pendingPayees = new Set(
    backup.outbox.filter((row) => row.kind === "payee").map((row) => row.localId),
  );
  const available = (id: string, pending: Set<string>) => !pending.has(id) || created.has(id);
  const checkClassifications = (row: {
    readonly categoryId?: string | null | undefined;
    readonly payeeId?: string | null | undefined;
  }) => {
    if (
      (row.categoryId &&
        (!categories.has(row.categoryId) || !available(row.categoryId, pendingCategories))) ||
      (row.payeeId && (!payees.has(row.payeeId) || !available(row.payeeId, pendingPayees)))
    )
      throw new Error("Invalid operation classification or order");
  };
  for (const operation of backup.outbox) {
    if (operation.kind === "account") {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(CreateAccount), {
        onExcessProperty: "error",
      })(operation.payload);
      if (
        command.operationId !== operation.operationId ||
        command.id !== operation.localId ||
        !accounts.has(operation.localId) ||
        created.has(operation.localId)
      )
        throw new Error("Invalid account operation mapping");
      const account = backup.accounts.find((row) => row.id === operation.localId);
      if (!account || account.currency !== command.currency || account.name !== command.name)
        throw new Error("Account operation does not match its local record");
      const opening = backup.transactions.find(
        (row) => row.accountId === operation.localId && row.kind === "opening",
      );
      if (
        (opening && (opening.amount !== command.openingBalance || opening.date !== command.date)) ||
        (!opening && command.openingBalance !== 0)
      )
        throw new Error("Account operation does not match its opening balance");
      created.add(operation.localId);
    } else if (operation.kind === "category" || operation.kind === "payee") {
      const command = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ operationId: Id, value: NamedRecord })),
        { onExcessProperty: "error" },
      )(operation.payload);
      const rows = operation.kind === "category" ? backup.categories : backup.payees;
      if (
        command.operationId !== operation.operationId ||
        command.value.id !== operation.localId ||
        !rows.some((row) => row.id === operation.localId && row.name === command.value.name) ||
        created.has(operation.localId)
      )
        throw new Error("Invalid classification operation mapping");
      created.add(operation.localId);
    } else if (operation.kind === "create") {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(CreateTransaction), {
        onExcessProperty: "error",
      })(operation.payload);
      const local = backup.transactions.find((row) => row.id === operation.localId);
      if (
        command.operationId !== operation.operationId ||
        !local ||
        local.kind !== "transaction" ||
        local.accountId !== command.accountId ||
        local.amount !== command.amount ||
        local.date !== command.date ||
        !available(command.accountId, pendingAccounts) ||
        created.has(operation.localId)
      )
        throw new Error("Invalid transaction operation mapping or order");
      checkClassifications(command);
      created.add(operation.localId);
    } else if (operation.kind === "planning") {
      const command = planningCommands([operation])[0];
      if (!command || command.operationId !== operation.operationId)
        throw new Error("Invalid planning operation identity");
      const localId =
        command.type === "budget" || command.type === "schedule"
          ? command.value.id
          : command.type === "plan" || command.type === "reservation"
            ? command.value.budgetId
            : command.type === "generate" || command.type === "occurrence"
              ? command.id
              : command.occurrenceId;
      if (localId !== operation.localId) throw new Error("Invalid planning operation mapping");
      if (command.type === "pendingOccurrence") {
        if (!command.transactionId) throw new Error("Missing provisional payment");
        created.add(command.transactionId);
      }
    } else {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command), {
        onExcessProperty: "error",
      })(operation.payload);
      const local = backup.transactions.find((row) => row.id === operation.localId);
      if (
        command.type !== "editTransaction" ||
        command.operationId !== operation.operationId ||
        command.id !== operation.localId ||
        command.revision < 0 ||
        !local ||
        local.kind !== "transaction" ||
        local.transferId ||
        (plannedPayments.has(operation.localId) && !created.has(operation.localId)) ||
        (backup.outbox.some((row) => row.kind === "create" && row.localId === operation.localId) &&
          !created.has(operation.localId))
      )
        throw new Error("Invalid edit operation mapping or order");
      checkClassifications(command);
    }
  }
  const commands = planningCommands(backup.outbox);
  const projected = projectPlanning(backup.planning, commands);
  validatePlanning(
    projected,
    backup.accounts,
    backup.categories,
    backup.payees,
    [...backup.transactions, ...backup.deferredTransactions],
    backup.outbox.some(
      (row) =>
        row.kind === "planning" &&
        row.error !== null &&
        planningCommands([row])[0]?.type === "match",
    ),
  );
  for (const command of commands) {
    if (command.type !== "pendingOccurrence") continue;
    const occurrence = projected.occurrences.find((row) => row.id === command.occurrenceId);
    const local = backup.transactions.find((row) => row.id === command.transactionId);
    if (
      !occurrence ||
      !local ||
      local.accountId !== occurrence.accountId ||
      ((local.amount !== occurrence.amount || local.date !== occurrence.date) &&
        !backup.outbox.some((row) => row.kind === "planning" && row.error !== null))
    )
      throw new Error("Queued payment differs from its occurrence");
  }
  for (const local of backup.transactions) {
    const creation = backup.outbox.find((row) => row.kind === "create" && row.localId === local.id);
    const accepted = backup.accepted.find((row) => row.id === local.id);
    if (creation && accepted)
      throw new Error("Accepted transaction cannot also have a queued creation");
    const pendingPayment = commands.some(
      (command) => command.type === "pendingOccurrence" && command.transactionId === local.id,
    );
    if (local.kind === "transaction" && !creation && !accepted && !pendingPayment)
      throw new Error("Transaction has neither an accepted record nor a queued creation");
    const edits = backup.outbox.filter((row) => row.kind === "edit" && row.localId === local.id);
    let previousRevision: number | undefined;
    for (const edit of edits) {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(edit.payload);
      if (
        command.type !== "editTransaction" ||
        (previousRevision !== undefined && command.revision !== previousRevision + 1)
      )
        throw new Error("Queued edit revisions are out of order");
      previousRevision = command.revision;
    }
    const last = edits.at(-1);
    if (last) {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(Command))(last.payload);
      if (
        command.type !== "editTransaction" ||
        local.revision !== command.revision + 1 ||
        local.status !== command.status ||
        (local.categoryId ?? null) !== command.categoryId ||
        (local.payeeId ?? null) !== command.payeeId ||
        (local.notes ?? null) !== command.notes
      )
        throw new Error("Queued edit does not match its local record");
    } else if (creation) {
      const command = Schema.decodeUnknownSync(Schema.fromJsonString(CreateTransaction))(
        creation.payload,
      );
      if (
        (local.status ?? "posted") !== (command.status ?? "posted") ||
        (local.categoryId ?? null) !== (command.categoryId ?? null) ||
        (local.payeeId ?? null) !== (command.payeeId ?? null) ||
        (local.notes ?? null) !== (command.notes ?? null) ||
        (local.revision ?? 0) !== 0
      )
        throw new Error("Queued creation does not match its local record");
    } else if (accepted && JSON.stringify(local) !== JSON.stringify(accepted)) {
      throw new Error("Local transaction differs from accepted data without a queued edit");
    }
  }
  if (
    backup.serverUrl === null &&
    (backup.accepted.length > 0 ||
      backup.planning.budgets.length > 0 ||
      backup.planning.schedules.length > 0 ||
      backup.deferredTransactions.length > 0 ||
      backup.transactions.some(
        (row) =>
          (row.revision ?? 0) > 0 &&
          !backup.outbox.some((operation) => operation.localId === row.id),
      ))
  )
    throw new Error("Synchronized data requires its original server URL");
  return backup;
}

export function backupContent(backup: MobileBackup): string {
  return JSON.stringify({ ...backup, createdAt: "" });
}

export function backupSummary(backup: MobileBackup) {
  return {
    createdAt: backup.createdAt,
    serverUrl: backup.serverUrl,
    accounts: backup.accounts.length,
    transactions: backup.transactions.length,
    budgets: projectPlanning(backup.planning, planningCommands(backup.outbox)).budgets.length,
    pending: backup.outbox.length,
    failed: backup.outbox.filter((row) => row.error !== null).length,
  };
}

export class BackupFileError extends Data.TaggedError("BackupFileError")<{
  message: string;
}> {}

export const saveBackupFile = Effect.fn("saveBackupFile")(function* (text: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const backup = decodeBackup(text);
      const directory = await Directory.pickDirectoryAsync();
      const file = directory.createFile(
        `bean-budget-mobile-${backup.createdAt.replace(/[:.]/g, "-")}.json`,
        "application/json",
      );
      await file.write(text);
      if ((await file.text()) !== text) throw new Error("Backup verification failed");
      return file.name;
    },
    catch: () =>
      new BackupFileError({
        message: "Backup was not saved and verified. Choose a writable folder and try again.",
      }),
  });
});

export const pickBackupFile = Effect.tryPromise({
  try: async () => {
    const result = await File.pickFileAsync({ mimeTypes: ["application/json", "text/plain"] });
    if (result.canceled) return null;
    const file = result.result;
    if (file.size > MAX_BACKUP_BYTES) throw new Error("Backup exceeds 20 MB");
    return await file.text();
  },
  catch: () =>
    new BackupFileError({
      message: "Cannot read this backup. Choose a mobile backup under 20 MB.",
    }),
});
