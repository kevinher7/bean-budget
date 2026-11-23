# Android widgets

Bean Budget includes two budget spending widgets, a quick-add shortcut and a live balance widget.

| Widget               | Size                               | Data                                                                     |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| Budget spending      | 2 by 2 target cells                | Net spending today and since Monday across the selected budget           |
| Budget spending wide | 4 by 1 target cells                | Net daily spending with the weekly total alongside it                    |
| Add transaction      | 1 target cell, minimum 40 by 40 dp | Opens transaction entry or account creation                              |
| Bean balances        | Minimum 180 by 180 dp, resizable   | Posted and projected totals across local accounts, separated by currency |

## Choose a budget

Choose a budget when placing a widget. A single available budget is selected automatically. The square widget stacks TODAY and WEEK over ten-segment bars. The wide widget puts each label, bar and amount on one row. Both amounts show net spending across the budget’s accounts. WEEK starts on Monday. The Tokyo date and budget name appear below the amounts. Tapping opens the budget overview.

Pending and posted purchases count once, including uncategorized purchases and actual bill payments. Categorized refunds reduce spending on the refund date. Income, transfers, opening balances, and scheduled estimates are excluded. Category allocations and planning rhythms have no effect on these totals.

The TODAY bar compares total spending with the sum of the day’s planned allowances for daily categories. WEEK uses the combined limits of daily and weekly categories, including both parts of a calendar week split by a budget boundary. Monthly-only allocations contribute no daily or weekly target. The lighter weekly segments mark elapsed days. Spending above weekly pace or above a daily allowance uses the warning color. With no applicable plan the bar shows empty segments. The app prepares six calendar weeks of targets when reading the register. After those dates, the widget still shows live spending and resumes displaying targets when the app opens.

## Storage and lifecycle

`apps/mobile/modules/bean-widgets` is a local Expo Android module. Android `AppWidgetProvider` callbacks render native `RemoteViews` on a background executor, without starting JavaScript or making network requests. The app calls its `refresh` method after register reads following initialization, mutations, conflict recovery, synchronization and restore. Android provider updates and resize callbacks can redraw while the app activity is absent.

The live balance provider opens `files/SQLite/bean-budget.sqlite` read-only. It never creates or migrates storage. A single aggregate SQL statement reads committed balances, queue counts and timestamps from the same SQLite snapshot, including WAL content. Bank-pending entries affect projected balances only. Currency totals remain separate. Invalid money, references, currency, timestamps, unsupported schemas, unavailable JSON SQL functions or integer overflow produce an unavailable message rather than plausible zero balances.

The live balance renderer uses Android's SQLite JSON functions and Java time APIs. Verification covers Android API 37. Older platform SQLite builds without JSON functions display the unavailable state; compatibility across older Android versions is not verified. Pixel 9a verification remains manual work for the user.

Mobile schema 4 adds triggers on local records and outbox changes to record `widgetUpdatedAt` within the financial transaction. Successful synchronization records `lastSyncedAt` with its final snapshot merge. Restore clears the previous sync time and records a new local update time. The widget labels timestamps in Asia/Tokyo and does not imply that an idle app synchronizes in the background. Android's 30-minute provider interval is best effort under power restrictions.

Schema 7 stores each budget's projected account membership and linked income transaction IDs in local metadata. Record, outbox, planning, server binding and deferred receipt changes invalidate this metadata in the same transaction. Register reads republish it, including after restore. A missing scope or an incomplete budget shows a setup or refresh prompt.

The native provider sums register transactions for the current Tokyo date and Monday through today in one SQLite query. Midnight alarms, clock changes, and periodic widget updates trigger redraws without a running JavaScript bundle. Android may delay alarms under power restrictions. Each widget displays its financial date. Widget refresh failures do not roll back financial changes. Older binaries reject schema 7. Mobile exports retain the underlying ledger and omit the widget metadata and launcher selections.

`apps/mobile/modules/bean-widgets/with-widgets.ts` generates native color resources from `src/ui/theme.ts` during Expo prebuild. Generated Android projects stay ignored. The palette keep rule retains colors selected dynamically under release resource shrinking.

## Verification

Both widget sizes showed ¥2,250 on an API 37 emulator for ¥800 in Conbini purchases, ¥1,250 in groceries, an uncategorized ¥300 purchase and a ¥100 refund. A ¥5,000 income entry and a ¥750 purchase in another budget did not affect the total. Advancing the emulator clock to the next Tokyo day while the app was closed changed today to ¥0 and kept this week at ¥2,250.

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
