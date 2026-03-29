const express  = require("express");
const cors     = require("cors");
const Database = require("better-sqlite3");
const axios    = require("axios");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const multer   = require("multer");
const XLSX     = require("xlsx");
const path     = require("path");

const app = express();
const db  = new Database("portflow.db");

const JWT_SECRET = process.env.JWT_SECRET || "portflow_secret_change_in_prod";

// multer — memory storage (no disk writes needed)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// DATABASE SETUP
// ─────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    UNIQUE NOT NULL,
    password   TEXT    NOT NULL,
    name       TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS portfolio (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    ticker     TEXT    NOT NULL,
    shares     REAL    NOT NULL,
    avg_price  REAL    NOT NULL,
    notes      TEXT,
    added_at   TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, ticker)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    ticker     TEXT    NOT NULL,
    added_at   TEXT    DEFAULT (datetime('now')),
    UNIQUE(user_id, ticker)
  );

  CREATE TABLE IF NOT EXISTS sip_config (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    max_budget REAL    NOT NULL DEFAULT 50000,
    levels     TEXT    NOT NULL,
    updated_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trade_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    ticker     TEXT    NOT NULL,
    type       TEXT    NOT NULL CHECK(type IN ('BUY','SELL')),
    shares     REAL    NOT NULL,
    price      REAL    NOT NULL,
    amount     REAL    NOT NULL,
    notes      TEXT,
    traded_at  TEXT    DEFAULT (datetime('now'))
  );
`);

// ─────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: "No token provided" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

// Helper: get or seed default SIP config per user
function getOrSeedSIP(userId) {
  let cfg = db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
  if (!cfg) {
    db.prepare("INSERT INTO sip_config (user_id, max_budget, levels) VALUES (?,?,?)").run(
      userId, 50000,
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
    cfg = db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
  }
  return cfg;
}

// ─────────────────────────────────────────
// XIRR ENGINE
// ─────────────────────────────────────────
function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const sorted  = [...cashflows].sort((a, b) => a.date - b.date);
  const t0      = sorted[0].date;
  const days    = sorted.map(c => (c.date - t0) / 86400000);
  const amounts = sorted.map(c => c.amount);

  // Guard: all cashflows same sign → no solution
  if (!amounts.some(a => a < 0) || !amounts.some(a => a > 0)) return null;

  const npv  = r => amounts.reduce((s, cf, i) => s + cf / Math.pow(1 + r, days[i] / 365), 0);
  const dnpv = r => amounts.reduce((s, cf, i) => s - (days[i] / 365) * cf / Math.pow(1 + r, days[i] / 365 + 1), 0);

  // Newton-Raphson
  let r = 0.1;
  for (let i = 0; i < 300; i++) {
    const f = npv(r), df = dnpv(r);
    if (Math.abs(df) < 1e-14) break;
    const rn = r - f / df;
    if (Math.abs(rn - r) < 1e-10) return +((rn * 100).toFixed(2));
    r = rn < -0.9999 ? -0.9999 : rn > 100 ? 100 : rn;
  }

  // Bisection fallback
  let lo = -0.9999, hi = 10;
  const nlo = npv(lo), nhi = npv(hi);
  if (nlo * nhi > 0) return null;
  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(hi - lo) < 1e-10) return +((mid * 100).toFixed(2));
    npv(mid) * npv(lo) < 0 ? (hi = mid) : (lo = mid);
  }
  return null;
}

function computeXIRR(trades, livePrice) {
  if (!trades?.length) return null;

  // Build cashflows — BUY is outflow (negative), SELL is inflow (positive)
  const cashflows = trades.map(t => ({
    amount: t.type === "BUY" ? -Math.abs(t.amount) : +Math.abs(t.amount),
    date:   new Date(t.traded_at),
  }));

  // Remaining shares valued at today's market price → terminal inflow
  const rem = trades.reduce((s, t) => s + (t.type === "BUY" ? t.shares : -t.shares), 0);
  if (rem > 0.0001 && livePrice > 0) {
    cashflows.push({ amount: rem * livePrice, date: new Date() });
  }

  return xirr(cashflows);
}

// ─────────────────────────────────────────
// EXCEL IMPORT PARSER
// Handles the broker statement format:
//   Sections: "Scrips Bought" / "Scrips Sold"
//   Bought columns: Stock | Pur. Qty | Pur. Date | Pur. Price | ...
//   Sold columns:   Stock | Pur. Price | Pur. Date | Sell Qty | Sell Price | Sell Date | ...
//
// Ticker extraction: "CG Power  (NSE)" → "CG POWER" cleaned, and we extract just the symbol
// We store as the raw stock name cleaned up, since these are broker statement names not NSE tickers
// ─────────────────────────────────────────
function parseExcelTrades(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const wb  = XLSX.read(buffer, {
    type: "buffer",
    cellDates: true,
    // For .xls (BIFF8) and .xlsx both
  });

  const ws      = wb.Sheets[wb.SheetNames[0]];
  const rows    = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });

  const trades  = [];
  const errors  = [];
  let   section = null; // "BUY" | "SELL"

  // Helper: extract clean ticker from names like "CG Power  (NSE)" or "KPIL - (NSE)"
  function cleanTicker(raw) {
    if (!raw) return null;
    // Remove exchange suffix like "(NSE)", "- (NSE)", "(BSE)" etc.
    let t = String(raw)
      .replace(/\s*[-–]\s*\((?:NSE|BSE|NFO|MCX)\)\s*$/i, "")
      .replace(/\s*\((?:NSE|BSE|NFO|MCX)\)\s*$/i, "")
      .trim()
      .toUpperCase();
    // Remove special chars except space and &
    t = t.replace(/[^A-Z0-9 &]/g, "").trim();
    // Collapse spaces
    t = t.replace(/\s+/g, " ").trim();
    return t || null;
  }

  // Helper: parse dates in multiple formats
  function parseDate(val) {
    if (!val) return null;
    const s = String(val).trim();
    // DD-MM-YYYY
    const m1 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m1) return new Date(`${m1[3]}-${m1[2].padStart(2,"0")}-${m1[1].padStart(2,"0")}T12:00:00`);
    // DD/MM/YYYY
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m2) return new Date(`${m2[3]}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}T12:00:00`);
    // YYYY-MM-DD
    const m3 = s.match(/^\d{4}-\d{2}-\d{2}/);
    if (m3) return new Date(s);
    // JS Date object passed through xlsx cellDates
    const d = new Date(val);
    if (!isNaN(d)) return d;
    return null;
  }

  function toNum(v) {
    const n = parseFloat(String(v).replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const first = String(row[0] || "").trim();

    // Detect section headers
    if (/scrips\s+bought/i.test(first))  { section = "BUY";  continue; }
    if (/scrips\s+sold/i.test(first))    { section = "SELL"; continue; }
    // Reset section on new major sections
    if (/mutual funds|ulip|e-series|financial year|profit\/loss/i.test(first) && !row[1]) { section = null; continue; }

    // Skip header rows and empty rows
    if (!section) continue;
    if (!first || /^stock$/i.test(first) || /^no\s/i.test(first)) continue;

    try {
      if (section === "BUY") {
        // Stock | Pur. Qty | Pur. Date | Pur. Price | Latest Price | Latest Value | Broker
        const ticker = cleanTicker(row[0]);
        const qty    = toNum(row[1]);
        const date   = parseDate(row[2]);
        const price  = toNum(row[3]);

        if (!ticker) { errors.push(`Row ${i+1}: Missing stock name`); continue; }
        if (!qty || qty <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid quantity "${row[1]}"`); continue; }
        if (!date || isNaN(date)) { errors.push(`Row ${i+1} [${ticker}]: Invalid date "${row[2]}"`); continue; }
        if (!price || price <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid price "${row[3]}"`); continue; }

        trades.push({
          ticker,
          type:      "BUY",
          shares:    qty,
          price,
          amount:    qty * price,
          traded_at: date.toISOString(),
          notes:     `Imported from broker statement`,
        });

      } else if (section === "SELL") {
        // Stock | Pur. Price | Pur. Date | Sell Qty | Sell Price | Sell Date | Profit | Broker
        const ticker    = cleanTicker(row[0]);
        const purPrice  = toNum(row[1]);
        const purDate   = parseDate(row[2]);
        const sellQty   = toNum(row[3]);
        const sellPrice = toNum(row[4]);
        const sellDate  = parseDate(row[5]);

        if (!ticker) { errors.push(`Row ${i+1}: Missing stock name`); continue; }
        if (!sellQty || sellQty <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid sell qty "${row[3]}"`); continue; }
        if (!sellPrice || sellPrice <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid sell price "${row[4]}"`); continue; }

        // Insert the original BUY (from purchase history in sold section)
        if (purPrice && purPrice > 0 && purDate && !isNaN(purDate)) {
          trades.push({
            ticker,
            type:      "BUY",
            shares:    sellQty,
            price:     purPrice,
            amount:    sellQty * purPrice,
            traded_at: purDate.toISOString(),
            notes:     `Imported (original buy for sold lot)`,
          });
        }

        // Insert the SELL
        const sd = sellDate && !isNaN(sellDate) ? sellDate : new Date();
        trades.push({
          ticker,
          type:      "SELL",
          shares:    sellQty,
          price:     sellPrice,
          amount:    sellQty * sellPrice,
          traded_at: sd.toISOString(),
          notes:     `Imported from broker statement`,
        });
      }
    } catch (err) {
      errors.push(`Row ${i+1}: ${err.message}`);
    }
  }

  return { trades, errors };
}

// ─────────────────────────────────────────
// NSE PRICE CACHE
// ─────────────────────────────────────────
const priceCache = {};
const CACHE_TTL  = 5 * 60 * 1000;
let nseSession = null, nseLastWarm = 0;

async function warmNSE() {
  if (Date.now() - nseLastWarm < 10 * 60 * 1000) return;
  const r = await axios.get("https://www.nseindia.com", {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/120" }, timeout: 8000,
  }).catch(() => null);
  if (r) { nseSession = (r.headers["set-cookie"] || []).join("; "); nseLastWarm = Date.now(); }
}

async function fetchNSEPrice(ticker) {
  const cached = priceCache[ticker];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached;
  await warmNSE();
  const headers = {
    "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    ...(nseSession ? { Cookie: nseSession } : {}),
  };
  const res  = await axios.get(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(ticker)}`, { headers, timeout: 8000 });
  const d    = res.data;
  const info = d.info      || {};
  const pd   = d.priceInfo || {};
  const wh52 = pd["52WeekHigh"] || pd.weekHigh52 || null;
  const result = {
    ticker, name: info.companyName || ticker, exchange: "NSE",
    price: pd.lastPrice || pd.close || 0, open: pd.open || 0,
    high: pd.intraDayHighLow?.max || 0, low: pd.intraDayHighLow?.min || 0,
    prevClose: pd.previousClose || 0, change: pd.change || 0, changePct: pd.pChange || 0,
    week52High: wh52, ath: wh52 || pd.lastPrice, cachedAt: Date.now(),
  };
  priceCache[ticker] = result;
  return result;
}

// ─────────────────────────────────────────
// ROUTES — AUTH
// ─────────────────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "email and password required" });
  if (password.length < 6)  return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  const exists = db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase());
  if (exists) return res.status(400).json({ success: false, error: "Email already registered" });
  const hashed = await bcrypt.hash(password, 10);
  const result = db.prepare("INSERT INTO users (email, password, name) VALUES (?,?,?)").run(
    email.toLowerCase(), hashed, name || email.split("@")[0]
  );
  const token = jwt.sign({ id: result.lastInsertRowid, email: email.toLowerCase() }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ success: true, token, user: { id: result.lastInsertRowid, email: email.toLowerCase(), name: name || email.split("@")[0] } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: "email and password required" });
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user) return res.status(401).json({ success: false, error: "Invalid email or password" });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ success: false, error: "Invalid email or password" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ success: true, token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, created_at FROM users WHERE id=?").get(req.user.id);
  res.json({ success: true, user });
});

// ─────────────────────────────────────────
// ROUTES — STOCK PRICE
// ─────────────────────────────────────────
app.get("/api/stock/:ticker", async (req, res) => {
  try {
    res.json({ success: true, data: await fetchNSEPrice(req.params.ticker.toUpperCase()) });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/stock/:ticker/sip", auth, async (req, res) => {
  try {
    const ticker  = req.params.ticker.toUpperCase();
    const stock   = await fetchNSEPrice(ticker);
    const cfg     = getOrSeedSIP(req.user.id);
    const levels  = JSON.parse(cfg.levels);
    const budget  = cfg.max_budget;
    const fallPct = ((stock.price - stock.ath) / stock.ath) * 100;
    const analysis = levels.map(l => {
      const amount       = Math.round((l.allocation / 100) * budget);
      const triggerPrice = Math.round(stock.ath * (1 + l.fall / 100));
      return { ...l, amount, triggerPrice, triggered: fallPct <= l.fall };
    });
    const triggered       = analysis.filter(a => a.triggered);
    const totalDeployable = triggered.reduce((s, a) => s + a.amount, 0);
    res.json({ success: true, data: { stock, fallPct: +fallPct.toFixed(2), budget, analysis, triggered, totalDeployable } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────
// ROUTES — PORTFOLIO
// ─────────────────────────────────────────
app.get("/api/portfolio", auth, async (req, res) => {
  const uid      = req.user.id;
  const holdings = db.prepare("SELECT * FROM portfolio WHERE user_id=? ORDER BY added_at DESC").all(uid);
  const enriched = await Promise.all(holdings.map(async h => {
    try {
      const stock   = await fetchNSEPrice(h.ticker);
      const value   = stock.price * h.shares;
      const cost    = h.avg_price * h.shares;
      const pnl     = value - cost;
      const pnlPct  = cost > 0 ? ((stock.price - h.avg_price) / h.avg_price) * 100 : 0;
      const trades  = db.prepare("SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC").all(uid, h.ticker);
      const xirrPct = computeXIRR(trades, stock.price);
      return { ...h, livePrice: stock.price, name: stock.name, changePct: stock.changePct, change: stock.change, value, cost, pnl, pnlPct: +pnlPct.toFixed(2), xirrPct };
    } catch { return { ...h, livePrice: null, name: h.ticker, xirrPct: null }; }
  }));
  const totalValue = enriched.reduce((s, h) => s + (h.value || 0), 0);
  const totalCost  = enriched.reduce((s, h) => s + (h.cost  || 0), 0);
  res.json({ success: true, data: { holdings: enriched, summary: { totalValue, totalCost, totalPnL: totalValue - totalCost, totalPnLPct: totalCost > 0 ? +((totalValue - totalCost) / totalCost * 100).toFixed(2) : 0 } } });
});

app.post("/api/portfolio", auth, (req, res) => {
  const { ticker, shares, avg_price, notes } = req.body;
  if (!ticker || !shares || !avg_price) return res.status(400).json({ success: false, error: "ticker, shares, avg_price required" });
  const result = db.prepare("INSERT OR IGNORE INTO portfolio (user_id, ticker, shares, avg_price, notes) VALUES (?,?,?,?,?)").run(req.user.id, ticker.toUpperCase(), shares, avg_price, notes || null);
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put("/api/portfolio/:id", auth, (req, res) => {
  const { shares, avg_price, notes } = req.body;
  db.prepare("UPDATE portfolio SET shares=?, avg_price=?, notes=? WHERE id=? AND user_id=?").run(shares, avg_price, notes, req.params.id, req.user.id);
  res.json({ success: true });
});

app.delete("/api/portfolio/:id", auth, (req, res) => {
  db.prepare("DELETE FROM portfolio WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success: true });
});

// GET /api/portfolio/:ticker/xirr — detailed XIRR breakdown
app.get("/api/portfolio/:ticker/xirr", auth, async (req, res) => {
  try {
    const uid    = req.user.id;
    const ticker = req.params.ticker.toUpperCase();
    const stock  = await fetchNSEPrice(ticker);
    const trades = db.prepare("SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC").all(uid, ticker);
    if (!trades.length) return res.json({ success: true, ticker, xirrPct: null, message: "No trades found" });
    const xirrPct = computeXIRR(trades, stock.price);
    let runningShares = 0;
    const cashflows = trades.map(t => {
      runningShares += t.type === "BUY" ? t.shares : -t.shares;
      return { date: t.traded_at, type: t.type, shares: t.shares, price: t.price, cashflow: t.type === "BUY" ? -t.amount : +t.amount, runningShares: +runningShares.toFixed(4) };
    });
    if (runningShares > 0.0001) cashflows.push({ date: new Date().toISOString(), type: "CURRENT_VALUE", shares: +runningShares.toFixed(4), price: stock.price, cashflow: +(runningShares * stock.price).toFixed(2), runningShares: +runningShares.toFixed(4) });
    res.json({ success: true, ticker, xirrPct, livePrice: stock.price, cashflows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────
// ROUTES — EXCEL IMPORT
// POST /api/trades/import
// ─────────────────────────────────────────
app.post("/api/trades/import", auth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (![".xls", ".xlsx", ".xlsm"].includes(ext))
      return res.status(400).json({ success: false, error: "Only .xls / .xlsx files are supported" });

    const { trades, errors } = parseExcelTrades(req.file.buffer, req.file.originalname);

    if (!trades.length)
      return res.json({ success: false, error: "No valid trades found in file", parseErrors: errors });

    const uid       = req.user.id;
    let   imported  = 0;
    let   skipped   = 0;
    const importErrors = [...errors];

    // Insert trades in a transaction
    const insertTrade = db.prepare(
      "INSERT INTO trade_history (user_id, ticker, type, shares, price, amount, notes, traded_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    const getPortfolio = db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?");
    const insertPort   = db.prepare("INSERT OR IGNORE INTO portfolio (user_id, ticker, shares, avg_price, notes) VALUES (?,?,?,?,?)");
    const updatePort   = db.prepare("UPDATE portfolio SET shares=?, avg_price=? WHERE user_id=? AND ticker=?");
    const deletePort   = db.prepare("DELETE FROM portfolio WHERE user_id=? AND ticker=?");

    const doImport = db.transaction(() => {
      for (const t of trades) {
        try {
          insertTrade.run(uid, t.ticker, t.type, t.shares, t.price, t.amount, t.notes, t.traded_at);

          if (t.type === "BUY") {
            const ex = getPortfolio.get(uid, t.ticker);
            if (ex) {
              const ns = ex.shares + t.shares;
              const np = ((ex.avg_price * ex.shares) + (t.price * t.shares)) / ns;
              updatePort.run(ns, +np.toFixed(4), uid, t.ticker);
            } else {
              insertPort.run(uid, t.ticker, t.shares, t.price, "Imported");
            }
          }

          if (t.type === "SELL") {
            const ex = getPortfolio.get(uid, t.ticker);
            if (ex) {
              const ns = ex.shares - t.shares;
              if (ns <= 0.0001) deletePort.run(uid, t.ticker);
              else updatePort.run(+ns.toFixed(4), ex.avg_price, uid, t.ticker);
            }
          }

          imported++;
        } catch (err) {
          importErrors.push(`[${t.ticker}] ${t.type}: ${err.message}`);
          skipped++;
        }
      }
    });

    doImport();

    res.json({
      success: true,
      summary: { total: trades.length, imported, skipped },
      parseErrors: importErrors,
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────
// ROUTES — WATCHLIST
// ─────────────────────────────────────────
app.get("/api/watchlist", auth, async (req, res) => {
  const items = db.prepare("SELECT * FROM watchlist WHERE user_id=? ORDER BY added_at DESC").all(req.user.id);
  const enriched = await Promise.all(items.map(async w => {
    try { return { ...w, ...(await fetchNSEPrice(w.ticker)) }; }
    catch { return { ...w, price: null }; }
  }));
  res.json({ success: true, data: enriched });
});

app.post("/api/watchlist", auth, (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ success: false, error: "ticker required" });
  db.prepare("INSERT OR IGNORE INTO watchlist (user_id, ticker) VALUES (?,?)").run(req.user.id, ticker.toUpperCase());
  res.json({ success: true });
});

app.delete("/api/watchlist/:ticker", auth, (req, res) => {
  db.prepare("DELETE FROM watchlist WHERE user_id=? AND ticker=?").run(req.user.id, req.params.ticker.toUpperCase());
  res.json({ success: true });
});

// ─────────────────────────────────────────
// ROUTES — SIP CONFIG
// ─────────────────────────────────────────
app.get("/api/sip-config", auth, (req, res) => {
  const cfg = getOrSeedSIP(req.user.id);
  res.json({ success: true, data: { ...cfg, levels: JSON.parse(cfg.levels) } });
});

app.put("/api/sip-config", auth, (req, res) => {
  const { max_budget, levels } = req.body;
  if (!max_budget || !levels) return res.status(400).json({ success: false, error: "max_budget and levels required" });
  const total = levels.reduce((s, l) => s + l.allocation, 0);
  if (total !== 100) return res.status(400).json({ success: false, error: `Allocations must sum to 100, got ${total}` });
  db.prepare("INSERT INTO sip_config (user_id, max_budget, levels) VALUES (?,?,?)").run(req.user.id, max_budget, JSON.stringify(levels));
  res.json({ success: true });
});

// ─────────────────────────────────────────
// ROUTES — TRADE HISTORY
// ─────────────────────────────────────────
app.get("/api/trades", auth, (req, res) => {
  const { ticker, type, limit = 100 } = req.query;
  let query = "SELECT * FROM trade_history WHERE user_id=?";
  const params = [req.user.id];
  if (ticker) { query += " AND ticker=?"; params.push(ticker.toUpperCase()); }
  if (type)   { query += " AND type=?";   params.push(type.toUpperCase()); }
  query += " ORDER BY traded_at DESC LIMIT ?";
  params.push(Number(limit));
  res.json({ success: true, data: db.prepare(query).all(...params) });
});

app.post("/api/trades", auth, (req, res) => {
  const { ticker, type, shares, price, notes, traded_at } = req.body;
  if (!ticker || !type || !shares || !price) return res.status(400).json({ success: false, error: "ticker, type, shares, price required" });
  const uid       = req.user.id;
  const amount    = shares * price;
  const tradeDate = traded_at || new Date().toISOString();
  const result    = db.prepare("INSERT INTO trade_history (user_id, ticker, type, shares, price, amount, notes, traded_at) VALUES (?,?,?,?,?,?,?,?)").run(uid, ticker.toUpperCase(), type.toUpperCase(), shares, price, amount, notes || null, tradeDate);

  if (type.toUpperCase() === "BUY") {
    const ex = db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker.toUpperCase());
    if (ex) {
      const ns = ex.shares + shares;
      const np = ((ex.avg_price * ex.shares) + (price * shares)) / ns;
      db.prepare("UPDATE portfolio SET shares=?, avg_price=? WHERE id=? AND user_id=?").run(ns, +np.toFixed(4), ex.id, uid);
    } else {
      db.prepare("INSERT INTO portfolio (user_id, ticker, shares, avg_price) VALUES (?,?,?,?)").run(uid, ticker.toUpperCase(), shares, price);
    }
  }

  if (type.toUpperCase() === "SELL") {
    const ex = db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker.toUpperCase());
    if (ex) {
      const ns = ex.shares - shares;
      if (ns <= 0) db.prepare("DELETE FROM portfolio WHERE id=? AND user_id=?").run(ex.id, uid);
      else db.prepare("UPDATE portfolio SET shares=? WHERE id=? AND user_id=?").run(+ns.toFixed(4), ex.id, uid);
    }
  }

  res.json({ success: true, id: result.lastInsertRowid });
});

app.delete("/api/trades/:id", auth, (req, res) => {
  db.prepare("DELETE FROM trade_history WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ success: true, status: "ok", timestamp: new Date().toISOString() }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ PORTFLOW backend running on http://localhost:${PORT}`));
