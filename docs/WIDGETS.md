# Android widgets

Bean Budget has two home-screen widgets inspired by Spend Bean's quick-add tile and rounded summary cards. They use Bean Budget's bean palette. The summary reports the implemented ledger rather than a budget allowance.

| Widget          | Size                             | Behavior                                                                              |
| --------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| Add transaction | 1 cell, minimum 56 by 64 dp      | Opens transaction entry, or account creation for an empty register                    |
| Bean balances   | Minimum 180 by 180 dp, resizable | Shows posted and projected totals across all local accounts, separated by JPY and USD |

Launcher cell dimensions vary. The summary keeps its stacked currency rows when widened. Shortcuts resume an active app form without discarding its contents, and wait for an in-progress action to finish.

## Storage and lifecycle

`apps/mobile/modules/bean-widgets` is a local Expo Android module. Android `AppWidgetProvider` callbacks render native `RemoteViews` on a background executor, without starting JavaScript or making network requests. The app calls its `refresh` method after register reads following initialization, mutations, conflict recovery, synchronization and restore. Android provider updates and resize callbacks can redraw while the app activity is absent.

The provider opens `files/SQLite/bean-budget.sqlite` read-only. It never creates or migrates storage. A single aggregate SQL statement reads committed balances, queue counts and timestamps from the same SQLite snapshot, including WAL content. Bank-pending entries affect projected balances only. Currency totals remain separate. Invalid money, references, currency, timestamps, unsupported schemas, unavailable JSON SQL functions or integer overflow produce an unavailable message rather than plausible zero balances.

The renderer uses Android's SQLite JSON functions and Java time APIs. Verification covers Android API 37. Older platform SQLite builds without JSON functions display the unavailable state; compatibility across older Android versions is not verified. Pixel 9a verification remains manual work for the user.

Mobile schema 4 adds triggers on local records and outbox changes to record `widgetUpdatedAt` within the financial transaction. Successful synchronization records `lastSyncedAt` with its final snapshot merge. Restore clears the previous sync time and records a new local update time. The widget labels timestamps in Asia/Tokyo and does not imply that an idle app synchronizes in the background. Android's 30-minute provider interval is best effort under power restrictions.

Widget refresh failure does not fail a committed financial action. The app reports a widget warning and retries on the next register read. Backup format 1 excludes these operational timestamps and remains compatible. Older application binaries reject schema 4; retain a verified mobile export before updating.

`apps/mobile/with-widgets.ts` generates native color resources from `src/ui/theme.ts` during Expo prebuild. Generated Android projects stay ignored. The palette keep rule retains colors selected dynamically under release resource shrinking.

## Verification

Runtime evidence uses synthetic data in the isolated `app.beanbudget.probe` package on a separate temporary API 37 ARM64 emulator, configured at 1080 by 2424 pixels and density 420. The probe APK embeds Hermes JavaScript and uses a temporary synthetic signing key. It does not depend on Metro. The existing Bean Budget emulator, launcher and apps remain untouched.

Screenshots captured through a temporary Android `AppWidgetHost` show the provider's actual `RemoteViews` at exact dp sizes, not React previews or mockups. The following manual probes passed:

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

The original 150 dp width clipped the maximum USD amount. Both initial and resize minima now require 180 dp. The summary omits target-cell sizing because Android 12 and later use it instead of the dp minimum. Cell counts depend on the launcher.

Actual screenshot assets live in [docs/images/widgets](images/widgets). The PR embeds the PNGs through URLs pinned to their Git commit. Full screenshots remain local; committed crops retain the actual widget pixels with a small margin. No screenshot contains private financial data.

## References

- [Android app widget providers and layouts](https://developer.android.com/develop/ui/views/appwidgets)
- [Android widget sizing rules](https://developer.android.com/develop/ui/views/appwidgets/layouts)
- [Expo local native modules](https://docs.expo.dev/modules/get-started/)
- [Expo module autolinking](https://docs.expo.dev/modules/autolinking/)
- [SQLite JSON function availability](https://www.sqlite.org/json1.html)
