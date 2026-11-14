# Mobile register

The register reads and writes `bean-budget.sqlite` in the app sandbox. Accounts use JPY whole yen or USD cents. Opening entries, pending entries and posted entries all persist locally. Posted balance excludes bank-pending entries; projected balance includes them. Synchronization status is separate from bank status.

Every local mutation commits its record and outbox operation in one synchronous SQLite transaction. Account and classification IDs originate on the device. Transaction IDs reconcile to the server's accepted receipt ID, including dependent queued metadata edits. Outbox order places creation before dependent operations. A failed operation stops the queue and retains its original operation ID and payload. Retry never invents a new financial intent.

Version 1 databases migrate in a single transaction. The old cash account becomes a named JPY account with a durable creation operation before the preserved transaction operations. Original transaction amounts, dates and operation IDs remain intact. A missing legacy outbox record fails migration rather than dropping a transaction.

The first synchronization slice uses authenticated `GET /register` snapshots. It has no change feed or deletion support. Incoming snapshots update accepted records and preserve local records with queued edits. Accounts with unresolved transaction creation defer incoming transactions until receipt reconciliation, preventing a lost acknowledgement from displaying both provisional and accepted copies. Provisional opening entries remain until an incoming opening entry replaces them atomically.

A stale edit remains failed. Synchronize again to refresh the accepted revision. "Keep local edit" explicitly submits the current local metadata and posting intent against that revision with a new operation ID. "Use server" explicitly removes queued metadata edits and restores the accepted transaction. A server-posted transaction cannot become pending through conflict recovery. Financial amounts and dates cannot be edited in this milestone.

Connection credentials belong in platform secure storage. The connection screen accepts the server URL and token; tokens do not belong in public Expo variables. The Android emulator reaches the host at `http://10.0.2.2:3000`. For USB or loopback connections, configure adb reverse as described in [Android development](ANDROID_DEVELOPMENT.md). Use HTTPS for remote servers.

The signed Android release bundles JavaScript and starts without Metro. Development builds still use Metro. See [Android release and updates](ANDROID_RELEASE.md) for identity, signing, installation and Obtainium. Database persistence survives force-stop and updates, but uninstalling or clearing app data removes unsynchronized entries.

The Backup screen exports the complete local register, accepted snapshots, ordered outbox operations and original server URL as versioned JSON. Tokens stay in SecureStore. Export writes to a folder selected through Android and verifies the saved bytes. Restore validates the content, shows counts, requires a saved recovery copy and explicit replacement confirmation, then replaces the register in one transaction with verified readback. It rejects a changed register or a different saved server. See [backup and restore](BACKUP.md) for server backups and recovery limits.
