# Mobile register

The register reads and writes `bean-budget.sqlite` in the app sandbox. Accounts use JPY whole yen or USD cents. Opening entries, pending entries and posted entries all persist locally. Posted balance excludes bank-pending entries; projected balance includes them. Synchronization status is separate from bank status.

Every local mutation commits its record and outbox operation in one synchronous SQLite transaction. Account and classification IDs originate on the device. Transaction IDs reconcile to the server's accepted receipt ID, including dependent queued metadata edits. Outbox order places creation before dependent operations. A failed operation stops the queue and retains its original operation ID and payload. Retry never invents a new financial intent.

Version 1 databases migrate in a single transaction. The old cash account becomes a named JPY account with a durable creation operation before the preserved transaction operations. Original transaction amounts, dates and operation IDs remain intact. A missing legacy outbox record fails migration rather than dropping a transaction.

The first synchronization slice uses authenticated `GET /register` snapshots. It has no change feed or deletion support. Incoming snapshots update accepted records and preserve local records with queued edits. Accounts with unresolved transaction creation defer incoming transactions until receipt reconciliation, preventing a lost acknowledgement from displaying both provisional and accepted copies. Provisional opening entries remain until an incoming opening entry replaces them atomically.

A stale edit remains failed. Synchronize again to refresh the accepted revision. "Keep local edit" explicitly submits the current local metadata and posting intent against that revision with a new operation ID. "Use server" explicitly removes queued metadata edits and restores the accepted transaction. A server-posted transaction cannot become pending through conflict recovery. Financial amounts and dates cannot be edited in this milestone.

Connection credentials belong in platform secure storage. The connection screen accepts the server URL and token; tokens do not belong in public Expo variables. The Android emulator reaches the host at `http://10.0.2.2:3000`. For USB or loopback connections, configure adb reverse as described in [Android development](ANDROID_DEVELOPMENT.md). Use HTTPS for remote servers.

The signed Android release bundles JavaScript and starts without Metro. Development builds still use Metro. See [Android release and updates](ANDROID_RELEASE.md) for identity, signing, installation and Obtainium. Database persistence survives force-stop and updates, but uninstalling or clearing app data removes unsynchronized entries.

The Backup screen exports the complete local register, planning inputs, accepted snapshots, ordered outbox operations and original server URL as versioned JSON. Tokens stay in SecureStore. Export writes to a folder selected through Android and verifies the saved bytes. Restore validates the content, shows counts, requires a saved recovery copy and explicit replacement confirmation, then replaces the register in one transaction with verified readback. It rejects a changed register or a different saved server. See [backup and restore](BACKUP.md) for server backups and recovery limits.

## Android widgets

Add Bean Budget widgets from the Android launcher's widget picker. Quick add opens a new expense entry, or account creation when the register is empty. Register summary opens the register and resizes between compact and wide layouts. Budget spending and Budget spending wide show net spending today and since Monday across the selected budget’s accounts. Each widget opens its budget overview. The plus-only quick-add tile and all summaries use the app's bean color tokens. The register and entry screens keep their existing layout.

The summary shows posted and projected balances separately for each currency across local accounts. It never combines JPY and USD or presents a ledger balance as a spending allowance. Bank-pending entries affect projected balances. Waiting and failed operation counts describe synchronization separately.

Native Android providers read the existing SQLite database in read-only mode, including committed WAL content, without starting React Native or contacting a server. One SQL statement reads balances, outbox counts and freshness metadata consistently. Missing, unsupported or unreadable storage displays a setup or unavailable message instead of zero balances. Rendering never creates or migrates the database.

Local records and outbox changes update a committed timestamp through SQLite triggers. Successful synchronization records its own timestamp. Restoring a backup clears the previous sync timestamp and marks the restored register updated now. These timestamps are operational metadata, not financial dates, and are not part of backup format 1. Existing backups remain compatible.

Register reads request a widget refresh after initialization, local mutations, conflict recovery, sync and restore. If Android cannot refresh, the app retains the saved register and displays a widget warning. Android also refreshes widgets on provider updates and resizing. Periodic refresh is best effort under Android power restrictions. A widget timestamp describes committed local data, not a promise of background synchronization.

See [Android widgets](WIDGETS.md) for implementation ownership and emulator verification.

## Budget periods and recurring payments

Open Budget from the register. Create recurring income and expense templates, then create a tracking budget with its currency, included accounts, start day, first period and reserved bills. Accounts must use the budget currency. Account scope and period boundaries stay fixed. The first period starts with zero carryover.

The budget overview shows the selected period's unbudgeted balance and one amount per category. Daily categories show what is left today, weekly categories show what is left this week, and monthly categories show their remaining balance. Use the arrows to change periods. Open Period details to see posted income, forecasts, reserved bills, assignable funds and prior overspending. Allocate opens the forecast and category allocations. Forecasts can use generated income estimates or a manual nonnegative amount. Explicit zero differs from a blank forecast. Pending purchases consume category availability immediately. Positive category entries count as refunds unless linked to scheduled income. Transfers and opening balances do not count as spending.

Tap a category to see its spending and weekly limits. Choose **Plan next period** to change its allocation or rhythm for the following period. Choose **Edit this period** to change the displayed period instead. Select a week to adjust its limit. If the category has a positive opening balance, enter how much to keep for weekly use. The rest becomes unbudgeted. Preview the projected unbudgeted balance before saving.

Weekly limits follow Monday boundaries and split the monthly allocation by days. Enter a week amount to fix its limit or clear the field to make it flexible. An increase can take monthly unbudgeted below zero. Daily categories show what is left today. Spending lowers that figure immediately. At Tokyo midnight, the remaining weekly allowance splits across the days left, with spare yen or cents going to the earliest days.

Open **Budget settings** to create budgets, switch budgets, or manage recurring templates. Open **Expected payments** to see occurrences and generate missing estimates. Recurring templates do not generate payments automatically. The screen lists missing estimates from the first period through the selected period, including both calendar months intersecting a non-calendar period. Review the dates before choosing Generate. A newly added template can therefore generate historical estimates only through that explicit action. Inactive templates do not generate new occurrences. Existing occurrences retain their amounts and dates after template edits.

Unmatched estimates can change amount while keeping their direction. Create a pending payment or select an existing same-account, same-sign ordinary entry as full settlement. Post pending payments in the register. A reserved commitment uses its estimate until its linked payment posts, then uses the actual amount. Partial payments and automatic matching remain unsupported.

Reserved bills can change from a selected period until the next saved selection. Preview unassigned funds and changed category remainders before confirming. Historical selections recalculate carryover. The occurrence's expected period determines reservation, including when its payment settles in another period. Currency, accounts, start day and first period remain fixed.

All planning edits persist with ordered outbox operations. Local summaries use shared calculations over accepted inputs and pending edits. Synchronization uses a complete atomic register snapshot containing planning inputs and ledger history. Revisions protect period replacements, templates, occurrence actions and the reservation timeline. Repeated operations retain their IDs until acknowledgement. Failed replacements can retain local intent against the refreshed server revision or discard the related queued edits. Competing payment matches require a new explicit selection. Discard dependent queued changes first if removing a setup operation would leave references behind.

During unresolved transaction receipt reconciliation, incoming account transactions may remain deferred. The app preserves those snapshot rows in exports and hides affected budget availability until synchronization finishes. It does not calculate carryover from an incomplete ledger. Failed planning operations also hide availability until recovery. Exports retain conflicting provisional payments even when the accepted estimate has changed.

Mobile schema 5 and backup format 2 include planning state, deferred snapshot transactions and planning operations. Format-1 exports still import with empty planning state. Schema 7 stores the account scope used by spending widgets. Older binaries cannot open that database. Export a recovery copy before updating.

While the app is active, it requests synchronization on foreground entry,
WebSocket connection, ledger change hints, and once per minute. Sync now uses
the same queue. A request arriving during a local operation or sync waits for
that operation to finish. Android can suspend the app in the background, so
this does not guarantee background refresh.
