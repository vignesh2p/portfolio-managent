# Taxloss Harvesting

Menu → **Taxloss Harvesting** reads the signed-in user's saved `trade_history`, `portfolio`, and the shared cached market quotes automatically. No broker credentials or CSV ingestion are added. Admin → **Tax settings** changes the exemption, rates, holding period, price freshness and family review window for the current Indian financial year. Changes are audited; concurrent overwrites are rejected.

## Calculation and scope

- Full history is replayed FIFO; only sales in the current April–March financial year contribute realized gains. Each account/ticker is one FIFO pool. Separate demat-account FIFO pools are not represented in the current trade schema: review consolidated multi-demat records before relying on results.
- Listed delivery equity with the applicable STT conditions is assumed. This is not a tax-return calculator for intraday business income, derivatives, debt/gold ETFs, foreign/unlisted shares or other special assets. The user must verify that saved records fit this scope.
- Exactly 12 calendar months is short term; long term begins the following day. Defaults: ₹125,000 exemption, 12.5% LTCG, 20% STCG. Cess, surcharge, fees, basic-exemption adjustments, other income and brought-forward losses are excluded.
- LTCL reduces LTCG only. STCL reduces STCG first, then remaining LTCG. All candidate actions share a single remaining tax budget per taxpayer. Immediate savings and exemption use are separate amounts.
- Sell suggestions consume FIFO prefixes in sequence. The engine conservatively prioritizes LTCL, STCL, then LTCG gain harvest. It does not cherry-pick later lots, over-sell holdings, issue fractional shares, or claim mathematical global optimization. A later lot may remain inaccessible behind an older unsold lot. It rounds useful quantities down, so residual taxable gains smaller than a share's loss can remain.
- Missing purchase lots, invalid trades, holdings mismatches and pre-February-2018 acquisitions suppress account tax estimates and recommendations. Correct trades/corporate actions before recalculating. Missing/stale prices and fractional quantities suppress the affected security's recommendations. Quote freshness is configurable (default 96 hours to accommodate weekends).
- Sale timing is a trading day by March 31; exchange holidays are not predicted. Reinvestment is conditional, with settlement and costs considered; no orders are placed and no future price is guaranteed.
- Store all trades for a given taxpayer in one app account to avoid multiplying the exemption. The app does not identify PAN, aggregate outside income, or detect duplicated taxpayer identities automatically.

## Family privacy

A member generates a random, single-use, ten-minute sharing code from their own authenticated session and shares it privately. Redemption grants one-way tax read access; it does not expose passwords or grant trading access. Both recipient unlink and owner revocation are available. Blocked/deleted accounts are excluded at report generation. Sharing codes are stored only as hashes and consumed transactionally. Each linked account must represent a distinct taxpayer; balances and exemption caps are never pooled across people.

Family review flags matching holdings and recent purchases in linked records using the stock universe identity where available. Unlinked accounts, undisclosed transfers and future orders are not visible. This is a coordination flag, not an automatic loss disallowance or a US-style wash-sale rule. Do not arrange matched family trades.

## Endpoints

- `GET /api/tax-harvesting` — current user plus consented family accounts; no arbitrary user ID input.
- `GET /api/tax-harvesting/family`, `POST .../family/code`, `POST .../family/link`, `DELETE .../family/:direction/:id` — consent and revocation.
- `GET /api/admin/tax-settings`, `PUT /api/admin/tax-settings` — admin authenticated; full validated settings plus year and optimistic-lock timestamp.

New tables are initialized with the existing database migration. No changes to trades or holdings are made. No deployment environment variables are required. New years use the documented defaults until reviewed by an admin.

## Sources checked 30 October 2026

- [Income Tax Department — capital gains](https://www.incometaxindia.gov.in/w/capital-gain)
- [Income Tax Department — listed-equity LTCG exemption and rates](https://www.incometaxindia.gov.in/w/tax-on-long-term-capital-gains%E2%80%8B)
- [Income Tax Department — loss set-off](https://www.incometaxindia.gov.in/w/section-70-64)
- [Zerodha — Indian tax loss harvesting and US wash-sale distinction](https://support.zerodha.com/category/console/reports/taxation/articles/what-is-tax-loss-harvesting)

## Verification

Run `node --test tests/tax-harvesting.test.js tests/tax-harvesting-routes.test.js` with Node 22+. The browser test `tests/tax-harvesting-ui.cjs` uses Playwright and mocked app API responses; no live user data or production database is required.

Verified: 14 new calculation/access tests; desktop (1440px) and mobile (390px) browser checks for filters, sharing, empty/error states and admin save. The broader existing suite reported three unrelated failures: `user-access.test.js` still expects synchronous login price refresh, `watchlist-integration.test.js` calls the removed `/api/watchlist/:id/quote` endpoint, and `watchlist-ui.test.js` references the removed `syncWatchlistData` function. These paths were not changed by this feature.
