const express  = require("express");
const cors     = require("cors");
const { createClient } = require("@libsql/client");
const axios    = require("axios");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const multer   = require("multer");
const XLSX     = require("xlsx");
const fs       = require("fs");
const path     = require("path");
const adminPageHtml = require("./admin-page");
const { matchStock, changeStockCode } = require('./stock-code-settings');
const { validateTradeNumbers } = require('./trade-validation');
const { validateSIPConfig } = require('./sip-config-validation');
const { createWatchlistCronHandler } = require('./watchlist-scheduler');

const app = express();
function firstNonEmptyEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
const tursoUrl = firstNonEmptyEnv(
  "ONEPIECE_TURSO_DATABASE_URL",
  "TURSO_DATABASE_URL",
  "LIBSQL_DATABASE_URL"
);
const tursoAuthToken = firstNonEmptyEnv(
  "ONEPIECE_TURSO_AUTH_TOKEN",
  "TURSO_AUTH_TOKEN",
  "LIBSQL_AUTH_TOKEN"
);
if (!tursoUrl) {
  throw new Error("Turso is required. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.");
}
const remoteDb = createClient({ url: tursoUrl, authToken: tursoAuthToken || undefined });
let dbReady = Promise.resolve();

const JWT_SECRET = process.env.JWT_SECRET || "onepiece_secret_change_in_prod";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@onepiece").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "treasure@onepiece";
const ADMIN_TABLES = new Set(["users", "portfolio", "watchlist", "sip_config", "trade_history"]);
const upload     = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: "5mb" }));
// Explicit reads let the serverless bundler include these shared UI assets.
const responsiveCss = fs.readFileSync(path.join(__dirname, "responsive.css"), "utf8");
const responsiveJs = fs.readFileSync(path.join(__dirname, "responsive.js"), "utf8");
// Serve the self-contained validator from the loaded module: bundlers may inline
// required JS modules rather than retain their original source files on disk.
const sipValidationJs = `globalThis.validateSIPConfig = ${validateSIPConfig.toString()};`;
app.get("/sip-config-validation.js", (req, res) => res.set("Cache-Control", "no-cache").type("js").send(sipValidationJs));
app.get("/responsive.css", (req, res) => res.set("Cache-Control", "no-cache").type("css").send(responsiveCss));
app.get("/responsive.js", (req, res) => res.set("Cache-Control", "no-cache").type("js").send(responsiveJs));
app.use(express.static(path.join(__dirname)));
app.get("/", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const html = fs.readFileSync(path.join(__dirname, "onepiece.html"), "utf8");
    const row = await db.prepare("SELECT COUNT(*) AS count FROM users").get();
    res.send(html.replaceAll("{{USER_COUNT}}", String(Number(row?.count || 0))));
  } catch (err) {
    res.status(500).send(String(err.message || err));
  }
});
function sendNoCacheHtml(res, filename) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const html = fs.readFileSync(path.join(__dirname, filename), "utf8");
  res.type("html").send(html);
}

app.get(["/admin", "/admin.html"], async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.type("html").send(adminPageHtml());
  } catch (err) {
    res.status(500).send(String(err.message || err));
  }
});

app.get("/admin/", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.type("html").send(adminPageHtml());
  } catch (err) {
    res.status(500).send(String(err.message || err));
  }
});
function toJsValue(value) {
  if (typeof value === "bigint") return Number(value);
  return value;
}

function normalizeDbRows(result) {
  const columns = result?.columns || [];
  const rows = result?.rows || [];
  return rows.map(row => {
    if (row && typeof row === "object" && !Array.isArray(row) && !("length" in row)) {
      const out = {};
      for (const key of columns) out[key] = toJsValue(row[key]);
      return out;
    }
    const out = {};
    for (let i = 0; i < columns.length; i++) out[columns[i]] = toJsValue(row?.[i]);
    return out;
  });
}

async function execRaw(sql) {
  return remoteDb.execute(sql);
}

async function allRaw(sql, params = []) {
  return normalizeDbRows(await remoteDb.execute({ sql, args: params }));
}

async function getRaw(sql, params = []) {
  const rows = await allRaw(sql, params);
  return rows[0];
}

async function runRaw(sql, params = []) {
  const result = await remoteDb.execute({ sql, args: params });
  return {
    changes: Number(result.rowsAffected || 0),
    lastInsertRowid: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : undefined,
  };
}

async function transactionRaw(fn) {
  const tx = await remoteDb.transaction("write");
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch {}
    throw err;
  } finally {
    tx.close();
  }
}

const dbRaw = {
  prepare: (sql) => ({
    get: async (...params) => getRaw(sql, params),
    all: async (...params) => allRaw(sql, params),
    run: async (...params) => runRaw(sql, params),
  }),
};

const db = {
  exec: async (sql) => { await dbReady; return execRaw(sql); },
  prepare: (sql) => ({
    get: async (...params) => { await dbReady; return getRaw(sql, params); },
    all: async (...params) => { await dbReady; return allRaw(sql, params); },
    run: async (...params) => { await dbReady; return runRaw(sql, params); },
  }),
  transaction: (fn) => async (...args) => { await dbReady; return transactionRaw(() => fn(...args)); },
};

// ─────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────
dbReady = (async () => {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    UNIQUE NOT NULL,
      password   TEXT    NOT NULL,
      name       TEXT,
      created_at TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS portfolio (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      ticker     TEXT    NOT NULL,
      shares     REAL    NOT NULL,
      avg_price  REAL    NOT NULL,
      notes      TEXT,
      added_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE(user_id, ticker)
    )`,
    `CREATE TABLE IF NOT EXISTS watchlist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      ticker     TEXT    NOT NULL,
      added_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE(user_id, ticker)
    )`,
    `CREATE TABLE IF NOT EXISTS sip_config (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      max_budget REAL    NOT NULL DEFAULT 50000,
      levels     TEXT    NOT NULL,
      updated_at TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS trade_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      exchange   TEXT    NOT NULL DEFAULT '',
      ticker     TEXT    NOT NULL,
      type       TEXT    NOT NULL CHECK(type IN ('BUY','SELL')),
      shares     REAL    NOT NULL,
      price      REAL    NOT NULL,
      amount     REAL    NOT NULL,
      notes      TEXT,
      traded_at  TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS opportunity_selection (
      user_id INTEGER NOT NULL REFERENCES users(id),
      ticker TEXT NOT NULL,
      selected_levels TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY(user_id, ticker)
    )`,
  ];
  for (const statement of statements) {
    await execRaw(statement);
  }
  const tradeColumns = await allRaw("PRAGMA table_info(trade_history)");
  const portfolioColumns = await allRaw('PRAGMA table_info(portfolio)');
  for (const column of ['stock_name', 'ok_code']) {
    if (!tradeColumns.some(c => c.name === column)) await execRaw(`ALTER TABLE trade_history ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    if (!portfolioColumns.some(c => c.name === column)) await execRaw(`ALTER TABLE portfolio ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  }
  if (!tradeColumns.some(c => c.name === "exchange")) {
    await execRaw("ALTER TABLE trade_history ADD COLUMN exchange TEXT NOT NULL DEFAULT ''");
  }
  const tradeRows = await allRaw("SELECT id, ticker, exchange FROM trade_history");
  for (const row of tradeRows) {
    if (row.exchange && String(row.exchange).trim()) continue;
    const exchange = deriveExchangeFromTicker(row.ticker);
    if (exchange) await runRaw("UPDATE trade_history SET exchange=? WHERE id=?", [exchange, row.id]);
  }

  const watchlistColumns = await allRaw("PRAGMA table_info(watchlist)");
  const watchlistColumnNames = new Set(watchlistColumns.map(c => c.name));
  async function ensureWatchlistColumn(name, definitionSql) {
    if (watchlistColumnNames.has(name)) return;
    await execRaw(`ALTER TABLE watchlist ADD COLUMN ${name} ${definitionSql}`);
    watchlistColumnNames.add(name);
  }
  await ensureWatchlistColumn("code", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("stock_code", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("name", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("cmp", "REAL");
  await ensureWatchlistColumn("change", "REAL");
  await ensureWatchlistColumn("week52_high", "REAL");
  await ensureWatchlistColumn("ath", "REAL");
  await ensureWatchlistColumn("ath_date", "TEXT");
  await ensureWatchlistColumn("price_as_of", "TEXT");
  await ensureWatchlistColumn("quote_fetched_at", "TEXT");
  await ensureWatchlistColumn("quote_error", "TEXT");
  await ensureWatchlistColumn("pe", "REAL");
  await ensureWatchlistColumn("source", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("raw_json", "TEXT");
  await ensureWatchlistColumn("updated_at", "TEXT");

  const systemPasswordHash = await bcrypt.hash(`${JWT_SECRET}:onepiece-system`, 10);
  await runRaw(
    "INSERT OR IGNORE INTO users (email,password,name) VALUES (?,?,?)",
    [ONEPIECE_SYSTEM_EMAIL, systemPasswordHash, ONEPIECE_SYSTEM_NAME]
  );
  await _rebuildAllPortfolios(dbRaw);
})();

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); req.user.role = req.user.role || "user"; next(); }
  catch { res.status(401).json({ success: false, error: "Invalid or expired token" }); }
}

function adminAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ success: false, error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (req.user.role !== "admin") return res.status(403).json({ success: false, error: "Admin access required" });
    next();
  } catch {
    res.status(401).json({ success: false, error: "Invalid or expired token" });
  }
}

function signUserToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: "user" }, JWT_SECRET, { expiresIn: "30d" });
}

function signAdminToken() {
  return jwt.sign({ role: "admin", email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: "30d" });
}

async function getTableColumns(table) {
  if (!ADMIN_TABLES.has(table)) throw new Error("Invalid table");
  return await allRaw(`PRAGMA table_info("${table}")`);
}

function coerceByColumn(column, value, table) {
  if (table === "users" && column === "password") return value;
  if (value === "" || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return Number(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

async function buildAdminPayload(table, body, isInsert=false) {
  const cols = await getTableColumns(table);
  const allowed = new Set(cols.map(c => c.name));
  const payload = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (key === "id" || key === "new_password") continue;
    if (!allowed.has(key)) continue;
    if (table === "users" && key === "password") continue;
    payload[key] = coerceByColumn(key, value, table);
  }
  if (table === "users" && body?.new_password) {
    payload.password = await bcrypt.hash(String(body.new_password), 10);
  }
  if (isInsert && table === "users" && body?.password && !payload.password) {
    payload.password = await bcrypt.hash(String(body.password), 10);
  }
  return payload;
}

function sanitizeDbUrl(dbUrl) {
  try {
    const url = new URL(dbUrl);
    return {
      protocol: url.protocol,
      host: url.host,
      pathname: url.pathname,
      database: url.pathname.replace(/^\//, ""),
    };
  } catch {
    return { value: String(dbUrl || "") };
  }
}

async function getAdminTableCounts() {
  const counts = {};
  for (const table of ADMIN_TABLES) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
    counts[table] = Number(row?.count || 0);
  }
  return counts;
}

async function getOrSeedSIP(userId) {
  let cfg = await db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
  if (!cfg) {
    await db.prepare("INSERT INTO sip_config (user_id, max_budget, levels) VALUES (?,?,?)").run(userId, 50000,
      JSON.stringify([
        {fall:-10,allocation:10},{fall:-15,allocation:5},{fall:-20,allocation:20},
        {fall:-25,allocation:10},{fall:-30,allocation:30},{fall:-35,allocation:15},{fall:-40,allocation:10}
      ])
    );
    cfg = await db.prepare("SELECT * FROM sip_config WHERE user_id=? ORDER BY id DESC LIMIT 1").get(userId);
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

// PRICE FETCH (Google Sheets only + cache)
const priceCache = {};
const CACHE_TTL  = 5 * 60 * 1000;
const ONEPIECE_SYSTEM_EMAIL = (process.env.ONEPIECE_SYSTEM_EMAIL || "__onepiece_system__@onepiece.local").toLowerCase();
const ONEPIECE_SYSTEM_NAME = process.env.ONEPIECE_SYSTEM_NAME || "OnePiece System";
const GOOGLE_SHEETS_CSV_URL = process.env.GOOGLE_SHEETS_CSV_URL || process.env.GOOGLE_SHEETS_URL || '';
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '';
const GOOGLE_SHEETS_GID = process.env.GOOGLE_SHEETS_GID || process.env.GOOGLE_SHEET_GID || '';
let onepieceSystemUserIdPromise = null;

async function getOnepieceSystemUserId() {
  if (onepieceSystemUserIdPromise) return onepieceSystemUserIdPromise;
  onepieceSystemUserIdPromise = (async () => {
    let row = await db.prepare("SELECT id FROM users WHERE email=? LIMIT 1").get(ONEPIECE_SYSTEM_EMAIL);
    if (!row?.id) {
      const passwordHash = await bcrypt.hash(`${JWT_SECRET}:onepiece-system`, 10);
      try {
        await db.prepare("INSERT INTO users (email,password,name) VALUES (?,?,?)").run(
          ONEPIECE_SYSTEM_EMAIL,
          passwordHash,
          ONEPIECE_SYSTEM_NAME
        );
      } catch (err) {
        const message = String(err?.message || "");
        if (!message.includes("UNIQUE constraint failed")) throw err;
      }
      row = await db.prepare("SELECT id FROM users WHERE email=? LIMIT 1").get(ONEPIECE_SYSTEM_EMAIL);
    }
    if (!row?.id) throw new Error("Failed to initialize OnePiece system user");
    return Number(row.id);
  })();

  try {
    return await onepieceSystemUserIdPromise;
  } catch (err) {
    onepieceSystemUserIdPromise = null;
    throw err;
  }
}

function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeHeaderName(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTickerValue(value) {
  return String(value || '')
    .toUpperCase()
    .trim()
    .replace(/^(NSE|BSE|BOM|BO|NS):/i, '')
    .replace(/\s+/g, ' ');
}

function getGoogleSheetsSourceUrl(outputFormat = 'csv') {
  const source = GOOGLE_SHEETS_CSV_URL;
  if (source) {
    const normalized = String(source).trim();
    try {
      const url = new URL(normalized);
      if (/\/pubhtml$/i.test(url.pathname) || /\/pub$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/pubhtml$/i, '/pub').replace(/\/pub$/i, '/pub');
        url.searchParams.set('output', outputFormat);
        return url.toString();
      }
      return normalized;
    } catch {
      if (/\/pubhtml(\?.*)?$/i.test(normalized)) return normalized.replace(/\/pubhtml(\?.*)?$/i, `/pub?output=${encodeURIComponent(outputFormat)}`);
      if (/\/pub(\?.*)?$/i.test(normalized) && !new RegExp(`[?&]output=${outputFormat}`, 'i').test(normalized)) {
        return `${normalized}${normalized.includes('?') ? '&' : '?'}output=${encodeURIComponent(outputFormat)}`;
      }
      return normalized;
    }
  }
  if (!GOOGLE_SHEETS_ID) return null;
  const gidPart = GOOGLE_SHEETS_GID ? `&gid=${encodeURIComponent(GOOGLE_SHEETS_GID)}` : '';
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(GOOGLE_SHEETS_ID)}/export?format=${encodeURIComponent(outputFormat)}${gidPart}`;
}

function getSheetCell(row, candidates) {
  if (!Array.isArray(row)) return null;
  for (const idx of candidates) {
    if (idx >= 0 && idx < row.length) {
      const value = row[idx];
      if (value !== undefined && value !== null && String(value).trim() !== '') return value;
    }
  }
  return null;
}

function normalizeExchangeCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return '';
  if (raw === 'NS' || raw === 'NSE') return 'NSE';
  if (raw === 'BO' || raw === 'BOM') return 'BOM';
  if (raw === 'BSE') return 'BSE';
  return raw;
}

function splitTradeSymbol(rawTicker, exchangeHint = '') {
  const raw = String(rawTicker || '').trim().toUpperCase();
  const match = raw.match(/^(NSE|BSE|BOM|BO|NS)\s*[:\-]\s*(.+)$/i);
  if (match) {
    const exchange = normalizeExchangeCode(match[1]);
    const symbol = match[2].trim().replace(/\s+/g, ' ');
    return { exchange, ticker: `${exchange}:${symbol}`, symbol };
  }

  const exchange = normalizeExchangeCode(exchangeHint);
  if (exchange) {
    const symbol = raw.replace(/^(NSE|BSE|BOM|BO|NS)\s*[:\-]\s*/i, '').trim().replace(/\s+/g, ' ');
    return { exchange, ticker: `${exchange}:${symbol || raw}`, symbol: symbol || raw };
  }

  return { exchange: '', ticker: raw, symbol: raw };
}

function deriveExchangeFromTicker(ticker) {
  const match = String(ticker || '').toUpperCase().match(/^(NSE|BSE|BOM|BO|NS)\s*[:\-]/);
  return match ? normalizeExchangeCode(match[1]) : '';
}

async function fetchGoogleSheetRows() {
  const source = String(GOOGLE_SHEETS_CSV_URL || '').trim();
  const preferXlsx = !!source && /docs\.google\.com\/spreadsheets\/d\/e\//i.test(source) && /\/pub(html)?/i.test(source);
  const requestUrl = getGoogleSheetsSourceUrl(preferXlsx ? 'xlsx' : 'csv');
  if (!requestUrl) throw new Error('Google Sheets source is not configured');

  if (preferXlsx) {
    const res = await axios.get(requestUrl, {
      headers: {
        Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
        'User-Agent': 'Mozilla/5.0',
      },
      responseType: 'arraybuffer',
      timeout: 15000,
    });
    const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
    if (!buf.length) throw new Error('Google Sheets XLSX export returned empty data');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  }

  const res = await axios.get(requestUrl, {
    headers: {
      Accept: 'text/csv,text/plain,*/*',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 15000,
  });

  const csvText = typeof res.data === 'string' ? res.data : String(res.data || '');
  if (!csvText.trim()) throw new Error('Google Sheets returned an empty file');
  const wb = XLSX.read(csvText, { type: 'string' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
}

function pickSheetCellByHeaders(row, headerIndex, candidates) {
  for (const candidate of candidates) {
    const idx = headerIndex[candidate];
    if (idx === undefined) continue;
    const value = String(row[idx] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function parseOnepieceWatchlistRows(rows) {
  if (!rows.length) throw new Error('Google Sheets does not contain any rows');
  const headerRowIndex = rows.findIndex(row => Array.isArray(row) && row.some(cell => String(cell || '').trim() !== ''));
  if (headerRowIndex < 0) throw new Error('Google Sheets is missing a header row');

  const rawHeaders = rows[headerRowIndex].map(v => String(v || '').trim());
  const headers = rawHeaders.map((h, i) => h || `Column ${i + 1}`);
  const normalizedHeaders = headers.map(normalizeHeaderName);
  const headerIndex = {};
  normalizedHeaders.forEach((h, i) => { if (h && headerIndex[h] === undefined) headerIndex[h] = i; });

  const parsedRows = [];
  const dataRows = [];
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];
    const values = headers.map((_, idx) => String(row[idx] ?? '').trim());
    if (!values.some(Boolean)) continue;
    dataRows.push(values);

    const stockCode = pickSheetCellByHeaders(values, headerIndex, ['stock_code', 'stockcode', 'ticker', 'symbol', 'stock_symbol']);
    const code = pickSheetCellByHeaders(values, headerIndex, ['code', 'scrip_code', 'security_code']);
    const name = pickSheetCellByHeaders(values, headerIndex, ['name', 'company', 'company_name', 'security_name', 'stock_name']);
    const cmpText = pickSheetCellByHeaders(values, headerIndex, ['cmp', 'price', 'ltp', 'last_price', 'lastprice', 'close', 'closing_price']);
    const changeText = pickSheetCellByHeaders(values, headerIndex, ['change', 'net_change', 'day_change']);
    const weekHighText = pickSheetCellByHeaders(values, headerIndex, ['week_52_high', 'week52_high', '52_week_high', 'high_52_week', 'high_52w', 'fifty_two_week_high']);
    const athText = pickSheetCellByHeaders(values, headerIndex, ['ath', 'all_time_high', 'alltimehigh']) || weekHighText;
    const athDateText = pickSheetCellByHeaders(values, headerIndex, ['ath_date', 'all_time_high_date', 'alltimehighdate', 'date_of_ath']);
    const peText = pickSheetCellByHeaders(values, headerIndex, ['pe', 'p_e', 'pe_ratio', 'price_earning_ratio']);

    const ticker = normalizeTickerValue(stockCode || code || name);
    if (!ticker) continue;

    const rawObj = {};
    headers.forEach((header, idx) => { rawObj[header] = values[idx] ?? ''; });
    parsedRows.push({
      ticker,
      code: String(code || '').trim().toUpperCase(),
      stock_code: String(stockCode || '').trim().toUpperCase(),
      name: String(name || ticker).trim(),
      cmp: parseNumber(cmpText),
      change: parseNumber(changeText),
      week52_high: parseNumber(weekHighText),
      ath: parseNumber(athText),
      ath_date: athDateText || null,
      pe: parseNumber(peText),
      source: 'ONEPIECE_SHEET',
      raw_json: JSON.stringify(rawObj),
    });
  }

  return { headers, dataRows, parsedRows };
}

async function fetchGoogleSheetTableData() {
  const rows = await fetchGoogleSheetRows();
  const { headers, dataRows } = parseOnepieceWatchlistRows(rows);
  return {
    headers,
    rows: dataRows,
    total: dataRows.length,
  };
}

async function syncOnepieceWatchlistTable() {
  const systemUserId = Number(await getOnepieceSystemUserId());
  if (!Number.isFinite(systemUserId) || systemUserId <= 0) {
    throw new Error("Failed to resolve OnePiece system user");
  }
  const rows = await fetchGoogleSheetRows();
  const { parsedRows } = parseOnepieceWatchlistRows(rows);
  const dedupByTicker = new Map();
  for (const item of parsedRows) dedupByTicker.set(item.ticker, item);
  const finalRows = Array.from(dedupByTicker.values());
  if(!finalRows.length)throw new Error('Google Sheets returned no valid stocks; existing watchlist retained.');

  await transactionRaw(async (tx) => {
    await tx.execute({ sql: "DELETE FROM watchlist WHERE user_id=?", args: [systemUserId] });
    for (const row of finalRows) {
      await tx.execute({
        sql: "INSERT INTO watchlist (user_id,ticker,code,stock_code,name,cmp,change,week52_high,pe,source,raw_json,updated_at,added_at,ath,ath_date,price_as_of,quote_fetched_at,quote_error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        args: [
          systemUserId,
          row.ticker,
          row.code || '',
          row.stock_code || '',
          row.name || row.ticker,
          row.cmp,
          row.change,
          row.week52_high,
          row.pe,
          row.source,
          row.raw_json || null,
          new Date().toISOString(),
          new Date().toISOString(),
          row.ath ?? null,
          row.ath_date ?? null,
          row.price_as_of ?? null,
          row.quote_fetched_at ?? null,
          row.quote_error ?? null,
        ],
      });
    }
  });

  for (const key of Object.keys(priceCache)) delete priceCache[key];
  return { total: finalRows.length };
}

async function fetchPriceFromWatchlistTable(ticker) {
  const systemUserId = await getOnepieceSystemUserId();
  const targetTicker = normalizeTickerValue(ticker);
  const rawTicker = String(ticker || '').trim().toUpperCase();
  const row = await db.prepare(
    `SELECT ticker, code, stock_code, name, cmp, change, ath, ath_date, pe, source
     FROM watchlist
     WHERE user_id=? AND source='ONEPIECE_SHEET'
       AND (
         UPPER(ticker)=?
         OR UPPER(ticker)=?
         OR UPPER(stock_code)=?
         OR UPPER(code)=?
         OR UPPER(stock_code)=?
       )
     ORDER BY id DESC
     LIMIT 1`
  ).get(
    systemUserId,
    targetTicker,
    rawTicker,
    rawTicker,
    rawTicker,
    targetTicker
  );

  if (!row || row.cmp === null || row.cmp === undefined) {
    throw new Error(`No price found in watchlist table for ${ticker}`);
  }

  const price = Number(row.cmp);
  const dayChange = row.change === null || row.change === undefined ? 0 : Number(row.change);
  const prevClose = price - dayChange;
  const changePct = prevClose ? (dayChange / prevClose) * 100 : 0;
  return {
    ticker: targetTicker,
    name: row.name || row.stock_code || row.code || targetTicker,
    exchange: 'WATCHLIST',
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : 0,
    change: Number.isFinite(dayChange) ? dayChange : 0,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    ath: row.ath == null ? null : Number(row.ath),
    ath_date: row.ath_date || null,
    source: row.source || 'WATCHLIST_TABLE',
  };
}

async function fetchPriceFromGoogleSheets(ticker) {
  const rows = await fetchGoogleSheetRows();
  const { parsedRows } = parseOnepieceWatchlistRows(rows);
  const targetTicker = normalizeTickerValue(ticker);
  const matched = parsedRows.find(r => normalizeTickerValue(r.ticker) === targetTicker);
  if (!matched || matched.cmp === null || matched.cmp === undefined) {
    throw new Error(`No CMP found for ${ticker} in Google Sheets`);
  }
  const price = Number(matched.cmp);
  const dayChange = matched.change === null || matched.change === undefined ? 0 : Number(matched.change);
  const prevClose = price - dayChange;
  const changePct = prevClose ? (dayChange / prevClose) * 100 : 0;
  return {
    ticker: targetTicker,
    name: matched.name || targetTicker,
    exchange: 'SHEETS',
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : 0,
    change: Number.isFinite(dayChange) ? dayChange : 0,
    changePct: Number.isFinite(changePct) ? changePct : 0,
    ath: matched.ath,
    ath_date: matched.ath_date,
    source: 'GOOGLE_SHEETS',
  };
}

async function fetchPrice(ticker) {
  const cacheKey = `price:${normalizeTickerValue(ticker)}`;
  const cached = priceCache[cacheKey];
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached;

  let base;
  try {
    base = await fetchPriceFromWatchlistTable(ticker);
  } catch {
    base = await fetchPriceFromGoogleSheets(ticker);
  }
  const result = { ...base, cachedAt: Date.now() };
  priceCache[cacheKey] = result;
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
    const n = Number(String(v).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
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
      if (price === null || price < 0) { errors.push(`Row ${i+1} [${ticker}]: Invalid price "${row[iPrice]}"`); continue; }

      trades.push({ ticker, type:"BUY", shares:qty, price, amount:qty*price,
        traded_at:(date&&!isNaN(date))?date.toISOString():new Date().toISOString(),
        notes:price === 0 ? "Imported (Bonus shares — zero-cost BUY)" : "Imported (Scrips Bought)" });
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

      if (purPrice !== null && purPrice >= 0) {
        trades.push({ ticker, type:"BUY", shares:sellQty, price:purPrice, amount:sellQty*purPrice,
          traded_at:(purDate&&!isNaN(purDate))?purDate.toISOString():new Date().toISOString(),
          notes:purPrice === 0 ? "Imported (Bonus shares — original buy for sold lot)" : "Imported (original buy for sold lot)" });
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
  if (await db.prepare("SELECT id FROM users WHERE email=?").get(email.toLowerCase()))
    return res.status(400).json({ success:false, error:"Email already registered" });
  const hashed = await bcrypt.hash(password, 10);
  const result = await db.prepare("INSERT INTO users (email,password,name) VALUES (?,?,?)").run(email.toLowerCase(), hashed, name||email.split("@")[0]);
  const token  = signUserToken({ id: result.lastInsertRowid, email: email.toLowerCase() });
  res.json({ success:true, token, user:{ id:result.lastInsertRowid, email:email.toLowerCase(), name:name||email.split("@")[0] } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  const user = await db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ success:false, error:"Invalid email or password" });
  const token = signUserToken(user);
  res.json({ success:true, token, user:{ id:user.id, email:user.email, name:user.name } });
});

app.post("/api/auth/admin-login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  if (email.toLowerCase() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success:false, error:"Invalid admin credentials" });
  }
  const token = signAdminToken();
  res.json({ success:true, token, user:{ email: ADMIN_EMAIL, role: "admin", name: "OnePiece Admin" } });
});

app.get("/api/auth/admin-me", adminAuth, async (req, res) => {
  res.json({ success:true, user:{ email: ADMIN_EMAIL, role:"admin", name:"OnePiece Admin" } });
});

app.get("/api/auth/me", auth, async (req, res) => {
  const user = await db.prepare("SELECT id,email,name,created_at FROM users WHERE id=?").get(req.user.id);
  res.json({ success:true, user });
});

// ─────────────────────────────────────────
// ROUTES — PRICE  (one ticker at a time, called by frontend async)
// GET /api/price/:ticker
// ─────────────────────────────────────────
function logoutHtml(targetPath = "/#public-overview") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Logging out…</title>
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#080e14;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .card{max-width:520px;padding:28px 24px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.03);text-align:center}
    .title{font-size:20px;font-weight:700;margin-bottom:10px}
    .sub{font-size:14px;color:rgba(255,255,255,.7);line-height:1.6}
    .btn{display:inline-block;margin-top:18px;padding:10px 16px;border-radius:10px;background:linear-gradient(135deg,#00ffb4,#00bfff);color:#000;text-decoration:none;font-weight:700}
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Signing you out…</div>
    <div class="sub">Clearing local session data and taking you back to the public start page.</div>
    <a class="btn" href="${targetPath}">Continue</a>
  </div>
  <script>
    try {
      localStorage.removeItem('pf_token');
      localStorage.removeItem('pf_user');
      localStorage.removeItem('pf_admin_token');
      localStorage.removeItem('pf_admin_user');
      sessionStorage.clear();
    } catch (e) {}
    setTimeout(() => { location.replace(${JSON.stringify(targetPath)}); }, 150);
  </script>
</body>
</html>`;
}

app.get("/api/auth/logout", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Clear-Site-Data", '"storage"');
  res.json({ success: true, message: "Logout acknowledged. Visit /logout to clear browser storage and reset the UI." });
});

app.get("/logout", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Clear-Site-Data", '"storage"');
  res.type("html").send(logoutHtml("/#public-overview"));
});

app.get("/api/sheet/table", auth, async (req, res) => {
  try {
    const data = await fetchGoogleSheetTableData();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Failed to load Google Sheet table" });
  }
});

app.get("/api/watchlist/table", auth, async (req, res) => {
  try {
    const systemUserId = await getOnepieceSystemUserId();
    const rows = await db.prepare(
      `SELECT id,ticker,code,stock_code,name,cmp,change,ath,ath_date,pe,source,updated_at,price_as_of,quote_fetched_at,quote_error
       FROM watchlist
       WHERE user_id=?
       ORDER BY ticker ASC`
    ).all(systemUserId);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Failed to load watchlist table" });
  }
});

app.get("/api/cron/watchlist", createWatchlistCronHandler({db,sync:syncOnepieceWatchlistTable}));

app.post("/api/watchlist/sync", auth, async (req, res) => {
  try {
    const summary = await syncOnepieceWatchlistTable();
    const systemUserId = await getOnepieceSystemUserId();
    const rows = await db.prepare(
      `SELECT id,ticker,code,stock_code,name,cmp,change,ath,ath_date,pe,source,updated_at,price_as_of,quote_fetched_at,quote_error
       FROM watchlist
       WHERE user_id=?
       ORDER BY ticker ASC`
    ).all(systemUserId);
    res.json({ success: true, summary, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Watchlist sync failed" });
  }
});

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

app.get("/api/cmp/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const data = await fetchPrice(ticker);
    res.json({
      success: true,
      ticker,
      cmp: data.price,
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, ticker, error: err.message });
  }
});

// GET /api/stock/:ticker/sip  (used in SIP tab — needs price)
app.get("/api/stock/:ticker/sip", auth, async (req, res) => {
  try {
    const ticker  = req.params.ticker.toUpperCase();
    const stock   = await fetchPrice(ticker);
    if (!(stock.ath > 0)) return res.status(422).json({ success: false, error: 'All-time high is unavailable. Update this stock from the Watchlist first.' });
    const cfg     = await getOrSeedSIP(req.user.id);
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
app.get('/api/settings/stocks', auth, async (req, res) => {
  try {
    const holdings = await db.prepare('SELECT * FROM portfolio WHERE user_id=? ORDER BY ticker').all(req.user.id);
    const stocks = await db.prepare('SELECT ticker,stock_code,code,name FROM watchlist WHERE user_id=? ORDER BY id DESC').all(await getOnepieceSystemUserId());
    res.json({success:true,data:holdings.map(h => {
      const stock = matchStock(h, stocks);
      return {id:h.id,stock_code:h.ticker,name:h.stock_name || stock?.name || h.ticker,ok_code:h.stock_name ? (h.ok_code || '') : (h.ok_code || stock?.code || '')};
    })});
  } catch (err) { res.status(500).json({success:false,error:err.message}); }
});

app.put('/api/settings/stocks/:id', auth, async (req, res) => {
  try {
    const raw = typeof req.body.stock_code === 'string' ? req.body.stock_code.trim().toUpperCase() : '';
    if (!/^(?:(?:NSE|BSE|BOM):)?[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(raw)) return res.status(400).json({success:false,error:'Enter a valid stock code, such as NSE:RELIANCE or BOM:500325.'});
    const trade = splitTradeSymbol(raw);
    const stocks = await db.prepare('SELECT ticker,stock_code,code,name FROM watchlist WHERE user_id=? ORDER BY id DESC').all(await getOnepieceSystemUserId());
    const data = await transactionRaw(tx => changeStockCode(tx,req.user.id,req.params.id,req.body.expected_stock_code,trade.ticker,trade.exchange,stocks,{okCode:typeof req.body.ok_code==='string' ? req.body.ok_code.trim() : req.body.ok_code,expectedOkCode:req.body.expected_ok_code}));
    res.json({success:true,data});
  } catch (err) { res.status(err.status || 500).json({success:false,error:err.message}); }
});

app.get("/api/portfolio", auth, async (req, res) => {
  const uid      = req.user.id;
  const holdings = await db.prepare("SELECT * FROM portfolio WHERE user_id=? ORDER BY added_at DESC").all(uid);

  // Attach trade count and XIRR inputs (no live price needed for this)
  const withTrades = [];
  for (const h of holdings) {
    const trades = await db.prepare(
      "SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC"
    ).all(uid, h.ticker);
    withTrades.push({ ...h, tradeCount: trades.length, trades });
  }

  res.json({ success:true, data:{ holdings: withTrades } });
});

// GET /api/portfolio/:ticker/xirr
app.get("/api/portfolio/:ticker/xirr", auth, async (req, res) => {
  try {
    const uid    = req.user.id;
    const ticker = req.params.ticker.toUpperCase();
    const trades = await db.prepare("SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC").all(uid, ticker);
    if (!trades.length) return res.json({ success:true, ticker, xirrPct:null, livePrice:0, ath:0, cashflows:[] });

    // Get live price for current value (best effort)
    let livePrice = 0;
    let ath = 0;
    try {
      const quote = await fetchPrice(ticker);
      livePrice = quote.price;
      ath = Number.isFinite(Number(quote.ath)) ? Number(quote.ath) : 0;
    } catch {}

    const xirrPct = computeXIRR(trades, livePrice);
    let rem = 0;
    const cashflows = trades.map(t => {
      rem += t.type==="BUY" ? t.shares : -t.shares;
      return { date:t.traded_at, type:t.type, shares:t.shares, price:t.price,
               cashflow:t.type==="BUY"?-t.amount:+t.amount, runningShares:+rem.toFixed(4) };
    });

    res.json({ success:true, ticker, xirrPct, livePrice, ath, cashflows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.get('/api/portfolio-opportunities', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Fetch the sheet once for this page load, then use the saved snapshot for all stocks.
    await syncOnepieceWatchlistTable();
    const uid = req.user.id;
    const scope = req.query.scope === 'watchlist' ? 'watchlist' : 'portfolio';
    const cfg = await getOrSeedSIP(uid);
    const levels = JSON.parse(cfg.levels).slice(0, 7);
    const watchlistStocks = await db.prepare('SELECT ticker,stock_code,code,name FROM watchlist WHERE user_id=? ORDER BY ticker').all(await getOnepieceSystemUserId());
    const holdings = scope === 'watchlist'
      ? watchlistStocks.map(stock => ({ ...stock, ok_code: stock.code || '' }))
      : await db.prepare('SELECT * FROM portfolio WHERE user_id=? AND shares>0 ORDER BY ticker').all(uid);
    const rows = [];
    for (const holding of holdings) {
      const trades = await db.prepare('SELECT type,shares,price FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC,id ASC').all(uid, holding.ticker);
      const quote = await fetchPriceFromWatchlistTable(holding.ticker);
      const ath = Number(quote.ath || 0), price = Number(quote.price || 0);
      const fall = ath > 0 ? ((price - ath) / ath) * 100 : null;
      const opportunityLevels = levels.map((level, index) => {
        const f = Number(level.fall);
        const lower = index < levels.length - 1 ? Number(levels[index + 1].fall) : -Infinity;
        const allocationAmount = Number(cfg.max_budget) * Number(level.allocation) / 100;
        // Use the same non-overlapping price band for auto-selection and buy totals.
        // Zero-price bonus shares have no purchase-price zone; sales are not buys.
        const zoneBuys = trades.filter(t => t.type === 'BUY' && Number(t.price) > 0 && ath > 0 &&
          Number(t.price) <= ath * (100 + f) / 100 &&
          (lower === -Infinity || Number(t.price) > ath * (100 + lower) / 100));
        const investedAmount = zoneBuys.reduce((sum,t) => sum + Number(t.price) * Number(t.shares), 0);
        const boughtQuantity = zoneBuys.reduce((sum,t) => sum + Number(t.shares), 0);
        return { fall: f, allocation: Number(level.allocation), allocated_amount: allocationAmount,
          invested_amount: investedAmount, bought_quantity: boughtQuantity,
          shares_to_buy: price > 0 ? Math.floor(allocationAmount / price) : 0,
          trigger_price: ath * (1 + f / 100), zone_min: lower, zone_max: f,
          active: fall !== null && fall <= f && fall > lower, selected: zoneBuys.length > 0 };
      });
      rows.push({ ticker: holding.ticker, name: quote.name || holding.stock_name || holding.ticker,
        ok_code: scope === 'watchlist' || holding.stock_name
          ? (holding.ok_code || '')
          : (holding.ok_code || matchStock(holding, watchlistStocks)?.code || ''),
        price, ath, ath_date: quote.ath_date || null,
        fall_pct: fall, levels: opportunityLevels });
    }
    rows.sort((a,b) => (b.fall_pct ?? 999) - (a.fall_pct ?? 999));
    res.json({ success:true, data:{ scope, levels, rows } });
  } catch (err) { res.status(500).json({ success:false,error:err.message }); }
});

app.put('/api/portfolio-opportunities', auth, async (req,res) => {
  res.status(405).json({success:false,error:'Opportunity selections are calculated automatically from trades.'});
});

app.post("/api/portfolio", auth, async (req, res) => {
  const { ticker, shares, avg_price, notes } = req.body;
  if (!ticker||!shares||!avg_price) return res.status(400).json({ success:false, error:"ticker, shares, avg_price required" });
  const r = await db.prepare("INSERT OR IGNORE INTO portfolio (user_id,ticker,shares,avg_price,notes) VALUES (?,?,?,?,?)").run(req.user.id, ticker.toUpperCase(), shares, avg_price, notes||null);
  res.json({ success:true, id:r.lastInsertRowid });
});

app.put("/api/portfolio/:id", auth, async (req, res) => {
  const {shares,avg_price,notes}=req.body;
  await db.prepare("UPDATE portfolio SET shares=?,avg_price=?,notes=? WHERE id=? AND user_id=?").run(shares,avg_price,notes,req.params.id,req.user.id);
  res.json({ success:true });
});

app.delete("/api/portfolio/:id", auth, async (req, res) => {
  await db.prepare("DELETE FROM portfolio WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ success:true });
});

// ─────────────────────────────────────────
// ROUTES — TRADES
// ─────────────────────────────────────────
async function _syncPortfolio(uid, ticker, type, shares, price) {
  const ex = await db.prepare("SELECT * FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker);
  // New trades inherit the holding's saved stock configuration.
  if (ex) await db.prepare('UPDATE trade_history SET stock_name=?,ok_code=? WHERE user_id=? AND ticker=?').run(ex.stock_name || '',ex.ok_code || '',uid,ticker);
  if (type === "BUY") {
    if (ex) {
      const ns = ex.shares + shares;
      const np = ((ex.avg_price * ex.shares) + (price * shares)) / ns;
      await db.prepare("UPDATE portfolio SET shares=?,avg_price=? WHERE user_id=? AND ticker=?").run(+ns.toFixed(4), +np.toFixed(4), uid, ticker);
    } else {
      await db.prepare("INSERT INTO portfolio (user_id,ticker,shares,avg_price) VALUES (?,?,?,?)").run(uid, ticker, shares, price);
    }
  }
  if (type === "SELL" && ex) {
    const ns = ex.shares - shares;
    if (ns <= 0.0001) await db.prepare("DELETE FROM portfolio WHERE user_id=? AND ticker=?").run(uid, ticker);
    else await db.prepare("UPDATE portfolio SET shares=? WHERE user_id=? AND ticker=?").run(+ns.toFixed(4), uid, ticker);
  }
}

// Rebuild a holding from its complete remaining trade history. This is used after
// a trade is removed so deleting one lot never wipes out the other lots.
async function _rebuildPortfolioForTicker(uid, ticker, database = db) {
  const trades = await database.prepare(
    "SELECT type, shares, price FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at ASC, id ASC"
  ).all(uid, ticker);

  let shares = 0;
  let avgPrice = 0;
  for (const trade of trades) {
    const quantity = Number(trade.shares) || 0;
    const price = Number(trade.price) || 0;
    if (trade.type === "BUY") {
      const nextShares = shares + quantity;
      avgPrice = nextShares > 0 ? ((avgPrice * shares) + (price * quantity)) / nextShares : 0;
      shares = nextShares;
    } else if (trade.type === "SELL") {
      shares -= quantity;
      if (shares <= 0.0001) {
        shares = 0;
        avgPrice = 0;
      }
    }
  }

  if (shares <= 0.0001) {
    await database.prepare("DELETE FROM portfolio WHERE user_id=? AND ticker=?").run(uid, ticker);
    return;
  }

  const existing = await database.prepare("SELECT id FROM portfolio WHERE user_id=? AND ticker=?").get(uid, ticker);
  if (existing) {
    await database.prepare("UPDATE portfolio SET shares=?,avg_price=? WHERE user_id=? AND ticker=?")
      .run(+shares.toFixed(4), +avgPrice.toFixed(4), uid, ticker);
  } else {
    await database.prepare("INSERT INTO portfolio (user_id,ticker,shares,avg_price) VALUES (?,?,?,?)")
      .run(uid, ticker, +shares.toFixed(4), +avgPrice.toFixed(4));
  }
}

// Startup reconciliation repairs holdings that were left stale
// before individual-trade deletion began rebuilding the affected portfolio row.
async function _rebuildAllPortfolios(database = db) {
  const targets = new Map();
  const addTarget = (row) => targets.set(`${row.user_id}\u0000${row.ticker}`, row);
  (await database.prepare("SELECT DISTINCT user_id, ticker FROM trade_history").all()).forEach(addTarget);
  (await database.prepare("SELECT user_id, ticker FROM portfolio").all()).forEach(addTarget);
  for (const { user_id, ticker } of targets.values()) {
    await _rebuildPortfolioForTicker(user_id, ticker, database);
  }
}

app.get("/api/trades/template", (req, res) => {
  const template = fs.readFileSync(path.join(__dirname, "templates/onepiece-trade-import-template.xlsx"));
  res.set("Content-Disposition", 'attachment; filename="onepiece-trade-import-template.xlsx"');
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(template);
});

app.get("/api/trades/export", auth, async (req, res) => {
  const { start, end } = req.query;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (!validDate(start) || !validDate(end) || start > end) {
    return res.status(400).json({ success:false, error:'Choose valid start and end dates, with start on or before end.' });
  }
  // Match the calendar date displayed in trade history, including the entire end day.
  const data = await db.prepare(`SELECT * FROM trade_history WHERE user_id=?
    AND substr(traded_at,1,10) BETWEEN ? AND ?
    ORDER BY traded_at ASC, id ASC`).all(req.user.id, start, end);
  const stocks = await db.prepare('SELECT ticker,stock_code,code,name FROM watchlist WHERE user_id=? ORDER BY id DESC').all(await getOnepieceSystemUserId());
  res.json({ success:true, data:data.map(trade => {
    const stock = matchStock(trade, stocks);
    return { ...trade, stock_code:stock?.stock_code || trade.ticker, stock_name:trade.stock_name || stock?.name || '' };
  }) });
});

app.get("/api/trades", auth, async (req, res) => {
  const { ticker, exchange, type, limit=200 } = req.query;
  let q="SELECT * FROM trade_history WHERE user_id=?"; const p=[req.user.id];
  if (ticker){ q+=" AND ticker=?"; p.push(ticker.toUpperCase()); }
  if (exchange){ q+=" AND exchange=?"; p.push(normalizeExchangeCode(exchange)); }
  if (type)  { q+=" AND type=?";   p.push(type.toUpperCase()); }
  q+=" ORDER BY traded_at DESC LIMIT ?"; p.push(Number(limit));
  res.json({ success:true, data:await db.prepare(q).all(...p) });
});

app.post("/api/trades", auth, async (req, res) => {
  const { ticker, exchange, type, shares, price, notes, traded_at } = req.body;
  if (!ticker) return res.status(400).json({ success:false, error:"ticker required" });
  let values;
  try { values = validateTradeNumbers(type, shares, price); }
  catch(error) { return res.status(400).json({ success:false, error:error.message }); }
  const uid=req.user.id, tradeDate=traded_at||new Date().toISOString();
  const trade = splitTradeSymbol(ticker, exchange);
  const r=await db.prepare("INSERT INTO trade_history (user_id,exchange,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uid,trade.exchange,trade.ticker,values.type,values.shares,values.price,values.amount,notes||(values.price===0?'Bonus shares':null),tradeDate);
  await _syncPortfolio(uid, trade.ticker, values.type, values.shares, values.price);
  await _rebuildPortfolioForTicker(uid, trade.ticker);
  res.json({ success:true, id:r.lastInsertRowid });
});

app.delete("/api/trades/:id", auth, async (req, res) => {
  const uid = req.user.id;
  const trade = await db.prepare("SELECT ticker FROM trade_history WHERE id=? AND user_id=?").get(req.params.id, uid);
  if (!trade) return res.status(404).json({ success:false, error:"Trade not found" });
  await db.prepare("DELETE FROM trade_history WHERE id=? AND user_id=?").run(req.params.id, uid);
  await _rebuildPortfolioForTicker(uid, trade.ticker);
  res.json({ success:true });
});

app.delete("/api/trades", auth, async (req, res) => {
  const uid=req.user.id;
  await db.prepare("DELETE FROM trade_history WHERE user_id=?").run(uid);
  await db.prepare("DELETE FROM portfolio WHERE user_id=?").run(uid);
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

app.post("/api/trades/import", auth, async (req, res) => {
  try {
    const { trades } = req.body;
    if (!Array.isArray(trades) || !trades.length) return res.status(400).json({ success:false, error:"No trades provided" });
    const uid=req.user.id; let imported=0, skipped=0; const importErrors=[];
    const affectedTickers = new Set();
    for (const t of trades) {
      try {
        if (!t?.ticker) throw new Error("missing ticker");
        const values = validateTradeNumbers(t.type, t.shares, t.price);
        const trade = splitTradeSymbol(t.ticker, t.exchange);
        await db.prepare("INSERT INTO trade_history (user_id,exchange,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uid,trade.exchange,trade.ticker,values.type,values.shares,values.price,values.amount,t.notes||(values.price===0?'Imported (Bonus shares)':null),t.traded_at||new Date().toISOString());
        affectedTickers.add(trade.ticker);
        await _syncPortfolio(uid, trade.ticker, values.type, values.shares, values.price);
        imported++;
      } catch(e){ importErrors.push(`[${t?.ticker || '?'}] ${e.message}`); skipped++; }
    }
    for (const ticker of affectedTickers) await _rebuildPortfolioForTicker(uid, ticker);
    res.json({ success:true, summary:{ total:trades.length, imported, skipped }, errors:importErrors });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message || "Import failed" });
  }
});

// ─────────────────────────────────────────
// WATCHLIST
// ─────────────────────────────────────────
app.get("/api/watchlist", auth, async (req, res) => {
  const items=await db.prepare("SELECT * FROM watchlist WHERE user_id=? ORDER BY added_at DESC").all(req.user.id);
  const enriched=await Promise.all(items.map(async w=>{
    try { return { ...w, ...(await fetchPrice(w.ticker)) }; }
    catch { return { ...w, price:null }; }
  }));
  res.json({ success:true, data:enriched });
});
app.post("/api/watchlist", auth, async (req,res)=>{ const{ticker}=req.body; if(!ticker) return res.status(400).json({success:false,error:"ticker required"}); await db.prepare("INSERT OR IGNORE INTO watchlist (user_id,ticker) VALUES (?,?)").run(req.user.id,ticker.toUpperCase()); res.json({success:true}); });
app.delete("/api/watchlist/:ticker", auth, async (req,res)=>{ await db.prepare("DELETE FROM watchlist WHERE user_id=? AND ticker=?").run(req.user.id,req.params.ticker.toUpperCase()); res.json({success:true}); });

// ─────────────────────────────────────────
// ADMIN TABLE API
// ─────────────────────────────────────────
app.get("/api/admin/tables", adminAuth, async (req, res) => {
  try {
    const tables = [];
    for (const table of ADMIN_TABLES) {
      const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
      tables.push({ name: table, count: Number(countRow?.count || 0) });
    }
    res.json({ success: true, tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/admin/debug/db", adminAuth, async (req, res) => {
  try {
    const counts = await getAdminTableCounts();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      database: sanitizeDbUrl(tursoUrl),
      has_auth_token: Boolean(tursoAuthToken),
      counts,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/admin/table/:table", adminAuth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ADMIN_TABLES.has(table)) return res.status(400).json({ success:false, error:"Invalid table" });
    const columns = await getTableColumns(table);
    const rows = await db.prepare(`SELECT * FROM "${table}" ORDER BY id DESC`).all();
    res.json({ success: true, table, columns, rows });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

app.post("/api/admin/table/:table", adminAuth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ADMIN_TABLES.has(table)) return res.status(400).json({ success:false, error:"Invalid table" });
    const payload = await buildAdminPayload(table, req.body, true);
    const keys = Object.keys(payload);
    if (!keys.length) return res.status(400).json({ success:false, error:"No fields to insert" });
    const placeholders = keys.map(() => "?").join(",");
    const sql = `INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(",")}) VALUES (${placeholders})`;
    const result = await db.prepare(sql).run(...keys.map(k => payload[k]));
    res.json({ success:true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

app.put("/api/admin/table/:table/:id", adminAuth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ADMIN_TABLES.has(table)) return res.status(400).json({ success:false, error:"Invalid table" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success:false, error:"Invalid id" });
    const payload = await buildAdminPayload(table, req.body, false);
    const keys = Object.keys(payload);
    if (!keys.length) return res.status(400).json({ success:false, error:"No fields to update" });
    const sql = `UPDATE "${table}" SET ${keys.map(k => `"${k}"=?`).join(", ")} WHERE id=?`;
    await db.prepare(sql).run(...keys.map(k => payload[k]), id);
    res.json({ success:true });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

app.delete("/api/admin/table/:table/:id", adminAuth, async (req, res) => {
  try {
    const table = req.params.table;
    if (!ADMIN_TABLES.has(table)) return res.status(400).json({ success:false, error:"Invalid table" });
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success:false, error:"Invalid id" });
    await db.prepare(`DELETE FROM "${table}" WHERE id=?`).run(id);
    res.json({ success:true });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SIP CONFIG
// ─────────────────────────────────────────
app.get("/api/sip-config", auth, async (req,res)=>{ const cfg=await getOrSeedSIP(req.user.id); res.json({success:true,data:{...cfg,levels:JSON.parse(cfg.levels)}}); });
app.put("/api/sip-config", auth, async (req,res)=>{
  let config;
  try { config = validateSIPConfig(req.body); }
  catch (error) { return res.status(400).json({success:false,error:error.message}); }
  const {max_budget,levels} = config;
  await db.prepare("INSERT INTO sip_config (user_id,max_budget,levels) VALUES (?,?,?)").run(req.user.id,max_budget,JSON.stringify(levels));
  res.json({success:true});
});

// ─────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────
app.get("/api/public/db-info", async (req, res) => {
  try {
    const u = new URL(tursoUrl);
    res.json({
      success: true,
      db_host: u.host,
      db_name: u.pathname.replace(/^\//, ""),
      has_auth_token: Boolean(tursoAuthToken),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/public/user-count", async (req, res) => {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS count FROM users").get();
    res.json({ success: true, count: Number(row?.count || 0) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/health", (req,res)=>res.json({success:true,status:"ok",timestamp:new Date().toISOString()}));

const PORT = process.env.PORT || 3001;
if (require.main === module) {
app.listen(PORT, () => console.log(`✅ ONEPIECE backend running on http://localhost:${PORT}`));
}

module.exports = app;
