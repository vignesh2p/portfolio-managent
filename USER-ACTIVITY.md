# User activity history

Admin > User activity shows weekly active users, estimated active minutes, and user histories across 4, 12, 26 or 52 weeks. Clicking a week selects its per-user activity. Choosing a user shows their weekly time history. All-time active weeks/days/minutes and first/last activity remain available regardless of the selected range. Soft-deleted users' existing history is retained. Weeks run Monday–Sunday in Asia/Kolkata.

Activity begins only after deployment; no historical sessions are inferred from logins or trade dates. The migration stores a tracking-start timestamp. The initial weekly chart can therefore contain zeros before that date.

The signed-in client samples while the page is visible, focused and interacted with within the last 60 seconds. Trusted pointer, keyboard, wheel and touch interactions renew this window. Sampling runs every 30 seconds and on interactions. Hidden/idle pages do not send heartbeats. Visibility timeline entries are used when supported; Page Visibility and focus checks work without that API.

POST /api/activity/heartbeat requires approved-user authentication and records the authenticated user ID using server time. It accepts no identity, duration or timestamp from the client. One minute bucket per user is counted across all devices/tabs/retries. Counts are approximate engaged-minute buckets, not exact session duration. A few seconds spanning minute boundaries can count as two buckets. Heartbeat failures do not interrupt the app.

Daily totals persist in user_activity_days. user_activity_state deduplicates minute buckets atomically. No browsing URLs, input content, IP addresses or third-party analytics are stored by this feature. GET /api/admin/activity?weeks=12 is admin-only and aggregates retained daily history.

Tests: tests/user-activity.test.js (SQLite deduplication, India midnight/week boundaries, histories, auth routing and client idle/hidden checks); tests/admin-activity-ui.cjs (charts, week selection, per-user drill-down, responsive screens).
