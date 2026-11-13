> Current behavior: the stock universe is managed in Admin → Stocks Config. Existing stocks are retained. No Google Sheets imports or network requests run. Login and optional cron refresh Yahoo quotes for saved stocks only.

# Watchlists and stock metadata

## Admin stock configuration

Stock configuration is managed under **Admin → Stocks Config** for the complete Sheets universe. User Settings contains SIP configuration only; the former `/api/settings/stocks` endpoints are removed.

`GET /api/admin/stock-config` returns the universe. `PUT /api/admin/stock-config/:ticker` accepts `code`, `stock_code`, `expected_code`, and `expected_stock_code` and requires an admin Bearer token. The expected values prevent overwriting another administrator's edits. Codes belonging to another stock are rejected.

Overrides are stored separately and reapplied transactionally after every Sheets refresh. The internal sheet ticker remains stable so existing holdings and watchlist memberships retain their identity; CODE and Stock Code are editable metadata. Portfolio opportunities use the universe CODE. The Stocks Config page supports search and CSV export.

Users have up to three named watchlists, including their Default watchlist. Existing accounts receive the previous full Google Sheets universe as their default. Until edited, that default follows the sheet universe. Saving its stock selection makes it a personal selection. The default can be renamed and edited but cannot be deleted.

All watchlist endpoints require the user's Bearer token. Only stocks in the Google Sheets universe may be selected.

- `GET /api/watchlists`: list the signed-in user's watchlists.
- `GET /api/stocks/universe`: all stocks available from the saved Sheets snapshot.
- `GET /api/watchlists/:id/stocks`: selected stocks and current saved prices.
- `POST /api/watchlists`: create a list with `{ "name": "Growth", "tickers": ["NSE:RELIANCE"] }`.
- `PUT /api/watchlists/:id`: replace the list's name and stock selections using the same body.
- `DELETE /api/watchlists/:id`: delete a non-default list.
- `GET /api/portfolio-opportunities?scope=watchlist&watchlist_id=123`: read shared cached quotes and calculate opportunities for the selected list.

## Unique stocks API

`GET /api/admin/stocks` is public and requires no authentication. It returns the union of current portfolio holdings and user watchlists across all accounts. Tickers are deduplicated with Sheets symbol mappings; no user identities, holdings quantities or trade data are returned. A default that still follows the complete universe includes all sheet stocks.

```json
{"success":true,"total":1,"data":[{"name":"Reliance Industries","ticker":"RELIANCE","stock_code":"NSE:RELIANCE","code":"example-code"}]}
```

## Admin leaderboard

The stocks API includes both the internal `ticker` and the full configured `stock_code`, preserving the exchange prefix when supplied by Sheets or Admin. If no stock code is available, it falls back to the existing ticker without guessing an exchange.

`GET /api/admin/leaderboard` requires an admin Bearer token. It reads the saved universe and shared Yahoo price cache, combines each user's BUY and SELL cash flows and adds current remaining portfolio value as the terminal cash flow. It ranks finite XIRRs in descending order, with equal XIRRs sharing ranks. Missing prices and insufficient cash flows remain visible without a rank. The internal system user is excluded. Rankings are estimates based on saved trades and Yahoo Finance prices; dividends and fees are included only if represented in the cash flows.


Stock details also include `yahoo_finance_code`, initially copied from `stock_code`. Admin stock-config updates accept this field plus `expected_yahoo_finance_code` for conflict protection. Yahoo lookups use this independent field; Stock Code remains the trading/export identifier.

Admin CRUD (admin Bearer token required):
- `POST /api/admin/stock-config`: `{code, stock_code, yahoo_finance_code}`; fetches Yahoo name, price, ATH and ATH date and saves the stock. Invalid symbols/provider failures do not add a stock. Missing ATH is reported via `quote_error`.
- `DELETE /api/admin/stock-config/:ticker`: removes the universe stock and watchlist memberships, retaining trades and portfolio holdings.
- `PUT /api/admin/stock-config/:ticker`: existing metadata edit endpoint.
