import { Data, Effect } from "effect";
import { Directory, File } from "expo-file-system";
import { decodeBackup, MAX_BACKUP_BYTES } from "./backup.ts";

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
