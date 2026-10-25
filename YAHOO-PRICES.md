> Current behavior: the stock universe is managed in Admin → Stocks Config. Existing stocks are retained. No Google Sheets imports or network requests run. Login and optional cron refresh Yahoo quotes for saved stocks only.

# Yahoo Finance market data

The provider is adapted from `onepiece-yfinance/src/services/stockService.ts` using `yahoo-finance2` 4.0.5 and Node 22. No separate Python service or provider API key is required.

Google Sheets supplies the stock universe and company metadata. Admin CODE and Stock Code overrides still apply. Price, daily change, ATH and ATH date come only from Yahoo Finance. There is no fallback to Sheets market data.

Yahoo Finance Code conversion:

- `NSE:RELIANCE` → `RELIANCE.NS`
- `BOM:GRWRHITECH` or `BSE:GRWRHITECH` → `GRWRHITECH.BO`
- Numeric BSE codes are searched by company name, restricted to `.BO` with an exact name match after punctuation/company-suffix normalization. Unverified mappings remain errors. Admin can set the symbolic Yahoo Finance Code explicitly.
- Already suffixed `.NS`/`.BO` symbols are supported. Missing exchange identifiers are errors, not guesses.

All users share a 30-minute persistent cache in `yahoo_shared_quotes`, keyed by the resolved Yahoo ticker (for example RELIANCE.NS or GRWRHITECH.BO). Yahoo Finance Code aliases point to that shared key. Existing cache rows are migrated automatically. Expired quotes remain visibly stale until refreshed, with their original timestamp.

Login and restored signed-in sessions request a universe refresh. Signed-in sessions check every 30 minutes. A database lease deduplicates concurrent refreshes across users and server instances. Portfolio, Watchlist and Opportunities only read saved quotes; navigation never calls Yahoo. Refreshes use six workers with a request time budget; failed or deferred rows show an error. The optional cron uses the same shared refresh coordinator; deployment does not activate a scheduler.

ATH uses all available monthly highs, then daily candles in the peak month(s). Dates use Asia/Kolkata. If daily refinement fails, or history conflicts with the quoted 52-week high, ATH and its date are unavailable rather than being fabricated. Yahoo coverage, historical adjustments and missing candles determine the available history.


Each stock has an independent `yahoo_finance_code`, initially copied from its Stock Code. Admin → Stocks Config edits it separately. Existing values and future edits survive Sheets imports. All Yahoo quote, history, symbol resolution and cache reads use this field. New universe stocks receive their initial value from Stock Code.
