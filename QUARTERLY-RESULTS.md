# Stock Results Analysis

Results Analysis in the sidebar lists the signed-in user's held stocks as native
accordions, ordered by latest available reporting period. Announcement dates are
not inferred from quarter-end dates. Search and quick picks add temporary views
without changing the user's holdings or watchlists.

## API and storage

- `GET /api/results/portfolio`: current user's holdings mapped to Yahoo symbols.
- `GET /api/results/search?q=...`: NSE/BSE and US equity autocomplete.
- `GET /api/stock/:ticker/quarterly`: eight chronological fiscal quarter slots,
  twelve financial rows and their breakdowns, growth, TTM, provenance and coverage.

All endpoints require user authentication. The server creates
`quarterly_results_cache` automatically; it contains public financial statements,
not user portfolio data. Successful responses cache for six hours. Concurrent
requests for the same stock share one fetch. Older cached quarterly records are
retained to grow coverage over time. Failed refreshes can serve explicitly stale
data. The UI loads three portfolio stocks at a time. The refresh button reloads
the screen but respects the server cache.

## Data source and limitations

Uses yahoo-finance2 4.x `fundamentalsTimeSeries` with `type: 'quarterly'`,
`module: 'all'` and an initial three-year window (extra history enables YoY
comparisons). If fewer than eight usable quarters are returned, a five-year
quarterly request and annual statements are attempted. Exactly one missing fiscal
quarter can be derived, field by field, as annual total minus three quarters.
Derived cells are marked † and listed in CSV provenance. EPS is never derived by
annual subtraction because weighted share counts can differ between periods.

Yahoo does not guarantee eight reported quarters. Live checks for RELIANCE.NS and
AAPL returned only five usable reported quarters. More requested history does not
override provider retention. The table guarantees eight consecutive slots, but
unknown values remain unavailable, never estimated or zero-filled. A licensed
historical fundamentals source would be required to guarantee populated history.
Cash-flow inventory changes, balance-sheet inventory and minority equity are not
substituted for income-statement breakdowns. Yahoo may omit legitimate zero values;
omitted fields remain unknown. Breakdowns are partial disclosures, not a fabricated
reconciliation. Banks and insurers may use classifications unlike Screener.

Expenses are cost of revenue plus operating expenses when both are reported,
otherwise reported total expenses or revenue minus reported operating income.
Operating profit = sales minus expenses; OPM = operating profit / sales × 100;
tax rate = tax provision / PBT × 100. Zero denominators yield unavailable ratios.
Investment Returns maps to gains on securities, Forex to foreign-exchange trading
gains, and Misc Income to other non-operating income/expenses.

TTM is the sum of the latest four quarters, including diluted EPS as requested;
OPM and tax rates are arithmetic averages. A missing quarter/field suppresses its
TTM value. This EPS sum can differ from provider-calculated TTM EPS after share
count changes. Growth uses `(current - previous) / abs(previous) * 100`; missing
and zero prior values have no growth badge. Fiscal year-end offsets are preserved,
with near-month-end 52/53-week reporting dates normalized to their month slot.

Display defaults to INR crores or USD millions based on reporting currency. Other
currencies use raw numbers. Scaling never performs FX conversion and never scales
EPS or percentages. CSV uses the selected scale and includes all sub-rows even
when collapsed; missing cells remain blank.

Period-matched HTTPS filing links are accepted only from official NSE/BSE/SEC
hosts. Yahoo often omits both filing links and report-period mappings. In that
case, Raw PDF displays **Find filing**, opening official exchange/SEC search, not
an invented PDF URL. Available unassigned SEC filings appear in the definitions
section with their filing dates.

## Validation

`node --test tests/quarterly-results.test.js` covers calculations, fiscal periods,
backfill, missing data, TTM, caching, provider failure and search filtering.
`node tests/quarterly-results-ui.cjs` checks mobile/desktop rendering, keyboard
search, accordion breakdowns, growth controls, unit scaling and CSV download with
fixture data. Set `PLAYWRIGHT_PATH` if Playwright is outside local node_modules.
