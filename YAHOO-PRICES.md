# Yahoo Finance market data

The stock universe is maintained in Admin → Stocks Config. Refreshes retain
existing stocks and fetch only their configured Yahoo Finance symbols.
No Google Sheets imports run. The provider uses yahoo-finance2 4.0.5.

The PE column uses Yahoo's trailing P/E (`trailingPE`) from the same quote
request. It is persisted in the shared quote cache and stock universe. Missing
or non-finite values remain null; forward P/E is not substituted. Older cache
entries gain PE during their next normal market-hours refresh.

All users share a persistent 30-minute quote cache, keyed by resolved Yahoo symbol.
NSE codes map to .NS; BOM/BSE codes map to .BO. Numeric BSE identifiers are
resolved only with exact normalized company names on the correct exchange.
Missing or ambiguous codes remain errors rather than guessed mappings.

Sign-in only authenticates. Portfolio, Watchlist and Opportunities read saved
quotes immediately. Browser refreshes run independently at low network priority
on session opening and every 30 minutes; no page API waits for them. Reopening
a tab reads newly saved prices. Portfolio status shows the oldest fetched time
and warns about stale or missing prices.

The included GitHub Actions scheduler refreshes the universe during weekday
trading hours; see WATCHLIST-SCHEDULER.md for activation and required secrets.
All refresh callers share a database lease and the same quote cache. Six workers
process stocks within a time budget. Failed or deferred updates retain saved data;
provider failures return last-known quotes with their original timestamps.

Historical ATH checks have a separate 24-hour lifetime stored as ath_fetched_at
inside the quote JSON. Existing cache rows without that field refresh history on
the next expired quote. A successful history check examines monthly highs and
refines the peak using daily candles, with dates in Asia/Kolkata. Between checks,
new observed daily highs update ATH without downloading history again. A quoted
52-week high inconsistent with saved ATH forces revalidation. Failed history
checks preserve a previous verified ATH with a warning; without one, ATH remains
unavailable. Failed checks remain due for retry at the next quote refresh.
