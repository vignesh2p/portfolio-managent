# Indian stock discovery

Authenticated GET /api/stocks/search?q=... uses yahoo-finance2 search (Yahoo /v1/finance/search), region IN, and filters .NS/.BO equity results. Queries include exchange hints; exact symbols also use quote lookup. Yahoo ranked search is not an exhaustive exchange master list, and classification/coverage depend on Yahoo. Search results are cached for 30 minutes in a bounded process cache.

Custom watchlist POST/PUT accepts discovered: ["RELIANCE.NS"], up to 30 new selections per save, alongside existing tickers. Quotes validate equities server-side; new universe rows and membership commit atomically. Repeated listings reuse existing mappings. Ownership, default protection and three-list limit remain enforced. Saved prices use the existing shared 30-minute Yahoo cache and refresh flow.

Discovered listings have generated exchange-qualified Stock Code and Yahoo Finance Code, blank admin CODE, and in_default_watchlist=0. Personal additions never overwrite admin mappings. As previously required, blank CODE stocks do not appear in Opportunities until an admin configures CODE.

Admin Add stock explicitly adds to Default watchlist and requires CODE, Stock Code and Yahoo Finance Code. To promote a discovered stock, save these fields in Stocks Config, then check Default watchlist. Inclusion validates saved identifiers server-side.

Verification: node tests/stock-discovery.test.js; node tests/named-watchlists.test.js; node tests/admin-universe.test.js; tests/stock-discovery-ui.cjs with PLAYWRIGHT_PATH. Live Yahoo search checked without database changes.

Watchlist search now shows local autocomplete suggestions first. With no local match, a 350ms debounce requests Yahoo suggestions; stale responses are ignored. Arrow keys, Enter and Escape support keyboard selection. Saving discoveries persists them in the shared universe for reuse by all users, while Default watchlist inclusion remains admin-controlled.
