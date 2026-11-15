# Android widgets

Bean Budget includes Spend Bean's square and wide TODAY/WEEK spending designs with fixed demo inputs, plus its plus-only quick-add tile. All use Bean Budget's bean palette. A separate live balance widget reads the local register.

| Widget             | Size                                       | Data                                                                                  |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Spending demo      | 2 by 2 target cells, 160 by 160 dp preview | Fixed TODAY/WEEK allotments and spending, ten-segment bars and a visible DEMO marker  |
| Spending demo wide | 4 by 1 target cells, 320 by 80 dp preview  | The same fixed values arranged in shallow horizontal label/bar/amount rows            |
| Add transaction    | 1 target cell, minimum 40 by 40 dp         | Plus-only shortcut opens transaction entry, or account creation for an empty register |
| Bean balances      | Minimum 180 by 180 dp, resizable           | Live posted/projected totals across local accounts, separated by JPY and USD          |

Launcher cell dimensions vary. Shortcuts resume an active app form without discarding its contents and wait for an in-progress action to finish.

## Spending design previews

`SpendingWidgets.kt` holds one explicit set of hardcoded demo inputs copied from Spend Bean's preview. TODAY has 3,200 yen allotted and 1,850 spent, leaving 1,350 yen. WEEK has 22,400 yen allotted and 9,100 spent, leaving 13,300 yen. Weekly pace is three sevenths.

The square widget places each label and remaining amount above a segmented bar. The wide widget places label, bar and amount in each horizontal row. Filled segments show the spent fraction. The weekly bar uses the lighter selected color through the elapsed pace; spending beyond the allotment or weekly pace uses the error color. The quick-add tile has only a centered plus and 16 dp corners, matching Spend Bean's composition.

The spending widgets are design previews. Their picker labels and visible DEMO marker identify the fixed values. They do not read or write ledger records, pretend to synchronize, or display a fabricated update time. Connecting real budget inputs is separate work. The live balance widget remains available for actual ledger data.

## Storage and lifecycle

`apps/mobile/modules/bean-widgets` is a local Expo Android module. Android `AppWidgetProvider` callbacks render native `RemoteViews` on a background executor, without starting JavaScript or making network requests. The app calls its `refresh` method after register reads following initialization, mutations, conflict recovery, synchronization and restore. Android provider updates and resize callbacks can redraw while the app activity is absent.

The live balance provider opens `files/SQLite/bean-budget.sqlite` read-only. It never creates or migrates storage. A single aggregate SQL statement reads committed balances, queue counts and timestamps from the same SQLite snapshot, including WAL content. Bank-pending entries affect projected balances only. Currency totals remain separate. Invalid money, references, currency, timestamps, unsupported schemas, unavailable JSON SQL functions or integer overflow produce an unavailable message rather than plausible zero balances.

The live balance renderer uses Android's SQLite JSON functions and Java time APIs. Verification covers Android API 37. Older platform SQLite builds without JSON functions display the unavailable state; compatibility across older Android versions is not verified. Pixel 9a verification remains manual work for the user.

Mobile schema 4 adds triggers on local records and outbox changes to record `widgetUpdatedAt` within the financial transaction. Successful synchronization records `lastSyncedAt` with its final snapshot merge. Restore clears the previous sync time and records a new local update time. The widget labels timestamps in Asia/Tokyo and does not imply that an idle app synchronizes in the background. Android's 30-minute provider interval is best effort under power restrictions.

Widget refresh failure does not fail a committed financial action. The app reports a widget warning and retries on the next register read. Backup format 1 excludes these operational timestamps and remains compatible. Older application binaries reject schema 4; retain a verified mobile export before updating.

`apps/mobile/modules/bean-widgets/with-widgets.ts` generates native color resources from `src/ui/theme.ts` during Expo prebuild. Generated Android projects stay ignored. The palette keep rule retains colors selected dynamically under release resource shrinking.

## Verification

Runtime evidence uses synthetic data in the isolated `app.beanbudget.probe` package on a separate temporary API 37 ARM64 emulator, configured at 1080 by 2424 pixels and density 420. The probe APK embeds Hermes JavaScript and uses a temporary synthetic signing key. It does not depend on Metro. The existing Bean Budget emulator, launcher and apps remain untouched.

Screenshots captured through a temporary Android `AppWidgetHost` show the provider's actual `RemoteViews` at exact dp sizes, not React previews or mockups. Spending captures use 160 by 160 dp and 320 by 80 dp, matching Spend Bean's own preview frames. The plus-only tile uses 72 by 72 dp. The Pixel Launcher also displays the default 2 by 2, 4 by 1 and 1 by 1 placements without resizing. The DEMO marker remains visible in all spending frames. The spending demos also rendered offline after process death with no React Native JavaScript logs. Tapping a spending card opened the register; tapping plus opened transaction entry. The following live-balance probes remain verified:

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
