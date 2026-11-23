# Android widgets

Bean Budget includes two category spending widgets, a quick-add shortcut and a live balance widget.

| Widget                 | Size                               | Data                                                                     |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Category spending      | 2 by 2 target cells                | One category's money left today and this week                            |
| Category spending wide | 4 by 1 target cells                | The same amounts with horizontal spending bars                           |
| Add transaction        | 1 target cell, minimum 40 by 40 dp | Opens transaction entry or account creation                              |
| Bean balances          | Minimum 180 by 180 dp, resizable   | Posted and projected totals across local accounts, separated by currency |

## Choose a category

Add a spending widget and tap **Choose a category**. Each widget keeps its own budget and category. Daily categories show TODAY and WEEK. Weekly categories show WEEK. A configured widget opens its category in Budget. With a form open, the app preserves the draft. Use the launcher's reconfigure action to change an existing selection. If a category no longer has a paced plan, tap the widget to choose another.

Filled segments show spending against the allowance. Lighter weekly segments indicate the fraction of the clipped week elapsed. The widget shows its Tokyo financial date. When the app last calculated the plan on an earlier date, the footer also shows that date.

## Storage and lifecycle

`apps/mobile/modules/bean-widgets` is a local Expo Android module. Android `AppWidgetProvider` callbacks render native `RemoteViews` on a background executor, without starting JavaScript or making network requests. The app calls its `refresh` method after register reads following initialization, mutations, conflict recovery, synchronization and restore. Android provider updates and resize callbacks can redraw while the app activity is absent.

The live balance provider opens `files/SQLite/bean-budget.sqlite` read-only. It never creates or migrates storage. A single aggregate SQL statement reads committed balances, queue counts and timestamps from the same SQLite snapshot, including WAL content. Bank-pending entries affect projected balances only. Currency totals remain separate. Invalid money, references, currency, timestamps, unsupported schemas, unavailable JSON SQL functions or integer overflow produce an unavailable message rather than plausible zero balances.

The live balance renderer uses Android's SQLite JSON functions and Java time APIs. Verification covers Android API 37. Older platform SQLite builds without JSON functions display the unavailable state; compatibility across older Android versions is not verified. Pixel 9a verification remains manual work for the user.

Mobile schema 4 adds triggers on local records and outbox changes to record `widgetUpdatedAt` within the financial transaction. Successful synchronization records `lastSyncedAt` with its final snapshot merge. Restore clears the previous sync time and records a new local update time. The widget labels timestamps in Asia/Tokyo and does not imply that an idle app synchronizes in the background. Android's 30-minute provider interval is best effort under power restrictions.

Mobile SQLite schema 6 adds a rebuildable table of category weeks. During a register read the app uses the shared budget calculation to publish the current and following budget periods, including dated daily allowances and queued offline edits. Changes to the underlying records, outbox, planning or deferred receipts invalidate the previous result in the same write transaction. A failed planning operation or deferred transaction hides availability for affected budgets.

The Android provider opens the database read-only, selects the active Tokyo week and reads that date's allowance. A midnight alarm, date and clock change broadcasts, and Android's periodic widget update request a redraw while the app is closed. Android may delay alarms under power restrictions. The visible financial date identifies the displayed numbers. Beyond the two cached periods the widget prompts the user to reopen the app. Restore rebuilds the table from the restored ledger. Mobile exports omit widget projections and launcher selections.

Widget refresh failure does not fail a committed financial action. The app reports a widget warning and retries on the next register read. Older app binaries reject schema 6. A verified mobile export can restore the underlying ledger independently of the projection table.

`apps/mobile/modules/bean-widgets/with-widgets.ts` generates native color resources from `src/ui/theme.ts` during Expo prebuild. Generated Android projects stay ignored. The palette keep rule retains colors selected dynamically under release resource shrinking.

## Verification

The spending widgets were exercised at 160 by 160 dp and 320 by 80 dp in an actual Android AppWidgetHost on an isolated API 37 emulator with synthetic data. A square widget tracked a daily Conbini plan while a wide widget tracked weekly groceries. A ¥400 bank-pending purchase entered with the server stopped moved TODAY from ¥886 to ¥486 and WEEK from ¥8,600 to ¥8,200. Posting and synchronizing kept both amounts. Groceries retained its own ¥3,500 weekly limit. After the app process was killed, the native midnight update changed TODAY to ¥1,367 and kept WEEK at ¥8,200. Moving the emulator clock past the following budget period replaced the amounts with a refresh prompt. Restoring an empty mobile backup cleared both widget amounts. Restoring the recovery copy rebuilt both budgets and their independent spending figures.

Earlier live-balance and quick-add verification on API 37 covered the following cases.

| Action                                                   | Observed result                                                                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Render before the app first opens                        | Setup message, no database created by the widget                                                                       |
| Save a bank-pending USD 12.34 expense                    | Existing widget changed projected USD 100.00 to 87.66, posted stayed 100.00, queue changed from 2 to 3                 |
| Synchronize                                              | Existing widget retained balances, cleared the queue and showed the successful sync time                               |
| Post the expense                                         | Posted USD became 87.66, projected stayed 87.66, one queued edit                                                       |
| Restore the pre-sync export through the guarded app flow | Existing widget returned to posted USD 100.00, projected 87.66 and three queued operations, with no old sync timestamp |
| Cold native rendering with no app process                | Widget rendered committed data without React Native JavaScript starting                                                |
| Hold a native SQLite write transaction open              | Redraw retained the old committed balance; after commit, redraw showed the new balance                                 |
| Tap quick add cold and while a draft contains 250        | Opened entry cold and preserved the existing draft on the warm tap                                                     |
| Render malformed JSON or maximum signed amounts          | Corrupt storage showed unavailable; maximum amounts and failed status fit at 180 by 180 dp                             |

The live balance widget requires 180 dp for both initial placement and resizing so maximum signed amounts remain readable. It omits target-cell sizing because Android 12 and later use it instead of the dp minimum. Cell counts depend on the launcher.

Screenshot evidence is embedded in [PR #13](https://github.com/kevinher7/bean-budget/pull/13) through URLs pinned to the earlier screenshot commit. The current documentation tree contains no screenshot assets. Full captures remain local; the PR images use actual widget pixels and synthetic data.

## References

- [Android app widget providers and layouts](https://developer.android.com/develop/ui/views/appwidgets)
- [Android widget sizing rules](https://developer.android.com/develop/ui/views/appwidgets/layouts)
- [Expo local native modules](https://docs.expo.dev/modules/get-started/)
- [Expo module autolinking](https://docs.expo.dev/modules/autolinking/)
- [SQLite JSON function availability](https://www.sqlite.org/json1.html)
