# Shared price scheduler

Admins can use **Refresh all prices now** in the Admin console to fetch the
entire saved OnePiece universe immediately, including outside trading hours.
This bypasses the quote cache and runs sequential batches of 12 through
`POST /api/admin/prices/refresh` (admin authentication required). Keep the page
open until it finishes. The result lists updated and failed stocks; failed
quotes retain their last saved prices. The shared lease prevents overlapping
provider refreshes. This manual action does not activate the scheduled workflow.

GET /api/cron/watchlist refreshes Yahoo prices for the saved Admin stock universe.
It does not import or replace stocks. Authentication requires
Authorization: Bearer <CRON_SECRET>; never put the secret in a URL.

## Activate the included GitHub Actions workflow

.github/workflows/refresh-prices.yml calls the endpoint every 30 minutes on
weekdays, 09:00–15:30 Asia/Kolkata. The schedule runs outside Vercel; no Vercel
cron configuration or plan upgrade is required.

1. Set a strong CRON_SECRET in the application's deployment environment and redeploy.
2. Configure GitHub repository Actions secrets:
   - APP_BASE_URL: the HTTPS production origin, without a path.
   - CRON_SECRET: the same value configured in the deployment.
3. Merge/push the workflow to the repository's default branch and enable Actions.
4. Run Refresh shared prices manually during the trading window to verify it.

An authenticated ?dry_run=1 request checks authentication and schedule without
refreshing. Outside the trading window, manual runs skip safely. GitHub schedules
can be delayed; this is not an exact-time market feed. The handler skips weekends
and times outside the window, and deduplicates successful half-hour runs.
Public repositories may have schedules disabled after 60 days of inactivity;
see [GitHub schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
Failed runs can retry; abandoned run records become retryable after ten minutes.

Until deployment secrets are configured and the workflow is pushed, no scheduled
job is active. Signed-in browsers retain a non-blocking refresh fallback on
opening and every 30 minutes. Login never waits for prices, and dashboard API
requests never wait for this fallback. Reopening a tab reads updated saved data.
The shared refresh coordinator also enforces the same weekday IST window for
browser requests: outside it, no universe refresh starts and saved prices remain
available. A refresh already started in the closing minute may finish afterward.

An external scheduler can also call the same authenticated endpoint on the same
IST schedule. Allow at least 120 seconds and retry server errors. All callers
share the database-backed refresh lease and 30-minute quote cache.
