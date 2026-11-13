# Corporate actions

The Corporate Actions menu shows events for current holdings, starting at each holding's oldest BUY date. The first database initialization records an India-calendar rollout date. Events on or before that date are read-only history: existing holdings are assumed to already include those adjustments. Later eligible events remain pending until Apply, Ignore, or confirmation that the user already entered them manually. Merely viewing an event never clears the badge.

## Data coverage

Yahoo chart events supply reported split/reverse-split history, cached for six hours per symbol and fetched from the oldest buy date. Missing data and provider outages are shown explicitly. Yahoo may encode a bonus as a split, so the user must verify the type and ratio against the company announcement. This is not a complete exchange corporate-actions feed. Verified bonus, demerger and future announcements are entered through Admin → Corporate actions, using the holding's Yahoo Finance code. An admin entry replaces an unhandled provider event on the same symbol/date. Once handled by any user, that event cannot be replaced.

The badge refreshes every minute during an active session. Provider sync runs at login, when the page opens or refreshes, and every 30 minutes (subject to the six-hour data cache). Admin entries therefore reach active eligible users on the next minute refresh. No email or push delivery is configured.

## Applying an action

- Eligibility is the net BUY minus SELL quantity strictly before the ex-date; same-day buys do not qualify. Future actions are visible but cannot be applied before the ex-date.
- Split ratios mean new shares : old shares. Every earlier BUY and SELL quantity is multiplied by the ratio and its price divided by the ratio. Cash amounts remain unchanged, comments include Split or Reverse Split, and later trades are untouched. Scaling both historical buys and sales preserves the correct remaining entitlement and realized cash.
- Bonus ratios mean additional shares : held shares. A dated BUY trade with zero price, zero cash amount, and a Bonus comment is added for the eligible additional quantity.
- Demergers require security mapping and cost allocation terms beyond a share ratio. Users enter those trades and allocations manually, then select Already entered manually. Fractional entitlements similarly require manual reconciliation, including any cash-in-lieu.
- Holdings are rebuilt from trades within the same write transaction. Decisions are unique per user/action/holding. Stale previews, repeated requests, applying later events before unresolved earlier events, and adjustments inconsistent with later sales are rejected. The decision stores the preview and prior trade history for audit.

## Validation

`node --test --test-isolation=none tests/corporate-actions.test.js tests/bonus-trades.test.js tests/sell-holdings.test.js`

`node tests/corporate-actions-ui.cjs` (requires Playwright, optionally set `PLAYWRIGHT_PATH`). Browser tests use mocked API data and never alter real accounts.
