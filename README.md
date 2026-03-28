# PORTFLOW Backend — Setup & API Reference

## Tech Stack
- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite (via better-sqlite3 — zero config, file-based)
- **Stock Data**: NSE India unofficial API (free, no key needed)
- **Cache**: In-memory, 5-minute TTL per ticker

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. (Optional) Dev mode with auto-restart
npm run dev
```

Server runs at: `http://localhost:3001`

---

## API Reference

### Health Check
```
GET /api/health
```

---

### Stock Price

#### Get live price for a stock
```
GET /api/stock/:ticker
```
Example: `GET /api/stock/RELIANCE`

Response:
```json
{
  "success": true,
  "data": {
    "ticker": "RELIANCE",
    "name": "Reliance Industries Ltd",
    "exchange": "NSE",
    "price": 2480.50,
    "open": 2460.00,
    "high": 2495.00,
    "low": 2455.00,
    "prevClose": 2465.00,
    "change": 15.50,
    "changePct": 0.63,
    "week52High": 3217.00,
    "ath": 3217.00
  }
}
```

#### Get SIP analysis for a stock
```
GET /api/stock/:ticker/sip
```
Example: `GET /api/stock/WIPRO/sip`

Response:
```json
{
  "success": true,
  "data": {
    "stock": { "ticker": "WIPRO", "price": 462, "ath": 740, ... },
    "fallPct": -37.57,
    "budget": 50000,
    "analysis": [
      { "fall": -10, "allocation": 10, "amount": 5000, "triggerPrice": 666, "triggered": true },
      { "fall": -15, "allocation": 5,  "amount": 2500, "triggerPrice": 629, "triggered": true },
      ...
    ],
    "triggered": [...],
    "totalDeployable": 45000
  }
}
```

---

### Portfolio

#### Get all holdings (with live P&L)
```
GET /api/portfolio
```

#### Add a holding
```
POST /api/portfolio
Body: { "ticker": "RELIANCE", "shares": 10, "avg_price": 2300, "notes": "optional" }
```

#### Update a holding
```
PUT /api/portfolio/:id
Body: { "shares": 12, "avg_price": 2350, "notes": "updated" }
```

#### Delete a holding
```
DELETE /api/portfolio/:id
```

---

### Watchlist

#### Get watchlist (with live prices)
```
GET /api/watchlist
```

#### Add to watchlist
```
POST /api/watchlist
Body: { "ticker": "INFY" }
```

#### Remove from watchlist
```
DELETE /api/watchlist/:ticker
```

---

### SIP Config

#### Get current SIP config
```
GET /api/sip-config
```

#### Update SIP config (allocations must sum to 100)
```
PUT /api/sip-config
Body: {
  "max_budget": 75000,
  "levels": [
    { "fall": -10, "allocation": 10 },
    { "fall": -15, "allocation": 5  },
    { "fall": -20, "allocation": 20 },
    { "fall": -25, "allocation": 10 },
    { "fall": -30, "allocation": 30 },
    { "fall": -35, "allocation": 15 },
    { "fall": -40, "allocation": 10 }
  ]
}
```

---

### Trade History

#### Get trades (optional filters)
```
GET /api/trades?ticker=RELIANCE&type=BUY&limit=50
```

#### Log a trade (auto-updates portfolio)
```
POST /api/trades
Body: { "ticker": "TCS", "type": "BUY", "shares": 5, "price": 3800, "notes": "optional" }
```
- BUY → adds/updates portfolio holding automatically
- SELL → reduces shares in portfolio automatically

#### Delete a trade log
```
DELETE /api/trades/:id
```

---

## Connect to the Frontend

In your `portflow.html`, replace the mock `STOCKS` object with API calls:

```js
const BASE_URL = "http://localhost:3001";

// Fetch live SIP analysis
async function searchStock() {
  const ticker = document.getElementById('ticker-input').value.trim().toUpperCase();
  const res = await fetch(`${BASE_URL}/api/stock/${ticker}/sip`);
  const json = await res.json();
  if (json.success) renderSIPResult(json.data);
}

// Fetch portfolio
async function loadPortfolio() {
  const res = await fetch(`${BASE_URL}/api/portfolio`);
  const json = await res.json();
  renderPortfolio(json.data);
}
```

---

## Deploy to Railway (Free)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set `PORT` env variable to `3001`
4. Done — you get a live HTTPS URL like `https://portflow.railway.app`

Update `BASE_URL` in your frontend HTML to point to the Railway URL.

---

## Notes on NSE Data

- NSE India's API is **unofficial** — it works but can occasionally block IPs or change structure
- Prices are cached for **5 minutes** per ticker to avoid rate limiting
- 52-week high is used as ATH approximation (NSE doesn't expose all-time highs via public API)
- For true ATH, you can manually store it per ticker in the DB or use a paid data provider
