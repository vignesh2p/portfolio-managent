# Stock quote API

`GET /api/stock-quote?code=BOM%3A504605`

Accepts `BOM:504605`, `BSE:504605` (normalized to BOM), and `NSE:RELIANCE`.
This endpoint is prepared locally; configure and deploy it before using a hosted URL.

## Configuration

Set `FIRECRAWL_API_KEY` and `STOCK_QUOTE_API_KEY` in the hosting environment (see
`stock-quote.env.example`), then redeploy the existing Express app. Existing Turso
configuration is still required by the app. Environment files are not automatically
loaded by `npm start`. Never put either key in browser code; call from your application's backend.

Configure the host's request duration to allow at least 120 seconds. A cold lookup can
make three sequential provider calls with 35-second limits. No new npm dependency is required.

```javascript
const response = await fetch(
  `${process.env.QUOTE_API_BASE_URL}/api/stock-quote?code=${encodeURIComponent('BOM:504605')}`,
  { headers: { 'X-API-Key': process.env.STOCK_QUOTE_API_KEY } }
);
const quote = await response.json();
if (!response.ok) throw new Error(quote.error.message);
console.log(quote.price, quote.ath, quote.ath_date);
```

Example response (illustrative values, not a live quote):

```json
{
  "success": true,
  "stock_code": "BOM:504605",
  "name": "Uni-Abex Alloy Products Ltd",
  "price": 4895,
  "price_as_of": "Sep 22, 3:30:00 PM UTC+5:30 · INR",
  "ath": 5750,
  "ath_date": "2026-07-07",
  "currency": "INR",
  "fetched_at": "2026-09-22T12:00:00.000Z",
  "cached": false,
  "sources": {
    "price": "https://www.google.com/finance/quote/504605:BOM?hl=en",
    "ath": "https://www.tradingview.com/symbols/BSE-UNIABEXAL/"
  }
}
```

Google Finance supplies the displayed price and its original timestamp text.
`fetched_at` is retrieval time, not the exchange quote time; displayed quotes may be delayed.
TradingView supplies its reported all-time high and date, with its own historical
coverage and adjustment conventions. This is not a computed maximum from Google’s chart.
The standalone quote endpoint never substitutes the 52-week high for ATH. BSE symbol discovery uses Firecrawl
search; the scraped company name must match before any ATH is returned.

Successful results are cached for one hour in each process. Concurrent requests
for the same code share a lookup; up to four distinct lookups run per process. These
limits and the 500-entry cache are not shared across serverless instances. Each cold
BSE lookup uses two scrapes and one search, consuming your Firecrawl credits.
For high-volume use, add a shared cache and gateway rate limit.

Errors return `success: false` with `error.code` and `error.message`:

| HTTP | Meaning |
| --- | --- |
| 400 | Missing or invalid code |
| 401 | Missing or invalid application key |
| 429 | Per-process lookup capacity reached; retry after five seconds |
| 502 | Provider failure, unknown stock, ambiguous symbol, missing fields, mismatched company, or conflicting source values |
| 503 | Required environment key missing |

The endpoint fails rather than guessing when either source cannot be verified.
Scraping layouts can change; this is not an exchange-guaranteed market data feed.

## Watchlist updates

The Watchlist's **Update ONEPIECE** button first calls the existing authenticated
`POST /api/watchlist/sync` to load all stocks from the sheet. It then calls
`POST /api/watchlist/:id/quote` for every row, one at a time to support low-concurrency plans.
Rate-limited requests respect the provider's retry delay and retry up to twice.
Each call resolves the row's stock code on the server, uses the shared Firecrawl quote
service, and saves `cmp`, `ath`, `ath_date`, `price_as_of`, and `quote_fetched_at` in Turso.
The watchlist routes use the existing login token; no provider or application API key
is exposed to the browser. `FIRECRAWL_API_KEY` must be configured before sync starts.

Successful watchlist quotes are also cached in the database for one hour from their
original `quote_fetched_at`, so reloading the sheet or restarting a serverless instance
does not force fresh lookups. Sheet reloads preserve earlier verified quotes for the
same stock. Lookup failures retain those values and save a `quote_error`. A newly
imported stock uses its sheet CMP and 52-week high as the watchlist ATH, as configured
for this application. Its ATH date stays blank until a verified lookup succeeds. Changing
the stock code does not carry another instrument's quote across.

The UI shows completion counts and individual errors. Keep the page open until all
requests finish. Closing it may leave a partial update; the next click safely reuses
completed quotes. If another sync replaces a row while a lookup is running, the
outdated request fails with 409 rather than updating a replacement row.
The old `week52_high` database field remains for compatibility with sheet imports,
and sheet imports map it into `ath`. A previously verified Firecrawl quote takes precedence;
successful quote refreshes replace the sheet-derived ATH and supply its date.
SIP uses the saved watchlist ATH, including the sheet-derived value when applicable.

On server startup, existing databases receive the new nullable columns automatically.
Existing rows receive the sheet-derived ATH on the next sheet import if they do not
already have a verified Firecrawl quote.

Run verification with Node 20 or newer: `node --test tests/stock-quote-api.test.js`.
Provider contracts: https://docs.firecrawl.dev/api-reference/endpoint/scrape and
https://docs.firecrawl.dev/api-reference/endpoint/search.
