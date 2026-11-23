# Admin database usage

Open **Admin → Database usage**. The admin-only `GET /api/admin/database-usage`
endpoint reports allocated database pages, reusable free pages, all application
table row counts, estimated data payload, and a searchable user breakdown.
Results are cached for five minutes and concurrent requests share one scan.
Opening this report scans stored data and therefore itself consumes database reads.

User ownership comes from `user_id`, the users table's `id`, watchlist membership
through `user_watchlists`, tax-family code subjects, and tax-family link viewers.
System-account records are separate from ordinary users. Other rows, including
unmatched owners, are shared/unassigned. A row is attributed once. Soft-deleted
accounts remain listed because their retained records still consume storage.

Per-user estimates sum text/blob byte lengths and eight bytes per numeric field.
They exclude indexes, row headers and free space; they are not billed storage.
Only aggregate lengths/counts and user identity fields are returned. Passwords,
tokens, reset codes and other record contents are never returned by this endpoint.

Free-plan references checked on 2026-11-14 at https://turso.tech/pricing:
5 GB storage, 500 million monthly rows read, 10 million monthly rows written,
3 GB monthly sync traffic and 100 databases. GB here uses decimal bytes. These
are organization-wide reference allowances, not a verified subscription or the
account's remaining quota. The report covers this database only.

Optional server-only environment variables enable actual Turso month-to-date
read/write, storage and sync metrics:

- `TURSO_PLATFORM_API_TOKEN`: Turso Platform API token, stored as a secret.
- `TURSO_ORGANIZATION`: organization or account slug.
- `TURSO_DATABASE_NAME`: the exact database backing this application.

The existing database auth token is not a Platform API token. Configure these
in the deployment environment and redeploy; never put tokens in browser code,
Git or chat. Without the connection, monthly counters show unavailable; measured
database storage and user data still work. Platform failures do not hide local
measurements. Monthly counters use a UTC calendar month and are not claimed to
match a different subscription billing cycle. Per-user historical read/write
usage cannot be reconstructed from stored rows and is explicitly not tracked.

API reference: https://docs.turso.tech/api-reference/databases/usage

Checks: `node --test tests/database-usage.test.js` and
`node tests/database-usage-ui.cjs` with `PLAYWRIGHT_PATH` configured.
