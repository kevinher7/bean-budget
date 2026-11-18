# Bean Budget lab

Run the lab from the repository root after `npm ci`. Each experiment starts its own server on a loopback port and creates its own SQLite database. Mail comes from a scripted Gmail adapter with synthetic input. This first lab runs headlessly. Android UI and interactive sessions are future work.

```sh
npm run lab -- list
npm run lab -- run mail-review-sync
npm run lab -- run mail-review-sync --disconnect-at review
```

The scenario opens a JPY account with ¥10,000 and ingests one ¥1,250 debit notification. It takes a snapshot before review, approves the queued message through the server API, and reads the register again. The baseline uses the WebSocket notification as a signal to refresh the register, with a fallback when the observation window expires. The variant closes the socket before approval, attempts to reconnect, then reads the register over HTTP. The report shows which events arrived and what the register returned.

Look at the review response, the frame counts in each observation window, and the posted and projected balance changes. A successful approval should reduce both balances by ¥1,250 and leave an accepted mail row with a single import identity and review receipt. Watch for an unavailable socket or missing observations before interpreting a zero count. Each observation window is 500 ms.

Copy the IDs printed by each run or look them up with `runs`. A unique suffix works in place of a full ID. The text diff shows outcomes and changes in parameters, inputs, code, and event counts. Use JSON for the before and after record differences.

```sh
npm run lab -- runs
BASELINE=your-baseline-run-id
VARIANT=your-disconnect-run-id
npm run lab -- show "$VARIANT"
npm run lab -- diff "$BASELINE" "$VARIANT"
npm run --silent lab -- diff "$BASELINE" "$VARIANT" --json
```

The ignored `.local/lab/<run-id>/` directory contains `run.json` and `ledger.sqlite`. The JSON includes the exact synthetic inputs, effective parameters, Git commit and source hashes, timed events, and the before and after snapshots. Use the printed replay command to repeat the scenario with the same options and a fresh database. Compare the revision and source hashes when running against a different checkout.

Add `--json` to `list`, `runs`, `run`, `show`, or `diff` for structured output. Use `npm run --silent` to suppress npm's script banner. Open `ledger.sqlite` in a SQLite viewer for table-level inspection. Each saved directory can be removed independently when you finish.
