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
app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "portflow.html"));
});

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
    company_name TEXT,
    exchange   TEXT,
    google_code TEXT,
    bse_code   TEXT,
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
    company_name TEXT,
    exchange   TEXT,
    google_code TEXT,
    bse_code   TEXT,
    type       TEXT    NOT NULL CHECK(type IN ('BUY','SELL')),
    shares     REAL    NOT NULL,
    price      REAL    NOT NULL,
    amount     REAL    NOT NULL,
    notes      TEXT,
    traded_at  TEXT    DEFAULT (datetime('now'))
  );
`);

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

ensureColumn("portfolio", "company_name", "TEXT");
ensureColumn("portfolio", "exchange", "TEXT");
ensureColumn("portfolio", "google_code", "TEXT");
ensureColumn("portfolio", "bse_code", "TEXT");
ensureColumn("trade_history", "company_name", "TEXT");
ensureColumn("trade_history", "exchange", "TEXT");
ensureColumn("trade_history", "google_code", "TEXT");
ensureColumn("trade_history", "bse_code", "TEXT");

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").get(req.user.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Session data is no longer available on the server. Please sign in again.",
      });
    }
    req.user = { ...req.user, dbUser: user };
    next();
  }
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
const instrumentCache = {};

function cleanLookupText(raw) {
  return String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\b(LTD|LIMITED|INDUSTRIES|INDUSTRY|CORPORATION|CORP|COMPANY|CO|THE)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function moneycontrolInstrument(ticker, companyName, exchange, bseCode = null) {
  const googleCode = exchange === "BSE" ? `BOM:${bseCode}` : `${exchange}:${ticker}`;
  return {
    ticker,
    company_name: companyName,
    exchange,
    google_code: googleCode,
    bse_code: bseCode,
    nse_code: exchange === "NSE" ? ticker : null,
    source: "moneycontrol-priority",
  };
}

const moneycontrolPriorityMap = {
  "AARTI IND": moneycontrolInstrument("AARTIIND", "Aarti Industries Ltd", "NSE", "524208"),
  "ALKYL AMINES": moneycontrolInstrument("ALKYLAMINE", "Alkyl Amines Chemicals Ltd", "NSE", "506767"),
  "ANANT RAJ": moneycontrolInstrument("ANANTRAJ", "Anant Raj Ltd", "NSE", "515055"),
  "ANGEL ONE": moneycontrolInstrument("ANGELONE", "Angel One Ltd", "NSE", "543235"),
  "APOLLO PIPES": moneycontrolInstrument("APOLLOPIPE", "Apollo Pipes Ltd", "NSE", "531761"),
  "ASIAN PAINTS": moneycontrolInstrument("ASIANPAINT", "Asian Paints Ltd", "NSE", "500820"),
  "BAJAJ FINANCE": moneycontrolInstrument("BAJFINANCE", "Bajaj Finance Ltd", "NSE", "500034"),
  "BALAJI AMINES": moneycontrolInstrument("BALAMINES", "Balaji Amines Ltd", "NSE", "530999"),
  "BALU FORGE INDU": moneycontrolInstrument("BALUFORGE", "Balu Forge Industries Ltd", "NSE", "531112"),
  "BANCO PRODUCTS": moneycontrolInstrument("BANCOINDIA", "Banco Products (India) Ltd", "NSE", "500039"),
  "CAPLIN LABS": moneycontrolInstrument("CAPLIPOINT", "Caplin Point Laboratories Ltd", "NSE", "524742"),
  "CDSL": moneycontrolInstrument("CDSL", "Central Depository Services (India) Ltd", "NSE", null),
  "CEINSYS TECH": moneycontrolInstrument("CEINSYS", "Ceinsys Tech Ltd", "NSE", "538734"),
  "CG POWER": moneycontrolInstrument("CGPOWER", "CG Power and Industrial Solutions Ltd", "NSE", "500093"),
  "COFORGE": moneycontrolInstrument("COFORGE", "Coforge Ltd", "NSE", "532541"),
  "COSMO FIRST": moneycontrolInstrument("COSMOFIRST", "Cosmo First Ltd", "NSE", "508814"),
  "DEEPAK NITRITE": moneycontrolInstrument("DEEPAKNTR", "Deepak Nitrite Ltd", "NSE", "506401"),
  "D LINK INDIA": moneycontrolInstrument("DLINKINDIA", "D-Link India Ltd", "NSE", "533146"),
  "DYNAMIC CABLES": moneycontrolInstrument("DYCL", "Dynamic Cables Ltd", "NSE", "540795"),
  "ELGI EQUIPMENTS": moneycontrolInstrument("ELGIEQUIP", "Elgi Equipments Ltd", "NSE", "522074"),
  "FLUIDOMAT": moneycontrolInstrument("522017", "Fluidomat Ltd", "BSE", "522017"),
  "FUSION FINANCE": moneycontrolInstrument("FUSION", "Fusion Finance Ltd", "NSE", "543652"),
  "GALLANTT ISPAT": moneycontrolInstrument("GALLANTT", "Gallantt Ispat Ltd", "NSE", "532726"),
  "GANESH HOUSING": moneycontrolInstrument("GANESHHOUC", "Ganesh Housing Corporation Ltd", "NSE", "526367"),
  "GARDEN REACH SH": moneycontrolInstrument("GRSE", "Garden Reach Shipbuilders & Engineers Ltd", "NSE", "542011"),
  "GARWARE HITECH": moneycontrolInstrument("GRWRHITECH", "Garware Hi-Tech Films Ltd", "NSE", "509557"),
  "HBL ENG": moneycontrolInstrument("HBLENGINE", "HBL Engineering Ltd", "NSE", "517271"),
  "ICE MAKE REFRIG": moneycontrolInstrument("ICEMAKE", "Ice Make Refrigeration Ltd", "NSE", "541634"),
  "INDRAPRASTHA": moneycontrolInstrument("IGL", "Indraprastha Gas Ltd", "NSE", "532514"),
  "IRFC": moneycontrolInstrument("IRFC", "Indian Railway Finance Corporation Ltd", "NSE", "543257"),
  "J K CEMENT": moneycontrolInstrument("JKCEMENT", "JK Cement Ltd", "NSE", "532644"),
  "JTL IND": moneycontrolInstrument("JTLIND", "JTL Industries Ltd", "NSE", "534600"),
  "KPIGREEN": moneycontrolInstrument("KPIGREEN", "KPI Green Energy Ltd", "NSE", "542323"),
  "KPIL": moneycontrolInstrument("KALPATPOWR", "Kalpataru Projects International Ltd", "NSE", "522287"),
  "KPIT TECH": moneycontrolInstrument("KPITTECH", "KPIT Technologies Ltd", "NSE", "542651"),
  "L T TECHNOLOGY": moneycontrolInstrument("LTTS", "L&T Technology Services Ltd", "NSE", "540115"),
  "LAURUS LABS": moneycontrolInstrument("LAURUSLABS", "Laurus Labs Ltd", "NSE", "540222"),
  "LIC HOUSING FIN": moneycontrolInstrument("LICHSGFIN", "LIC Housing Finance Ltd", "NSE", "500253"),
  "LINCOLN PHARMA": moneycontrolInstrument("LINCOLN", "Lincoln Pharmaceuticals Ltd", "NSE", "531633"),
  "LT FOODS": moneycontrolInstrument("LTFOODS", "LT Foods Ltd", "NSE", "532783"),
  "LUMAX AUTO TECH": moneycontrolInstrument("LUMAXTECH", "Lumax Auto Technologies Ltd", "NSE", "532796"),
  "MANORAMA INDUST": moneycontrolInstrument("MANORAMA", "Manorama Industries Ltd", "NSE", "541974"),
  "MAZAGON DOCK": moneycontrolInstrument("MAZDOCK", "Mazagon Dock Shipbuilders Ltd", "NSE", "543237"),
  "MOTILAL OSWAL": moneycontrolInstrument("MOTILALOFS", "Motilal Oswal Financial Services Ltd", "NSE", "532892"),
  "NDR AUTO COMPON": moneycontrolInstrument("NDRAUTO", "NDR Auto Components Ltd", "NSE", "543214"),
  "PEARL GLOBAL IN": moneycontrolInstrument("PGIL", "Pearl Global Industries Ltd", "NSE", "532808"),
  "PG ELECTROPLAST": moneycontrolInstrument("PGEL", "PG Electroplast Ltd", "NSE", "533581"),
  "POLYCAB": moneycontrolInstrument("POLYCAB", "Polycab India Ltd", "NSE", "542652"),
  "PREMIER POLYFIL": moneycontrolInstrument("PREMIERPOL", "Premier Polyfilm Ltd", "NSE", "514354"),
  "RAIL VIKAS": moneycontrolInstrument("RVNL", "Rail Vikas Nigam Ltd", "NSE", "542649"),
  "RAJRATAN GLOBAL": moneycontrolInstrument("RAJRATAN", "Rajratan Global Wire Ltd", "NSE", "517522"),
  "RAMKRISHNAFORGE": moneycontrolInstrument("RKFORGE", "Ramkrishna Forgings Ltd", "NSE", "532527"),
  "REFEX IND": moneycontrolInstrument("REFEX", "Refex Industries Ltd", "NSE", "532884"),
  "RELAXO FOOTWEAR": moneycontrolInstrument("RELAXO", "Relaxo Footwears Ltd", "NSE", "530517"),
  "SENCO GOLD": moneycontrolInstrument("SENCO", "Senco Gold Ltd", "NSE", "543936"),
  "SHARE INDIA": moneycontrolInstrument("SHAREINDIA", "Share India Securities Ltd", "NSE", "540725"),
  "SKIPPER": moneycontrolInstrument("SKIPPER", "Skipper Ltd", "NSE", "538562"),
  "SKY GOLD": moneycontrolInstrument("SKYGOLD", "Sky Gold Ltd", "NSE", "541967"),
  "STERLING TOOLS": moneycontrolInstrument("STERTOOLS", "Sterling Tools Ltd", "NSE", "530759"),
  "TATA ELXSI": moneycontrolInstrument("TATAELXSI", "Tata Elxsi Ltd", "NSE", "500408"),
  "TATA POWER": moneycontrolInstrument("TATAPOWER", "Tata Power Company Ltd", "NSE", "500400"),
  "TD POWER SYSTEM": moneycontrolInstrument("TDPOWERSYS", "TD Power Systems Ltd", "NSE", "533553"),
  "TIPS MUSIC": moneycontrolInstrument("TIPSMUSIC", "Tips Music Ltd", "NSE", "532375"),
  "TITAN BIOTECH": moneycontrolInstrument("524717", "Titan Biotech Ltd", "BSE", "524717"),
  "TITAN COMPANY": moneycontrolInstrument("TITAN", "Titan Company Ltd", "NSE", "500114"),
  "TRANSFORMERS": moneycontrolInstrument("TARIL", "Transformers and Rectifiers (India) Ltd", "NSE", "532928"),
  "VARUN BEVERAGES": moneycontrolInstrument("VBL", "Varun Beverages Ltd", "NSE", "540180"),
  "VISHNU PRAKASH": moneycontrolInstrument("VPRPL", "Vishnu Prakash R Punglia Ltd", "NSE", "543974"),
  "WAAREE RENEWABL": moneycontrolInstrument("WAAREERTL", "Waaree Renewable Technologies Ltd", "NSE", "534618"),
  "WINDLAS BIOTECH": moneycontrolInstrument("WINDLAS", "Windlas Biotech Ltd", "NSE", "543329"),
  "YATHARTH HOSP": moneycontrolInstrument("YATHARTH", "Yatharth Hospital & Trauma Care Services Ltd", "NSE", "543950"),
};

function resolveMoneycontrolPriority(query) {
  return moneycontrolPriorityMap[cleanLookupText(query)] || null;
}

function decodeMoneycontrolText(raw) {
  return String(raw || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMoneycontrolCandidate(query, item) {
  const cleanedQuery = cleanLookupText(query);
  const queryTokens = cleanedQuery.split(" ").filter(Boolean);
  const display = cleanLookupText(`${item.name || ""} ${decodeMoneycontrolText(item.pdt_dis_nm || "")}`);
  let score = 0;
  if (display === cleanedQuery) score += 120;
  if (display.includes(cleanedQuery)) score += 70;
  if (queryTokens.length && queryTokens.every(tok => display.includes(tok))) score += 40;
  if (item.stock_name && cleanLookupText(item.stock_name) === cleanedQuery) score += 20;
  return score;
}

function parseMoneycontrolInstrument(item) {
  const display = decodeMoneycontrolText(item.pdt_dis_nm || "");
  const companyName = decodeMoneycontrolText(item.name || item.stock_name || display);
  const codePart = display.startsWith(companyName) ? display.slice(companyName.length).trim() : display;
  const parts = codePart.split(",").map(s => s.trim()).filter(Boolean);
  const nseCode = parts.length >= 2 ? parts[parts.length - 2].toUpperCase() : null;
  const bseCode = parts.length >= 1 ? parts[parts.length - 1] : null;
  const exchange = nseCode ? "NSE" : (bseCode ? "BSE" : null);
  const ticker = nseCode || bseCode || cleanLookupText(companyName).replace(/\s+/g, "");
  return {
    ticker,
    company_name: companyName,
    exchange,
    google_code: nseCode ? `NSE:${nseCode}` : (bseCode ? `BOM:${bseCode}` : null),
    bse_code: bseCode,
    nse_code: nseCode,
    moneycontrol_link: item.link_src || null,
    source: "moneycontrol-live",
  };
}

async function resolveViaMoneycontrol(query) {
  const url = `https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query=${encodeURIComponent(query)}&type=1&format=json&callback=suggest1`;
  const res = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Referer": "https://www.moneycontrol.com/",
      "Accept-Language": "en-IN,en;q=0.9",
    },
    timeout: 12000,
  });
  const body = String(res.data || "");
  const jsonpMatch = body.match(/^suggest1\((.*)\)\s*$/s);
  if (!jsonpMatch) throw new Error(`Invalid Moneycontrol response for ${query}`);
  const items = JSON.parse(jsonpMatch[1]);
  if (!Array.isArray(items) || !items.length) throw new Error(`No Moneycontrol match found for ${query}`);

  const best = [...items]
    .map(item => ({ ...item, _score: scoreMoneycontrolCandidate(query, item) }))
    .sort((a, b) => b._score - a._score)[0];

  const parsed = parseMoneycontrolInstrument(best);
  if (!parsed.google_code && !parsed.bse_code) throw new Error(`Moneycontrol did not return codes for ${query}`);
  return parsed;
}

function extractScreenerCode(url) {
  const match = String(url || "").match(/\/company\/([^\/]+)\//i);
  return match ? match[1].toUpperCase() : null;
}

function scoreScreenerCandidate(query, item) {
  const cleanedQuery = cleanLookupText(query);
  const queryTokens = cleanedQuery.split(" ").filter(Boolean);
  const candidateName = cleanLookupText(item.name);
  const candidateCode = extractScreenerCode(item.url) || "";
  let score = 0;
  if (candidateCode === cleanedQuery.replace(/\s+/g, "")) score += 120;
  if (candidateName === cleanedQuery) score += 100;
  if (candidateName.includes(cleanedQuery)) score += 60;
  if (queryTokens.length && queryTokens.every(tok => candidateName.includes(tok))) score += 30;
  if (candidateCode && queryTokens.some(tok => candidateCode.includes(tok))) score += 10;
  return score;
}

async function resolveInstrument(rawTicker) {
  const query = String(rawTicker || "").trim();
  if (!query) return null;
  const cacheKey = cleanLookupText(query) || query.toUpperCase();
  const cached = instrumentCache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) return cached.data;

  const moneycontrolHit = resolveMoneycontrolPriority(query);
  if (moneycontrolHit) {
    instrumentCache[cacheKey] = { data: moneycontrolHit, cachedAt: Date.now() };
    return moneycontrolHit;
  }

  try {
    const moneycontrolLive = await resolveViaMoneycontrol(query);
    instrumentCache[cacheKey] = { data: moneycontrolLive, cachedAt: Date.now() };
    return moneycontrolLive;
  } catch {}

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-IN,en;q=0.9",
  };

  const searchUrl = `https://www.screener.in/api/company/search/?q=${encodeURIComponent(query)}`;
  const searchRes = await axios.get(searchUrl, { headers, timeout: 12000 });
  const candidates = Array.isArray(searchRes.data) ? searchRes.data : [];
  if (!candidates.length) throw new Error(`No Screener match found for ${query}`);

  const best = [...candidates]
    .map(item => ({ ...item, _score: scoreScreenerCandidate(query, item) }))
    .sort((a, b) => b._score - a._score)[0];

  const screenerCode = extractScreenerCode(best.url) || query.toUpperCase();
  const detailUrl = `https://www.screener.in${best.url}`;
  const detailRes = await axios.get(detailUrl, {
    headers: { ...headers, Accept: "text/html,application/xhtml+xml" },
    timeout: 12000,
  });
  const html = String(detailRes.data || "");

  const nseMatch = html.match(/NSE:\s*<\/span>\s*([A-Z0-9\-]+)/i) || html.match(/NSE:\s*([A-Z0-9\-]+)/i);
  const bseMatch = html.match(/BSE:\s*<\/span>\s*([0-9]+)/i) || html.match(/BSE:\s*([0-9]+)/i);
  const titleMatch = html.match(/<title>([^<]+?)\s+share price/i);
  const companyName = (titleMatch ? titleMatch[1] : best.name || query).trim();
  const nseCode = nseMatch ? nseMatch[1].trim().toUpperCase() : null;
  const bseCode = bseMatch ? bseMatch[1].trim() : null;
  const ticker = (nseCode || screenerCode || query).toUpperCase();
  const exchange = nseCode ? "NSE" : (bseCode ? "BSE" : null);
  const googleCode = nseCode ? `NSE:${nseCode}` : (bseCode ? `BOM:${bseCode}` : `NSE:${ticker}`);

  const data = {
    ticker,
    company_name: companyName,
    exchange,
    google_code: googleCode,
    bse_code: bseCode,
    nse_code: nseCode,
  };
  instrumentCache[cacheKey] = { data, cachedAt: Date.now() };
  return data;
}

function parseGoogleFinanceQuote(html, googleCode, fallbackTicker) {
  const exchangeMatch = html.match(/data-exchange="([^"]+)"/i);
  const priceMatch = html.match(/data-last-price="([^"]+)"/i);
  const titleMatch = html.match(/<title>([^<(]+?)\s+\([^)]+\)\s+Stock Price/i);
  const pctLabel = html.match(/aria-label="(Up|Down) by ([0-9.,]+)%"/i);
  const changeMatch = html.match(/aria-label="(?:Up|Down) by [0-9.,]+%".*?<span class="P2Luy[^"]*">([+-]?[₹0-9,.\-]+)/is);
  const prevCloseMatch = html.match(/Previous close<\/div><div class="P6K39c">₹?([0-9,.\-]+)/i);
  const yearRangeMatch = html.match(/Year range<\/div><div class="P6K39c">₹?([0-9,.\-]+)\s*-\s*₹?([0-9,.\-]+)/i);

  const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : 0;
  if (!price) throw new Error(`No price found on Google Finance for ${googleCode}`);

  const sign = pctLabel && /down/i.test(pctLabel[1]) ? -1 : 1;
  const changePct = pctLabel ? sign * parseFloat(pctLabel[2].replace(/,/g, "")) : 0;
  const change = changeMatch ? parseFloat(changeMatch[1].replace(/[₹,]/g, "")) : 0;
  const prevClose = prevCloseMatch ? parseFloat(prevCloseMatch[1].replace(/,/g, "")) : (change ? price - change : 0);
  const week52High = yearRangeMatch ? parseFloat(yearRangeMatch[2].replace(/,/g, "")) : price;
  const [, fallbackExchange = "NSE", fallbackSymbol = fallbackTicker] = String(googleCode).match(/^([A-Z]+):(.+)$/i) || [];

  return {
    ticker: fallbackSymbol,
    name: titleMatch ? titleMatch[1].trim() : fallbackTicker,
    exchange: exchangeMatch ? exchangeMatch[1].trim().toUpperCase() : fallbackExchange.toUpperCase(),
    price,
    prevClose,
    change,
    changePct: Number.isFinite(changePct) ? +changePct.toFixed(2) : 0,
    week52High,
    ath: week52High || price,
    googleCode,
    cachedAt: Date.now(),
  };
}

async function fetchPrice(ticker, opts = {}) {
  const googleCode = opts.googleCode || `NSE:${ticker}`;
  const cacheKey = googleCode.toUpperCase();
  const cached = priceCache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached;

  const url = `https://www.google.com/finance/quote/${encodeURIComponent(googleCode)}?hl=en`;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: {
          "User-Agent": attempt % 2
            ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-IN,en;q=0.9",
          "Referer": "https://www.google.com/finance/",
          "Cache-Control": "no-cache",
        },
        timeout: 12000,
      });
      const result = parseGoogleFinanceQuote(String(res.data || ""), googleCode, ticker);
      result.ticker = ticker;
      if (opts.companyName && !result.name) result.name = opts.companyName;
      if (opts.bseCode) result.bse_code = opts.bseCode;
      priceCache[cacheKey] = result;
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 700 * attempt));
      }
    }
  }

  throw lastErr || new Error(`Unable to fetch price for ${ticker}`);
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
  res.json({ success:true, user: req.user.dbUser });
});

// ─────────────────────────────────────────
// ROUTES — PRICE  (one ticker at a time, called by frontend async)
// GET /api/price/:ticker
// ─────────────────────────────────────────
app.get("/api/price/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    let saved = null;
    const authHeader = (req.headers.authorization || "").replace("Bearer ", "");
    if (authHeader) {
      try {
        const decoded = jwt.verify(authHeader, JWT_SECRET);
        const user = db.prepare("SELECT id FROM users WHERE id=?").get(decoded.id);
        if (user) {
          saved = db.prepare("SELECT ticker, company_name, google_code, bse_code FROM portfolio WHERE user_id=? AND ticker=?").get(user.id, ticker)
            || db.prepare("SELECT ticker, company_name, google_code, bse_code FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at DESC LIMIT 1").get(user.id, ticker);
        }
      } catch {}
    }
    const data = await fetchPrice(ticker, {
      googleCode: saved?.google_code || `NSE:${ticker}`,
      companyName: saved?.company_name || ticker,
      bseCode: saved?.bse_code || null,
    });
    res.json({ success:true, data });
  } catch (err) {
    // Return partial data so frontend can still show the holding without CMP
    res.json({ success:false, ticker, error:err.message });
  }
});

// GET /api/stock/:ticker/sip  (used in SIP tab — needs price)
app.get("/api/stock/:ticker/sip", async (req, res) => {
  try {
    const ticker  = req.params.ticker.toUpperCase();
    let saved = null;
    const authHeader = (req.headers.authorization || "").replace("Bearer ", "");
    let userId = null;
    if (authHeader) {
      try {
        const decoded = jwt.verify(authHeader, JWT_SECRET);
        const user = db.prepare("SELECT id FROM users WHERE id=?").get(decoded.id);
        if (user) userId = user.id;
      } catch {}
    }
    if (userId) {
      saved = db.prepare("SELECT ticker, company_name, google_code, bse_code FROM portfolio WHERE user_id=? AND ticker=?").get(userId, ticker);
    }
    const stock   = await fetchPrice(ticker, {
      googleCode: saved?.google_code || `NSE:${ticker}`,
      companyName: saved?.company_name || ticker,
      bseCode: saved?.bse_code || null,
    });
    const cfg     = userId ? getOrSeedSIP(userId) : { max_budget: 50000, levels: JSON.stringify([
      {fall:-10,allocation:10},{fall:-15,allocation:5},{fall:-20,allocation:20},
      {fall:-25,allocation:10},{fall:-30,allocation:30},{fall:-35,allocation:15},{fall:-40,allocation:10}
    ]) };
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
    const saved = db.prepare("SELECT company_name, google_code, bse_code FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker)
      || trades.find(Boolean);
    try {
      livePrice = (await fetchPrice(ticker, {
        googleCode: saved?.google_code || `NSE:${ticker}`,
        companyName: saved?.company_name || ticker,
        bseCode: saved?.bse_code || null,
      })).price;
    } catch {}

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
  const { ticker, shares, avg_price, notes, company_name, exchange, google_code, bse_code } = req.body;
  if (!ticker||!shares||!avg_price) return res.status(400).json({ success:false, error:"ticker, shares, avg_price required" });
  const r = db.prepare("INSERT OR IGNORE INTO portfolio (user_id,ticker,company_name,exchange,google_code,bse_code,shares,avg_price,notes) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(req.user.id, ticker.toUpperCase(), company_name || null, exchange || null, google_code || null, bse_code || null, shares, avg_price, notes||null);
  res.json({ success:true, id:r.lastInsertRowid });
});

app.put("/api/portfolio/:id", auth, (req, res) => {
  const {shares,avg_price,notes,company_name,exchange,google_code,bse_code}=req.body;
  db.prepare("UPDATE portfolio SET shares=?,avg_price=?,notes=?,company_name=COALESCE(?,company_name),exchange=COALESCE(?,exchange),google_code=COALESCE(?,google_code),bse_code=COALESCE(?,bse_code) WHERE id=? AND user_id=?")
    .run(shares,avg_price,notes,company_name||null,exchange||null,google_code||null,bse_code||null,req.params.id,req.user.id);
  res.json({ success:true });
});

app.delete("/api/portfolio/:id", auth, (req, res) => {
  db.prepare("DELETE FROM portfolio WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success:true });
});

// ─────────────────────────────────────────
// ROUTES — TRADES
// ─────────────────────────────────────────
function _syncPortfolio(uid, ticker, type, shares, price, meta = {}) {
  const ex = db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker);
  if (type === "BUY") {
    if (ex) {
      const ns = ex.shares + shares;
      const np = ((ex.avg_price * ex.shares) + (price * shares)) / ns;
      db.prepare("UPDATE portfolio SET shares=?,avg_price=?,company_name=COALESCE(?,company_name),exchange=COALESCE(?,exchange),google_code=COALESCE(?,google_code),bse_code=COALESCE(?,bse_code) WHERE user_id=? AND ticker=?")
        .run(+ns.toFixed(4), +np.toFixed(4), meta.company_name || null, meta.exchange || null, meta.google_code || null, meta.bse_code || null, uid, ticker);
    } else {
      db.prepare("INSERT INTO portfolio (user_id,ticker,company_name,exchange,google_code,bse_code,shares,avg_price) VALUES (?,?,?,?,?,?,?,?)")
        .run(uid, ticker, meta.company_name || null, meta.exchange || null, meta.google_code || null, meta.bse_code || null, shares, price);
    }
  }
  if (type === "SELL" && ex) {
    const ns = ex.shares - shares;
    if (ns <= 0.0001) db.prepare("DELETE FROM portfolio WHERE user_id=? AND ticker=?").run(uid, ticker);
    else db.prepare("UPDATE portfolio SET shares=?,company_name=COALESCE(?,company_name),exchange=COALESCE(?,exchange),google_code=COALESCE(?,google_code),bse_code=COALESCE(?,bse_code) WHERE user_id=? AND ticker=?")
      .run(+ns.toFixed(4), meta.company_name || null, meta.exchange || null, meta.google_code || null, meta.bse_code || null, uid, ticker);
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
  const { ticker, type, shares, price, notes, traded_at, company_name, exchange, google_code, bse_code } = req.body;
  if (!ticker||!type||!shares||!price) return res.status(400).json({ success:false, error:"ticker, type, shares, price required" });
  const uid=req.user.id, amount=shares*price, tradeDate=traded_at||new Date().toISOString();
  const meta = { company_name, exchange, google_code, bse_code };
  const r=db.prepare("INSERT INTO trade_history (user_id,ticker,company_name,exchange,google_code,bse_code,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(uid,ticker.toUpperCase(),company_name||null,exchange||null,google_code||null,bse_code||null,type.toUpperCase(),shares,price,amount,notes||null,tradeDate);
  _syncPortfolio(uid, ticker.toUpperCase(), type.toUpperCase(), shares, price, meta);
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
app.post("/api/trades/preview", auth, upload.array("files", 20), async (req, res) => {
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
  const metaByTicker = {};
  for (const ticker of [...new Set(allTrades.map(t => t.ticker).filter(Boolean))]) {
    try { metaByTicker[ticker] = await resolveInstrument(ticker); }
    catch (e) { allErrors.push(`[${ticker}] Code lookup failed: ${e.message}`); }
  }
  allTrades = allTrades.map(t => ({ ...metaByTicker[t.ticker], ...t, ticker: (metaByTicker[t.ticker]?.ticker || t.ticker).toUpperCase() }));
  res.json({ success:true, trades:allTrades, errors:allErrors, total:allTrades.length });
});

app.post("/api/trades/import", auth, async (req, res) => {
  const { trades } = req.body;
  if (!trades?.length) return res.status(400).json({ success:false, error:"No trades provided" });
  const uid=req.user.id; let imported=0, skipped=0; const importErrors=[];
  const metaByTicker = {};
  for (const ticker of [...new Set(trades.map(t => t.ticker).filter(Boolean))]) {
    const existing = trades.find(t => t.ticker === ticker && (t.google_code || t.company_name || t.bse_code || t.exchange));
    if (existing) {
      metaByTicker[ticker] = {
        ticker: ticker.toUpperCase(),
        company_name: existing.company_name || null,
        exchange: existing.exchange || null,
        google_code: existing.google_code || null,
        bse_code: existing.bse_code || null,
      };
      continue;
    }
    try { metaByTicker[ticker] = await resolveInstrument(ticker); }
    catch (e) { importErrors.push(`[${ticker}] Code lookup failed: ${e.message}`); }
  }
  const doImport=db.transaction(()=>{
    for (const t of trades) {
      try {
        if (!t.ticker||!t.type||!t.shares||!t.price) throw new Error("missing fields");
        const meta = { ...(metaByTicker[t.ticker] || {}), company_name: t.company_name || metaByTicker[t.ticker]?.company_name || null, exchange: t.exchange || metaByTicker[t.ticker]?.exchange || null, google_code: t.google_code || metaByTicker[t.ticker]?.google_code || null, bse_code: t.bse_code || metaByTicker[t.ticker]?.bse_code || null };
        const finalTicker = (meta.ticker || t.ticker).toUpperCase();
        db.prepare("INSERT INTO trade_history (user_id,ticker,company_name,exchange,google_code,bse_code,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(uid,finalTicker,meta.company_name,meta.exchange,meta.google_code,meta.bse_code,t.type.toUpperCase(),t.shares,t.price,t.amount,t.notes||null,t.traded_at||new Date().toISOString());
        _syncPortfolio(uid, finalTicker, t.type.toUpperCase(), t.shares, t.price, meta);
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
