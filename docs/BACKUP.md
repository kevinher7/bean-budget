# Backup and restore

Keep server and mobile backups. The server stores accepted ledger records, budgets, import identities and operation receipts. A mobile export also preserves edits that have not reached the server, ordered outbox operations and receipt reconciliation state. A server snapshot cannot recover those unsynchronized edits. A mobile export is not a server backup.

Backups contain financial data in plaintext. Store them in a private, encrypted location. Ordinary exports exclude connection access tokens and Android signing keys. Keep credentials and the durable release signing key in separate secure storage.

## Server

Use the repository's Node 22 environment. The following commands do not read `BEAN_TOKEN` or `.local/server-token`.

```sh
npx tsx tools/server-backup.mts export /path/to/server.sqlite /private/backups/bean-001
npx tsx tools/server-backup.mts verify /private/backups/bean-001
npx tsx tools/server-backup.mts restore /private/backups/bean-001 /path/to/recovered.sqlite
```

Export uses [Node's SQLite backup API](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html#sqlitebackupsourceDb-destination-options), which captures a consistent database while the server runs, including committed WAL content. Copying only a live `.sqlite` file can lose committed data. See [SQLite's online backup documentation](https://www.sqlite.org/backup.html).

Each backup directory contains `server.sqlite` and `manifest.json`. Keep both files together. The manifest identifies server backup format 1 and server schema 3, with byte length and SHA-256. Verification rejects another backup kind, unsupported versions, a changed digest, an unexpected schema or migration journal, SQLite corruption, broken foreign keys, invalid domain records and invalid operation receipts. It verifies a private temporary copy, leaving the exported files unchanged. SHA-256 detects corruption; it does not authenticate a file supplied by someone else.

Restore creates a new database path. It refuses an existing file or SQLite sidecar and never replaces a running database. It validates before installing the new file, using a no-overwrite atomic hard link on the destination filesystem. To switch a deployment, stop its server, retain the old database and its sidecars, point `BEAN_DATABASE` at the recovered path, and restart with the separately stored token. For Compose, stop the service and restore into its persistent volume through an operator-controlled mounted path. Do not delete its named volume.

After restart, inspect account counts and balances. Retry any interrupted mobile sync against the restored server and confirm original operation IDs return their original records. Restoring an older server snapshot while clients contain later accepted records needs a separate reconciliation plan. Do not treat the client's synchronized cache as a queue of those missing server operations.

An incomplete export directory has no verified manifest. Keep the previous good backup until the new backup passes `verify`. Backup verification does not replace an actual restore drill.

## Mobile

Use the app's backup screen to export the complete local register before replacing data. Review the selected backup and its counts before confirming restore. Restore replaces the local register atomically; it does not merge two independent registers. Export the current register first to preserve edits made after an older backup.

A mobile backup preserves stable operation IDs, accepted snapshots and pending operations, so an interrupted acknowledgement can be retried without creating a new financial intent. SecureStore credentials stay outside the exported data. Reconnect to the same server using its separately stored token before synchronizing restored records. Uninstalling the app or clearing its storage can remove unsynchronized data, so neither action is a backup procedure.
