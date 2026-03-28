const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const axios = require("axios");

const app = express();
const db = new Database("portflow.db");

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// DATABASE SETUP
// ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS portfolio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    shares REAL NOT NULL,
    avg_price REAL NOT NULL,
    notes TEXT,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT UNIQUE NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sip_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    max_budget REAL NOT NULL DEFAULT 50000,
    levels TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('BUY','SELL')),
    shares REAL NOT NULL,
    price REAL NOT NULL,
    amount REAL NOT NULL,
    notes TEXT,
    traded_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default SIP config if empty
const sipRow = db.prepare("SELECT COUNT(*) as cnt FROM sip_config").get();
if (sipRow.cnt === 0) {
  db.prepare("INSERT INTO sip_config (max_budget, levels) VALUES (?, ?)").run(
    50000,
    JSON.stringify([
      { fall: -10, allocation: 10 },
      { fall: -15, allocation: 5  },
      { fall: -20, allocation: 20 },
      { fall: -25, allocation: 10 },
      { fall: -30, allocation: 30 },
      { fall: -35, allocation: 15 },
      { fall: -40, allocation: 10 },
    ])
  );
}

// ─────────────────────────────────────────
// STOCK PRICE — NSE/BSE
// ─────────────────────────────────────────

// In-memory cache: { TICKER: { price, ath, name, exchange, cachedAt } }
const priceCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchNSEPrice(ticker) {
  // Check cache
  const cached = priceCache[ticker];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

  // NSE India unofficial API (no auth required, rate-limited)
  const headers = {
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  };

  // Step 1: warm cookie
  await axios.get("https://www.nseindia.com", { headers, timeout: 8000 }).catch(() => {});

  // Step 2: fetch quote
  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(ticker)}`;
  const res = await axios.get(url, { headers, timeout: 8000 });

  const d = res.data;
  const info = d.info || {};
  const pd   = d.priceInfo || {};
  const wh52 = pd["52WeekHigh"] || pd.weekHigh52 || null;

  const result = {
    ticker,
    name:     info.companyName || ticker,
    exchange: "NSE",
    price:    pd.lastPrice || pd.close || 0,
    open:     pd.open || 0,
    high:     pd.intraDayHighLow?.max || 0,
    low:      pd.intraDayHighLow?.min || 0,
    prevClose:pd.previousClose || 0,
    change:   pd.change || 0,
    changePct:pd.pChange || 0,
    week52High: wh52,
    // ATH approximation: use 52-week high if no stored ATH
    ath:      wh52 || pd.lastPrice,
    cachedAt: Date.now(),
  };

  priceCache[ticker] = result;
  return result;
}

// ─────────────────────────────────────────
// ROUTES — STOCK PRICE
// ─────────────────────────────────────────

// GET /api/stock/:ticker
app.get("/api/stock/:ticker", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const data = await fetchNSEPrice(ticker);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stock/:ticker/sip — price + SIP analysis
app.get("/api/stock/:ticker/sip", async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase();
    const stock  = await fetchNSEPrice(ticker);
    const cfg    = db.prepare("SELECT * FROM sip_config ORDER BY id DESC LIMIT 1").get();
    const levels = JSON.parse(cfg.levels);
    const budget = cfg.max_budget;

    const fallPct = ((stock.price - stock.ath) / stock.ath) * 100;

    const analysis = levels.map(l => {
      const amount       = Math.round((l.allocation / 100) * budget);
      const triggerPrice = stock.ath * (1 + l.fall / 100);
      const triggered    = fallPct <= l.fall;
      return { ...l, amount, triggerPrice: Math.round(triggerPrice), triggered };
    });

    const triggered      = analysis.filter(a => a.triggered);
    const totalDeployable= triggered.reduce((s, a) => s + a.amount, 0);

    res.json({
      success: true,
      data: {
        stock,
        fallPct: +fallPct.toFixed(2),
        budget,
        analysis,
        triggered,
        totalDeployable,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// ROUTES — PORTFOLIO
// ─────────────────────────────────────────

// GET /api/portfolio
app.get("/api/portfolio", async (req, res) => {
  const holdings = db.prepare("SELECT * FROM portfolio ORDER BY added_at DESC").all();

  // Enrich with live prices
  const enriched = await Promise.all(
    holdings.map(async h => {
      try {
        const stock  = await fetchNSEPrice(h.ticker);
        const value  = stock.price * h.shares;
        const cost   = h.avg_price * h.shares;
        const pnl    = value - cost;
        const pnlPct = ((stock.price - h.avg_price) / h.avg_price) * 100;
        return { ...h, livePrice: stock.price, name: stock.name, value, cost, pnl, pnlPct: +pnlPct.toFixed(2) };
      } catch {
        return { ...h, livePrice: null, name: h.ticker };
      }
    })
  );

  const totalValue = enriched.reduce((s, h) => s + (h.value || 0), 0);
  const totalCost  = enriched.reduce((s, h) => s + (h.cost || 0), 0);

  res.json({
    success: true,
    data: {
      holdings: enriched,
      summary: {
        totalValue,
        totalCost,
        totalPnL: totalValue - totalCost,
        totalPnLPct: totalCost > 0 ? +((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0,
      },
    },
  });
});

// POST /api/portfolio
app.post("/api/portfolio", (req, res) => {
  const { ticker, shares, avg_price, notes } = req.body;
  if (!ticker || !shares || !avg_price)
    return res.status(400).json({ success: false, error: "ticker, shares, avg_price required" });

  const stmt = db.prepare(
    "INSERT INTO portfolio (ticker, shares, avg_price, notes) VALUES (?, ?, ?, ?)"
  );
  const result = stmt.run(ticker.toUpperCase(), shares, avg_price, notes || null);
  res.json({ success: true, id: result.lastInsertRowid });
});

// PUT /api/portfolio/:id
app.put("/api/portfolio/:id", (req, res) => {
  const { shares, avg_price, notes } = req.body;
  db.prepare("UPDATE portfolio SET shares=?, avg_price=?, notes=? WHERE id=?")
    .run(shares, avg_price, notes, req.params.id);
  res.json({ success: true });
});

// DELETE /api/portfolio/:id
app.delete("/api/portfolio/:id", (req, res) => {
  db.prepare("DELETE FROM portfolio WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────
// ROUTES — WATCHLIST
// ─────────────────────────────────────────

// GET /api/watchlist
app.get("/api/watchlist", async (req, res) => {
  const items = db.prepare("SELECT * FROM watchlist ORDER BY added_at DESC").all();
  const enriched = await Promise.all(
    items.map(async w => {
      try {
        const stock = await fetchNSEPrice(w.ticker);
        return { ...w, ...stock };
      } catch {
        return { ...w, price: null };
      }
    })
  );
  res.json({ success: true, data: enriched });
});

// POST /api/watchlist
app.post("/api/watchlist", (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ success: false, error: "ticker required" });
  try {
    db.prepare("INSERT OR IGNORE INTO watchlist (ticker) VALUES (?)").run(ticker.toUpperCase());
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// DELETE /api/watchlist/:ticker
app.delete("/api/watchlist/:ticker", (req, res) => {
  db.prepare("DELETE FROM watchlist WHERE ticker=?").run(req.params.ticker.toUpperCase());
  res.json({ success: true });
});

// ─────────────────────────────────────────
// ROUTES — SIP CONFIG
// ─────────────────────────────────────────

// GET /api/sip-config
app.get("/api/sip-config", (req, res) => {
  const cfg = db.prepare("SELECT * FROM sip_config ORDER BY id DESC LIMIT 1").get();
  res.json({ success: true, data: { ...cfg, levels: JSON.parse(cfg.levels) } });
});

// PUT /api/sip-config
app.put("/api/sip-config", (req, res) => {
  const { max_budget, levels } = req.body;
  if (!max_budget || !levels)
    return res.status(400).json({ success: false, error: "max_budget and levels required" });

  // Validate allocations sum to 100
  const total = levels.reduce((s, l) => s + l.allocation, 0);
  if (total !== 100)
    return res.status(400).json({ success: false, error: `Allocations must sum to 100, got ${total}` });

  db.prepare("INSERT INTO sip_config (max_budget, levels) VALUES (?, ?)").run(
    max_budget, JSON.stringify(levels)
  );
  res.json({ success: true });
});

// ─────────────────────────────────────────
// ROUTES — TRADE HISTORY
// ─────────────────────────────────────────

// GET /api/trades
app.get("/api/trades", (req, res) => {
  const { ticker, type, limit = 50 } = req.query;
  let query = "SELECT * FROM trade_history WHERE 1=1";
  const params = [];
  if (ticker) { query += " AND ticker=?"; params.push(ticker.toUpperCase()); }
  if (type)   { query += " AND type=?";   params.push(type.toUpperCase()); }
  query += " ORDER BY traded_at DESC LIMIT ?";
  params.push(Number(limit));
  const trades = db.prepare(query).all(...params);
  res.json({ success: true, data: trades });
});

// POST /api/trades
app.post("/api/trades", (req, res) => {
  const { ticker, type, shares, price, notes } = req.body;
  if (!ticker || !type || !shares || !price)
    return res.status(400).json({ success: false, error: "ticker, type, shares, price required" });

  const amount = shares * price;
  const result = db.prepare(
    "INSERT INTO trade_history (ticker, type, shares, price, amount, notes) VALUES (?,?,?,?,?,?)"
  ).run(ticker.toUpperCase(), type.toUpperCase(), shares, price, amount, notes || null);

  // Auto-update portfolio on BUY
  if (type.toUpperCase() === "BUY") {
    const existing = db.prepare("SELECT * FROM portfolio WHERE ticker=?").get(ticker.toUpperCase());
    if (existing) {
      const newShares   = existing.shares + shares;
      const newAvgPrice = ((existing.avg_price * existing.shares) + (price * shares)) / newShares;
      db.prepare("UPDATE portfolio SET shares=?, avg_price=? WHERE id=?")
        .run(newShares, +newAvgPrice.toFixed(2), existing.id);
    } else {
      db.prepare("INSERT INTO portfolio (ticker, shares, avg_price) VALUES (?,?,?)")
        .run(ticker.toUpperCase(), shares, price);
    }
  }

  // Auto-update portfolio on SELL
  if (type.toUpperCase() === "SELL") {
    const existing = db.prepare("SELECT * FROM portfolio WHERE ticker=?").get(ticker.toUpperCase());
    if (existing) {
      const newShares = existing.shares - shares;
      if (newShares <= 0) {
        db.prepare("DELETE FROM portfolio WHERE id=?").run(existing.id);
      } else {
        db.prepare("UPDATE portfolio SET shares=? WHERE id=?").run(newShares, existing.id);
      }
    }
  }

  res.json({ success: true, id: result.lastInsertRowid });
});

// DELETE /api/trades/:id
app.delete("/api/trades/:id", (req, res) => {
  db.prepare("DELETE FROM trade_history WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ success: true, status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PORTFLOW backend running on http://localhost:${PORT}`));
