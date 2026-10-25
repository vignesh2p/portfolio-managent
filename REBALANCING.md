# Rebalancing

Portfolio > Rebalancing options shows positive holdings with a valid Yahoo ATH date strictly more than 365 India calendar days ago. Missing and future dates are excluded.

Proposals use the remaining holding's cost basis (shares Ã— average price). Candidate stocks come from the user's portfolio, default watchlist and custom watchlists. They must have CODE, Stock Code, valid cached Yahoo price/ATH and a current active configured SIP zone with positive allocation. The source stock is excluded. Zone boundaries match Opportunities, including the deepest zone.

Single-stock, two-stock and three-stock alternatives include same-zone and mixed-zone combinations. Within an alternative, the full sale market value is split in proportion to each target's SIP allocation percentage. Every affordable single-stock replacement is listed, grouped by SIP level and ordered by ascending days since ATH (missing dates last). Users may combine any 1–10 listed stocks. Additional multi-stock suggestions are bounded (up to three same-zone pairs/triples per level plus mixed-zone suggestions), not an exhaustive search. Missing market prices yield no recommendations. Whole-share rounding leaves some cash unallocated. Per-stock budget overrides do not cap these rebalance proposals because this flow reallocates the sale market value using SIP percentage weights.

Users edit sale quantity/price, each buy quantity/price, and date, then review before confirming. Buy totals cannot exceed sale proceeds. Fees are excluded. A rebalance only records trades in Onepiece; it does not place orders with a broker.

GET /api/rebalancing lists eligible holdings. Add ?ticker=... for proposals. POST /api/rebalancing records an authenticated user's batch with request_id, date, sell and buys. Server validation rechecks source eligibility, target opportunities, account ownership, quantities, proceeds and trade chronology. Dates must be on or after all affected stocks' latest trade dates. Sale, purchases, holding updates and the idempotency record commit in one database transaction. Repeating an identical request_id is safe; a changed payload with an already-used identifier is rejected.

Checks: tests/rebalancing.test.js (local SQLite, rollback, account isolation, duplicate submission, thresholds and weights); tests/rebalancing-ui.cjs (mock API only, responsive review, overspend prevention, explicit confirmation and cancel).
