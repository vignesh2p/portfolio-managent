# Portfolio daily history

Portfolio Value shows the daily amount and percentage change in parentheses. Positive changes use a green up arrow; negative changes use a red down arrow. The amount is the sum of current shares × (saved price − previous close); the percentage divides that sum by the previous-close value of the same holdings. It is unavailable when any required quote is missing, rather than a partial return.

The Portfolio > History tab shows portfolio market value, current-holding cost value, and unrealised profit (market value minus current-holding cost) together on one chart with distinct line patterns and a shared rupee scale with a daily values table. Periods: 30 days, 90 days, one year, and all history. Purchases/sales affect the curves; these are absolute values, not investment-return indices. Realised profit is excluded.

## Daily snapshots

- `vercel.json` configures `/api/cron/portfolio-history` Monday–Friday at `30 10 * * 1-5` UTC (16:00 Asia/Kolkata).
- Vercel Hobby may invoke the job up to 59 minutes late. The user accepted an approximate 4 pm run. The schedule activates on production deployment.
- Vercel sends the production `CRON_SECRET` as a Bearer token. Missing configuration fails closed. Production was checked and already has this variable.
- The endpoint ignores calls before 4 pm IST. `?dry_run=1`, with valid authentication, returns schedule metadata without writing.
- Every account except the internal system account gets a row on weekdays, including empty portfolios. Weekend runs and existing weekend rows are omitted from history. Snapshot dates use India time.
- Before each snapshot, the job forces a refresh of the full saved stock universe, then reads those saved quotes and calculates each user's portfolio value. This refresh can run after market close; Yahoo's quote timestamp records the underlying market price time.
- `portfolio_daily_history` stores market value, cost, profit, counts of missing/stale prices, oldest market timestamp, and actual recording time. Missing prices produce null market/profit values and chart gaps; old prices are flagged. Empty portfolios have zero value.
- Reading holdings and writing all users' snapshots is transactional. `(user_id,snapshot_date)` is unique; retries do not overwrite the day's saved holdings/valuation. A failed transaction can be retried.
- `GET /api/portfolio-history` requires login and returns only the authenticated user's saved rows. Deleting trades does not erase past snapshots; deleting an account cascades its history.
- History begins with the first successful scheduled run. Past dates are not fabricated or backfilled using today's holdings.

## Verification

Run `node --test tests/portfolio-history.test.js tests/sell-holdings.test.js tests/trade-yahoo-integration.test.js` and `node tests/portfolio-history-ui.cjs` with Playwright available. On runtimes that cannot spawn test workers use `--test-isolation=none`.

The UI test covers mobile/desktop layouts, chart data, arrows, keyboard tab traversal, and empty/error states. Data tests cover weighted daily change, missing quotes, multiple users, cron authentication, local dates, weekday-only snapshots, and retry immutability.
