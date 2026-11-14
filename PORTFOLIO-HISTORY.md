# Portfolio daily history

Portfolio Value shows the daily amount and percentage change in parentheses. Positive changes use a green up arrow; negative changes use a red down arrow. The amount is the sum of current shares × (saved price − previous close); the percentage divides that sum by the previous-close value of the same holdings. It is unavailable when any required quote is missing, rather than a partial return.

The Portfolio > History tab shows portfolio market value, current-holding cost value, and unrealised profit (market value minus current-holding cost) together on one chart with distinct line patterns and a shared rupee scale with a daily values table. Periods: 30 days, 90 days, one year, and all history. Purchases/sales affect the curves; these are absolute values, not investment-return indices. Realised profit is excluded.

## Daily snapshots

- `vercel.json` configures `/api/cron/portfolio-history` daily at `30 10 * * *` UTC (16:00 Asia/Kolkata).
- Vercel Hobby may invoke the job up to 59 minutes late. The user accepted an approximate 4 pm run. The schedule activates on production deployment.
- Vercel sends the production `CRON_SECRET` as a Bearer token. Missing configuration fails closed. Production was checked and already has this variable.
- The endpoint ignores calls before 4 pm IST. `?dry_run=1`, with valid authentication, returns schedule metadata without writing.
- Every account except the internal system account gets a row, including empty portfolios and weekends. Snapshot dates use India time.
- Values use saved shared Yahoo quotes. The existing refresh coordinator respects its weekday 09:00–15:30 IST window; this job does not initiate out-of-hours market refreshes.
- `portfolio_daily_history` stores market value, cost, profit, counts of missing/stale prices, oldest market timestamp, and actual recording time. Missing prices produce null market/profit values and chart gaps; old prices are flagged. Empty portfolios have zero value.
- Reading holdings and writing all users' snapshots is transactional. `(user_id,snapshot_date)` is unique; retries do not overwrite the day's saved holdings/valuation. A failed transaction can be retried.
- `GET /api/portfolio-history` requires login and returns only the authenticated user's saved rows. Deleting trades does not erase past snapshots; deleting an account cascades its history.
- History begins with the first successful scheduled run. Past dates are not fabricated or backfilled using today's holdings.

## Verification

Run `node --test tests/portfolio-history.test.js tests/sell-holdings.test.js tests/trade-yahoo-integration.test.js` and `node tests/portfolio-history-ui.cjs` with Playwright available. On runtimes that cannot spawn test workers use `--test-isolation=none`.

The UI test covers mobile/desktop layouts, chart data, arrows, keyboard tab traversal, and empty/error states. Data tests cover weighted daily change, missing quotes, multiple users, cron authentication, local dates, weekends, and retry immutability.
