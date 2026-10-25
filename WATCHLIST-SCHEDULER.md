> Current behavior: the stock universe is managed in Admin → Stocks Config. Existing stocks are retained. No Google Sheets imports or network requests run. Login and optional cron refresh Yahoo quotes for saved stocks only.

# Watchlist scheduler

The protected handler is `GET /api/cron/watchlist`.
It imports the stock universe and refreshes expired Yahoo prices through the shared 30-minute cache.
It requires `Authorization: Bearer <CRON_SECRET>`. Store this in the scheduler's
secret/header settings, never in a URL or source control.

Requested schedule: Asia/Kolkata, Monday–Friday, every 30 minutes from 09:00
through 15:30 inclusive (14 runs per weekday). This includes weekday holidays.

## Activation

The current Vercel Hobby plan cannot run this schedule. The handler alone does
not schedule anything. Choose an external hosted scheduler or upgrade to Pro
before activating. Do not add sub-daily crons to the Hobby deployment.

For an external scheduler, select Asia/Kolkata with weekdays Monday–Friday,
hours 9 through 15 and minutes 0 and 30. Use GET, the authorization header above,
and a timeout of at least 120 seconds. Configure retries on server errors.

For Vercel Pro, add these entries to the `crons` array in `vercel.json` and deploy:

```json
[
  {"path":"/api/cron/watchlist","schedule":"30 3-9 * * 1-5"},
  {"path":"/api/cron/watchlist","schedule":"0 4-10 * * 1-5"}
]
```

Vercel expressions are UTC. Its scheduler supplies the CRON_SECRET bearer header.
An authenticated `?dry_run=1` request checks configuration without importing.
Unauthorized requests return 401; a missing secret returns 503.

The handler skips weekends and requests outside 09:00–15:30 IST. A database
record prevents duplicate successful runs in the same half-hour interval.
Failed runs can retry; abandoned runs become retryable after ten minutes.
An empty or invalid sheet never replaces the saved watchlist. The database
replacement is transactional. `watchlist_sync_runs` retains 30 days of run status.

Opening Watchlist or Opportunities reads the shared cached prices. Login and restored signed-in sessions trigger a universe refresh when due, with checks every 30 minutes while signed in. The optional scheduler remains unactivated pending a hosting choice.
