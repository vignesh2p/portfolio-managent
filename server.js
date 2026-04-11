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
const dbPath = process.env.VERCEL ? path.join("/tmp", "portflow.db") : "portflow.db";
const db  = new Database(dbPath);

const JWT_SECRET = process.env.JWT_SECRET || "portflow_secret_change_in_prod";
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
// DATABASE
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
// AUTH
// ─────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ success: false, error: "Invalid or expired token" }); }
}

function getOrSeedSIP(userId) {
  let cfg = db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
  if (!cfg) {
    db.prepare("INSERT INTO sip_config (user_id, max_budget, levels) VALUES (?,?,?)").run(userId, 50000,
      JSON.stringify([
        {fall:-10,allocation:10},{fall:-15,allocation:5},{fall:-20,allocation:20},
        {fall:-25,allocation:10},{fall:-30,allocation:30},{fall:-35,allocation:15},{fall:-40,allocation:10}
      ])
    );
    cfg = db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
  }
  return cfg;
}

// ─────────────────────────────────────────
// XIRR
// ─────────────────────────────────────────
function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return null;
  const sorted  = [...cashflows].sort((a, b) => a.date - b.date);
  const t0      = sorted[0].date;
  const days    = sorted.map(c => (c.date - t0) / 86400000);
  const amounts = sorted.map(c => c.amount);
  if (!amounts.some(a => a < 0) || !amounts.some(a => a > 0)) return null;

  const npv  = r => amounts.reduce((s, cf, i) => s + cf / Math.pow(1 + r, days[i] / 365), 0);
  const dnpv = r => amounts.reduce((s, cf, i) => s - (days[i] / 365) * cf / Math.pow(1 + r, days[i] / 365 + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 300; i++) {
    const f = npv(r), df = dnpv(r);
    if (Math.abs(df) < 1e-14) break;
    const rn = r - f / df;
    if (Math.abs(rn - r) < 1e-10) return +((rn * 100).toFixed(2));
    r = rn < -0.9999 ? -0.9999 : rn > 100 ? 100 : rn;
  }
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 500; i++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(hi - lo) < 1e-10) return +((mid * 100).toFixed(2));
    npv(mid) * npv(lo) < 0 ? (hi = mid) : (lo = mid);
  }
  return null;
}

function computeXIRR(trades, livePrice) {
  if (!trades?.length) return null;
  const cashflows = trades.map(t => ({
    amount: t.type === "BUY" ? -Math.abs(t.amount) : +Math.abs(t.amount),
    date:   new Date(t.traded_at),
  }));
  const rem = trades.reduce((s, t) => s + (t.type === "BUY" ? t.shares : -t.shares), 0);
  if (rem > 0.0001 && livePrice > 0) cashflows.push({ amount: rem * livePrice, date: new Date() });
  return xirr(cashflows);
}

// ─────────────────────────────────────────
// NSE PRICE FETCH  (backend proxy + cache)
//
// Called by GET /api/price/:ticker
// The FRONTEND calls this per-ticker after loading portfolio holdings,
// so each stock price loads asynchronously and updates the UI as it arrives.
// This avoids blocking the whole portfolio load on slow/failing price APIs.
// ─────────────────────────────────────────
const priceCache = {};
const CACHE_TTL  = 5 * 60 * 1000;
let   nseSession = null;
let   nseLastWarm = 0;

async function warmNSE() {
  if (Date.now() - nseLastWarm < 8 * 60 * 1000) return;
  try {
    const r = await axios.get("https://www.nseindia.com", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      },
      timeout: 10000,
    });
    const cookies = (r.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");
    if (cookies) { nseSession = cookies; nseLastWarm = Date.now(); }
  } catch { /* will retry next time */ }
}

async function fetchPrice(ticker) {
  const cached = priceCache[ticker];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached;

  await warmNSE();

  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-IN,en-GB;q=0.9,en-US;q=0.8",
    "Referer": `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(ticker)}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    ...(nseSession ? { Cookie: nseSession } : {}),
  };

  const url = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(ticker)}`;
  const res  = await axios.get(url, { headers, timeout: 12000 });
  const d    = res.data;

  if (!d || typeof d !== "object") throw new Error("Invalid response from NSE");
  const info = d.info      || {};
  const pd   = d.priceInfo || {};
  const wh52 = pd["52WeekHigh"] || pd.weekHigh52 || null;
  const price = pd.lastPrice || pd.close || 0;

  if (!price) throw new Error(`No price in NSE response for ${ticker}`);

  const result = {
    ticker,
    name:      info.companyName || ticker,
    exchange:  "NSE",
    price,
    prevClose: pd.previousClose || 0,
    change:    pd.change    || 0,
    changePct: pd.pChange   || 0,
    week52High: wh52,
    ath:       wh52 || price,
    cachedAt:  Date.now(),
  };
  priceCache[ticker] = result;
  return result;
}

// ─────────────────────────────────────────
// EXCEL PARSER
// ─────────────────────────────────────────
function parseExcelTrades(buffer, filename) {
  const wb   = XLSX.read(buffer, { type: "buffer", raw: false, cellDates: false });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });

  const trades = [], errors = [];
  let section = null;
  let colMap  = {};

  function toNum(v) {
    if (v === null || v === undefined || String(v).trim() === "") return null;
    const n = parseFloat(String(v).replace(/,/g, "").trim());
    return isNaN(n) ? null : n;
  }

  function parseDate(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (m) return new Date(`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}T12:00:00`);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(`${s.substring(0,10)}T12:00:00`);
    const serial = parseFloat(s);
    if (!isNaN(serial) && serial > 30000 && serial < 60000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
      return new Date(`${d.toISOString().substring(0,10)}T12:00:00`);
    }
    const d = new Date(s);
    if (!isNaN(d)) return d;
    return null;
  }

  function cleanTicker(raw) {
    if (!raw) return null;
    return String(raw)
      .replace(/\s*[-–]\s*\((?:NSE|BSE|NFO|MCX|BO|NS)\)\s*$/i, "")
      .replace(/\s*\((?:NSE|BSE|NFO|MCX|BO|NS)\)\s*$/i, "")
      .trim().toUpperCase()
      .replace(/[^A-Z0-9 &]/g, "")
      .replace(/\s+/g, " ").trim() || null;
  }

  function buildColMap(headerRow) {
    const map = {};
    headerRow.forEach((cell, i) => {
      const key = String(cell).toLowerCase().trim().replace(/[^a-z0-9]/g,"_").replace(/_+/g,"_").replace(/^_|_$/g,"");
      if (key) map[key] = i;
    });
    return map;
  }

  for (let i = 0; i < rows.length; i++) {
    const row   = rows[i];
    const first = String(row[0] || "").trim();

    if (/scrips\s+bought/i.test(first))  { section = "BUY";  colMap = {}; continue; }
    if (/scrips\s+sold/i.test(first))    { section = "SELL"; colMap = {}; continue; }
    if (/mutual\s+funds|ulip|e-series|financial\s+year/i.test(first)) { section = null; colMap = {}; continue; }
    if (!section) continue;

    if (/^(stock|mutual\s+fund|commodity)$/i.test(first)) { colMap = buildColMap(row); continue; }
    if (!first || /^(profit\/loss|no\s+buy|no\s+sell)/i.test(first)) continue;

    if (section === "BUY") {
      const iStock = colMap["stock"]    ?? 0;
      const iQty   = colMap["pur_qty"]  ?? 1;
      const iDate  = colMap["pur_date"] ?? 2;
      const iPrice = colMap["pur_price"]?? 3;

      const ticker = cleanTicker(row[iStock]);
      const qty    = toNum(row[iQty]);
      const date   = parseDate(row[iDate]);
      const price  = toNum(row[iPrice]);

      if (!ticker)              { errors.push(`Row ${i+1}: Missing stock name`); continue; }
      if (!qty   || qty   <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid qty "${row[iQty]}"`); continue; }
      if (!price || price <= 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid price "${row[iPrice]}"`); continue; }

      trades.push({ ticker, type:"BUY", shares:qty, price, amount:qty*price,
        traded_at:(date&&!isNaN(date))?date.toISOString():new Date().toISOString(),
        notes:"Imported (Scrips Bought)" });
    }

    if (section === "SELL") {
      const iStock     = colMap["stock"]      ?? 0;
      const iPurPrice  = colMap["pur_price"]  ?? 1;
      const iPurDate   = colMap["pur_date"]   ?? 2;
      const iSellQty   = colMap["sell_qty"]   ?? 3;
      const iSellPrice = colMap["sell_price"] ?? 4;
      const iSellDate  = colMap["sell_date"]  ?? 5;

      const ticker    = cleanTicker(row[iStock]);
      const purPrice  = toNum(row[iPurPrice]);
      const purDate   = parseDate(row[iPurDate]);
      const sellQty   = toNum(row[iSellQty]);
      const sellPrice = toNum(row[iSellPrice]);
      const sellDate  = parseDate(row[iSellDate]);

      if (!ticker)                 { errors.push(`Row ${i+1}: Missing stock name`); continue; }
      if (!sellQty || sellQty <= 0){ errors.push(`Row ${i+1} [${ticker}]: Invalid sell qty`); continue; }
      if (!sellPrice||sellPrice<=0){ errors.push(`Row ${i+1} [${ticker}]: Invalid sell price`); continue; }

      if (purPrice && purPrice > 0) {
        trades.push({ ticker, type:"BUY", shares:sellQty, price:purPrice, amount:sellQty*purPrice,
          traded_at:(purDate&&!isNaN(purDate))?purDate.toISOString():new Date().toISOString(),
          notes:"Imported (original buy for sold lot)" });
      }
      trades.push({ ticker, type:"SELL", shares:sellQty, price:sellPrice, amount:sellQty*sellPrice,
        traded_at:(sellDate&&!isNaN(sellDate))?sellDate.toISOString():new Date().toISOString(),
        notes:"Imported (Scrips Sold)" });
    }
  }

  return { trades, errors };
}

// ─────────────────────────────────────────
// ROUTES — AUTH
// ─────────────────────────────────────────
app.post("/api/auth/signup", async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  if (password.length < 6)  return res.status(400).json({ success:false, error:"Password must be at least 6 characters" });
  if (db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase()))
    return res.status(400).json({ success:false, error:"Email already registered" });
  const hashed = await bcrypt.hash(password, 10);
  const result = db.prepare("INSERT INTO users (email,password,name) VALUES (?,?,?)").run(email.toLowerCase(), hashed, name||email.split("@")[0]);
  const token  = jwt.sign({ id:result.lastInsertRowid, email:email.toLowerCase() }, JWT_SECRET, { expiresIn:"30d" });
  res.json({ success:true, token, user:{ id:result.lastInsertRowid, email:email.toLowerCase(), name:name||email.split("@")[0] } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ success:false, error:"Invalid email or password" });
  const token = jwt.sign({ id:user.id, email:user.email }, JWT_SECRET, { expiresIn:"30d" });
  res.json({ success:true, token, user:{ id:user.id, email:user.email, name:user.name } });
});

app.get("/api/auth/me", auth, (req, res) => {
  const user = db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").get(req.user.id);
  res.json({ success:true, user });
});

// ─────────────────────────────────────────
// ROUTES — PRICE  (one ticker at a time, called by frontend async)
// GET /api/price/:ticker
// ─────────────────────────────────────────
app.get("/api/price/:ticker", auth, async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const data = await fetchPrice(ticker);
    res.json({ success:true, data });
  } catch (err) {
    // Return partial data so frontend can still show the holding without CMP
    res.json({ success:false, ticker, error:err.message });
  }
});

// GET /api/stock/:ticker/sip  (used in SIP tab — needs price)
app.get("/api/stock/:ticker/sip", auth, async (req, res) => {
  try {
    const ticker  = req.params.ticker.toUpperCase();
    const stock   = await fetchPrice(ticker);
    const cfg     = getOrSeedSIP(req.user.id);
    const levels  = JSON.parse(cfg.levels);
    const budget  = cfg.max_budget;
    const fallPct = ((stock.price - stock.ath) / stock.ath) * 100;
    const analysis = levels.map(l => ({
      ...l,
      amount:       Math.round((l.allocation/100)*budget),
      triggerPrice: Math.round(stock.ath*(1+l.fall/100)),
      triggered:    fallPct <= l.fall,
    }));
    const triggered       = analysis.filter(a => a.triggered);
    const totalDeployable = triggered.reduce((s, a) => s + a.amount, 0);
    res.json({ success:true, data:{ stock, fallPct:+fallPct.toFixed(2), budget, analysis, triggered, totalDeployable } });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

// ─────────────────────────────────────────
// ROUTES — PORTFOLIO
// GET /api/portfolio — returns holdings INSTANTLY from DB (no price fetch)
//   Frontend calls /api/price/:ticker per-row to load CMP asynchronously
// ─────────────────────────────────────────
app.get("/api/portfolio", auth, (req, res) => {
  const uid      = req.user.id;
  const holdings = db.prepare("SELECT * FROM portfolio WHERE user_id=? ORDER BY added_at DESC").all(uid);

  // Attach trade count and XIRR inputs (no live price needed for this)
  const withTrades = holdings.map(h => {
    const trades = db.prepare(
      "SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC"
    ).all(uid, h.ticker);
    return { ...h, tradeCount: trades.length, trades };
  });

  res.json({ success:true, data:{ holdings: withTrades } });
});

// GET /api/portfolio/:ticker/xirr
app.get("/api/portfolio/:ticker/xirr", auth, async (req, res) => {
  try {
    const uid    = req.user.id;
    const ticker = req.params.ticker.toUpperCase();
    const trades = db.prepare("SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC").all(uid, ticker);
    if (!trades.length) return res.json({ success:true, ticker, xirrPct:null, livePrice:0, cashflows:[] });

    // Get live price for current value (best effort)
    let livePrice = 0;
    try { livePrice = (await fetchPrice(ticker)).price; } catch {}

    const xirrPct = computeXIRR(trades, livePrice);
    let rem = 0;
    const cashflows = trades.map(t => {
      rem += t.type==="BUY" ? t.shares : -t.shares;
      return { date:t.traded_at, type:t.type, shares:t.shares, price:t.price,
               cashflow:t.type==="BUY"?-t.amount:+t.amount, runningShares:+rem.toFixed(4) };
    });
    if (rem > 0.0001 && livePrice > 0)
      cashflows.push({ date:new Date().toISOString(), type:"CURRENT_VALUE", shares:+rem.toFixed(4),
                       price:livePrice, cashflow:+(rem*livePrice).toFixed(2), runningShares:+rem.toFixed(4) });

    res.json({ success:true, ticker, xirrPct, livePrice, cashflows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post("/api/portfolio", auth, (req, res) => {
  const { ticker, shares, avg_price, notes } = req.body;
  if (!ticker||!shares||!avg_price) return res.status(400).json({ success:false, error:"ticker, shares, avg_price required" });
  const r = db.prepare("INSERT OR IGNORE INTO portfolio (user_id,ticker,shares,avg_price,notes) VALUES (?,?,?,?,?)").run(req.user.id, ticker.toUpperCase(), shares, avg_price, notes||null);
  res.json({ success:true, id:r.lastInsertRowid });
});

app.put("/api/portfolio/:id", auth, (req, res) => {
  const {shares,avg_price,notes}=req.body;
  db.prepare("UPDATE portfolio SET shares=?,avg_price=?,notes=? WHERE id=? AND user_id=?").run(shares,avg_price,notes,req.params.id,req.user.id);
  res.json({ success:true });
});

app.delete("/api/portfolio/:id", auth, (req, res) => {
  db.prepare("DELETE FROM portfolio WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success:true });
});

// ─────────────────────────────────────────
// ROUTES — TRADES
// ─────────────────────────────────────────
function _syncPortfolio(uid, ticker, type, shares, price) {
  const ex = db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker);
  if (type === "BUY") {
    if (ex) {
      const ns = ex.shares + shares;
      const np = ((ex.avg_price * ex.shares) + (price * shares)) / ns;
      db.prepare("UPDATE portfolio SET shares=?,avg_price=? WHERE user_id=? AND ticker=?").run(+ns.toFixed(4), +np.toFixed(4), uid, ticker);
    } else {
      db.prepare("INSERT INTO portfolio (user_id,ticker,shares,avg_price) VALUES (?,?,?,?)").run(uid, ticker, shares, price);
    }
  }
  if (type === "SELL" && ex) {
    const ns = ex.shares - shares;
    if (ns <= 0.0001) db.prepare("DELETE FROM portfolio WHERE user_id=? AND ticker=?").run(uid, ticker);
    else db.prepare("UPDATE portfolio SET shares=? WHERE user_id=? AND ticker=?").run(+ns.toFixed(4), uid, ticker);
  }
}

app.get("/api/trades", auth, (req, res) => {
  const { ticker, type, limit=200 } = req.query;
  let q="SELECT * FROM trade_history WHERE user_id=?"; const p=[req.user.id];
  if (ticker){ q+=" AND ticker=?"; p.push(ticker.toUpperCase()); }
  if (type)  { q+=" AND type=?";   p.push(type.toUpperCase()); }
  q+=" ORDER BY traded_at DESC LIMIT ?"; p.push(Number(limit));
  res.json({ success:true, data:db.prepare(q).all(...p) });
});

app.post("/api/trades", auth, (req, res) => {
  const { ticker, type, shares, price, notes, traded_at } = req.body;
  if (!ticker||!type||!shares||!price) return res.status(400).json({ success:false, error:"ticker, type, shares, price required" });
  const uid=req.user.id, amount=shares*price, tradeDate=traded_at||new Date().toISOString();
  const r=db.prepare("INSERT INTO trade_history (user_id,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?)").run(uid,ticker.toUpperCase(),type.toUpperCase(),shares,price,amount,notes||null,tradeDate);
  _syncPortfolio(uid, ticker.toUpperCase(), type.toUpperCase(), shares, price);
  res.json({ success:true, id:r.lastInsertRowid });
});

app.delete("/api/trades/:id", auth, (req, res) => {
  db.prepare("DELETE FROM trade_history WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success:true });
});

app.delete("/api/trades", auth, (req, res) => {
  const uid=req.user.id;
  db.prepare("DELETE FROM trade_history WHERE user_id=?").run(uid);
  db.prepare("DELETE FROM portfolio WHERE user_id=?").run(uid);
  res.json({ success:true, message:"All trades and portfolio cleared" });
});

// ─────────────────────────────────────────
// EXCEL IMPORT
// ─────────────────────────────────────────
app.post("/api/trades/preview", auth, upload.array("files", 20), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ success:false, error:"No files uploaded" });
  let allTrades=[], allErrors=[];
  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".xls",".xlsx",".xlsm"].includes(ext)){ allErrors.push(`${file.originalname}: unsupported format`); continue; }
    try {
      const { trades, errors } = parseExcelTrades(file.buffer, file.originalname);
      allTrades = allTrades.concat(trades.map(t=>({...t, _file:file.originalname})));
      allErrors = allErrors.concat(errors.map(e=>`[${file.originalname}] ${e}`));
    } catch(e) { allErrors.push(`${file.originalname}: ${e.message}`); }
  }
  res.json({ success:true, trades:allTrades, errors:allErrors, total:allTrades.length });
});

app.post("/api/trades/import", auth, (req, res) => {
  const { trades } = req.body;
  if (!trades?.length) return res.status(400).json({ success:false, error:"No trades provided" });
  const uid=req.user.id; let imported=0, skipped=0; const importErrors=[];
  const doImport=db.transaction(()=>{
    for (const t of trades) {
      try {
        if (!t.ticker||!t.type||!t.shares||!t.price) throw new Error("missing fields");
        db.prepare("INSERT INTO trade_history (user_id,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?)").run(uid,t.ticker,t.type,t.shares,t.price,t.amount,t.notes||null,t.traded_at||new Date().toISOString());
        _syncPortfolio(uid, t.ticker, t.type, t.shares, t.price);
        imported++;
      } catch(e){ importErrors.push(`[${t.ticker}] ${e.message}`); skipped++; }
    }
  });
  doImport();
  res.json({ success:true, summary:{ total:trades.length, imported, skipped }, errors:importErrors });
});

// ─────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────
app.get("/api/watchlist", auth, async (req, res) => {
  const items=db.prepare("SELECT * FROM watchlist WHERE user_id=? ORDER BY added_at DESC").all(req.user.id);
  const enriched=await Promise.all(items.map(async w=>{
    try { return { ...w, ...(await fetchPrice(w.ticker)) }; }
    catch { return { ...w, price:null }; }
  }));
  res.json({ success:true, data:enriched });
});
app.post("/api/watchlist", auth, (req,res)=>{ const{ticker}=req.body; if(!ticker) return res.status(400).json({success:false,error:"ticker required"}); db.prepare("INSERT OR IGNORE INTO watchlist (user_id,ticker) VALUES (?,?)").run(req.user.id,ticker.toUpperCase()); res.json({success:true}); });
app.delete("/api/watchlist/:ticker", auth, (req,res)=>{ db.prepare("DELETE FROM watchlist WHERE user_id=? AND ticker=?").run(req.user.id,req.params.ticker.toUpperCase()); res.json({success:true}); });

// ─────────────────────────────────────────
// SIP CONFIG
// ─────────────────────────────────────────
app.get("/api/sip-config", auth, (req,res)=>{ const cfg=getOrSeedSIP(req.user.id); res.json({success:true,data:{...cfg,levels:JSON.parse(cfg.levels)}}); });
app.put("/api/sip-config", auth, (req,res)=>{
  const{max_budget,levels}=req.body;
  if(!max_budget||!levels) return res.status(400).json({success:false,error:"max_budget and levels required"});
  const total=levels.reduce((s,l)=>s+l.allocation,0);
  if(total!==100) return res.status(400).json({success:false,error:`Allocations must sum to 100, got ${total}`});
  db.prepare("INSERT INTO sip_config (user_id,max_budget,levels) VALUES (?,?,?)").run(req.user.id,max_budget,JSON.stringify(levels));
  res.json({success:true});
});

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get("/api/health", (req,res)=>res.json({success:true,status:"ok",timestamp:new Date().toISOString()}));

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`✅ PORTFLOW backend running on http://localhost:${PORT}`));
}

module.exports = app;
