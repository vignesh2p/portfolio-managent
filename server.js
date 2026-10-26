const userActivity=require('./user-activity');
const rebalancing=require('./rebalancing');
const {UNAVAILABLE,accountAccessMessage,migrateUserAccess,createUserAuth,changeUserAccess}=require('./user-access');
const {xirrEligible}=require('./xirr-eligibility');
const {validateNewStock,addUniverseStock,deleteUniverseStock}=require('./admin-universe');
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
const { matchStock } = require('./stock-code-settings');
const { validateTradeNumbers } = require('./trade-validation');
const { validateSIPConfig } = require('./sip-config-validation');
const { createWatchlistCronHandler } = require('./watchlist-scheduler');
const {schema:watchlistSchema,createWatchlists}=require('./named-watchlists');
const {leaderboard,uniqueStocks}=require('./admin-insights');
const {schema:universeConfigSchema,yahooCodeSchema,applyYahooCodes,saveUniverseConfig}=require('./universe-stock-config');
const {schema:yahooCacheSchema,sharedSchema,createYahooPrices}=require('./yahoo-prices');
const {createSharedPriceRefresh}=require('./shared-price-refresh');
const YahooFinance=require('yahoo-finance2').default;
const yahooClient=new YahooFinance({suppressNotices:['yahooSurvey'],fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(10000)})});

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
app.get('/xirr-eligibility.js',(req,res)=>res.set('Cache-Control','no-cache').type('js').send('globalThis.xirrEligible = '+xirrEligible.toString()+';'));
app.get("/sip-config-validation.js", (req, res) => res.set("Cache-Control", "no-cache").type("js").send(sipValidationJs));
app.get("/responsive.css", (req, res) => res.set("Cache-Control", "no-cache").type("css").send(responsiveCss));
app.get("/responsive.js", (req, res) => res.set("Cache-Control", "no-cache").type("js").send(responsiveJs));
const rebalancingJs=fs.readFileSync(path.join(__dirname,'rebalancing-ui.js'),'utf8');
app.get('/rebalancing-ui.js',(req,res)=>res.set('Cache-Control','no-cache').type('js').send(rebalancingJs));
const userActivityJs=fs.readFileSync(path.join(__dirname,'user-activity-client.js'),'utf8');
app.get('/user-activity-client.js',(req,res)=>res.set('Cache-Control','no-cache').type('js').send(userActivityJs));
const adminActivityJs=fs.readFileSync(path.join(__dirname,'admin-activity.js'),'utf8');
app.get('/admin-activity.js',(req,res)=>res.set('Cache-Control','no-cache').type('js').send(adminActivityJs));
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
    rebalancing.schema,
    ...userActivity.schema,
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
  for(const statement of watchlistSchema)await execRaw(statement);
  await execRaw('CREATE TABLE IF NOT EXISTS stock_sip_budgets(user_id INTEGER NOT NULL,ticker TEXT NOT NULL,max_budget REAL NOT NULL CHECK(max_budget>0),PRIMARY KEY(user_id,ticker))');
  await migrateUserAccess(sql=>remoteDb.execute(sql));
  await execRaw(universeConfigSchema);
  await execRaw(yahooCodeSchema);
  await execRaw(yahooCacheSchema);
  for(const statement of sharedSchema)await execRaw(statement);
  const tradeColumns = await allRaw("PRAGMA table_info(trade_history)");
  const portfolioColumns = await allRaw('PRAGMA table_info(portfolio)');
  for (const column of ['stock_name', 'ok_code', 'yahoo_finance_code']) {
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
  await ensureWatchlistColumn("in_default_watchlist", "INTEGER NOT NULL DEFAULT 1");
  await ensureWatchlistColumn("code", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("stock_code", "TEXT NOT NULL DEFAULT ''");
  await ensureWatchlistColumn("yahoo_finance_code", "TEXT NOT NULL DEFAULT ''");
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
  const yahooSystem=await getRaw("SELECT id FROM users WHERE email=?",[ONEPIECE_SYSTEM_EMAIL]);
  await transactionRaw(tx=>applyYahooCodes(tx,yahooSystem.id));
  await _rebuildAllPortfolios(dbRaw);
  await runRaw("UPDATE watchlist SET cmp=NULL,change=NULL,ath=NULL,ath_date=NULL,price_as_of=NULL,quote_fetched_at=NULL,quote_error='Yahoo quote pending',source='YAHOO_FINANCE' WHERE user_id=(SELECT id FROM users WHERE email=?) AND source<>'YAHOO_FINANCE'",[ONEPIECE_SYSTEM_EMAIL]);
  await runRaw("INSERT OR IGNORE INTO user_watchlists(user_id,slot,name,all_stocks) SELECT id,1,'Default watchlist',1 FROM users WHERE email<>?",[ONEPIECE_SYSTEM_EMAIL]);
})();

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
const auth=createUserAuth({db,jwt,secret:JWT_SECRET});

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
  return jwt.sign({ id: user.id, email: user.email, role: "user", version:Number(user.token_version||0) }, JWT_SECRET, { expiresIn: "30d" });
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
  if (!xirrEligible(trades)) return null;
  const cashflows = trades.map(t => ({
    amount: t.type === "BUY" ? -Math.abs(t.amount) : +Math.abs(t.amount),
    date:   new Date(t.traded_at),
  }));
  const rem = trades.reduce((s, t) => s + (t.type === "BUY" ? t.shares : -t.shares), 0);
  if (rem > 0.0001 && !(Number.isFinite(livePrice) && livePrice > 0)) return null;
  if (rem > 0.0001 && livePrice > 0) cashflows.push({ amount: rem * livePrice, date: new Date() });
  return xirr(cashflows);
}

// Admin manages the stock universe; Yahoo Finance supplies market data.
const priceCache = {};
const CACHE_TTL  = 5 * 60 * 1000;
const ONEPIECE_SYSTEM_EMAIL = (process.env.ONEPIECE_SYSTEM_EMAIL || "__onepiece_system__@onepiece.local").toLowerCase();
const ONEPIECE_SYSTEM_NAME = process.env.ONEPIECE_SYSTEM_NAME || "OnePiece System";
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

function normalizeTickerValue(value) {
  return String(value || '')
    .toUpperCase()
    .trim()
    .replace(/^(NSE|BSE|BOM|BO|NS):/i, '')
    .replace(/\s+/g, ' ');
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

const yahooPrices=createYahooPrices({db,yf:yahooClient});
function matchPriceStock(holding,stocks){
  return matchStock(holding,stocks)||matchStock({...holding,ticker:normalizeTickerValue(holding.ticker)},stocks);
}
async function universeStock(ticker){
  const stocks=await db.prepare('SELECT ticker,stock_code,yahoo_finance_code,code,name FROM watchlist WHERE user_id=?').all(await getOnepieceSystemUserId());
  const stock=matchPriceStock({ticker:String(ticker).toUpperCase()},stocks);
  if(!stock)throw new Error('Stock not found in the stock universe: '+ticker);
  return stock;
}
async function fetchPrice(ticker){return yahooPrices.readStock(await universeStock(ticker));}
async function fetchPriceFromWatchlistTable(ticker){return fetchPrice(ticker);}
async function refreshYahooUniverse(){
  const systemId=await getOnepieceSystemUserId();
  const stocks=await db.prepare('SELECT ticker,stock_code,yahoo_finance_code,code,name FROM watchlist WHERE user_id=?').all(systemId);
  let index=0,successful=0,failed=0;const deadline=Date.now()+75000;
  await Promise.all(Array.from({length:Math.min(6,stocks.length)},async()=>{
    while(index<stocks.length){
      const stock=stocks[index++];let data;
      try{
        if(Date.now()>deadline)throw new Error('Refresh time limit reached; retry to load this stock');
        data=await yahooPrices.fetchStock(stock);successful++;
      }catch(error){failed++;data={price:null,change:null,ath:null,ath_date:null,price_as_of:null,quote_fetched_at:null,quote_error:error.message};}
      await db.prepare('UPDATE watchlist SET cmp=?,change=?,ath=?,ath_date=?,price_as_of=?,quote_fetched_at=?,quote_error=?,source=? WHERE user_id=? AND ticker=? AND yahoo_finance_code=?').run(data.price,data.change,data.ath,data.ath_date,data.price_as_of,data.quote_fetched_at,data.quote_error||null,'YAHOO_FINANCE',systemId,stock.ticker,stock.yahoo_finance_code);
    }
  }));
  return {total:stocks.length,successful,failed};
}
const coordinatedPriceRefresh=createSharedPriceRefresh({db,transactionRaw,refresh:refreshYahooUniverse});
async function refreshPricesForSession(){
  await dbReady;
  try{return await coordinatedPriceRefresh();}
  catch(error){return {error:error.message};}
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

    const yahooCode = String(row[colMap.yahoo_finance_code] || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9&._-]{0,49}\.(NS|BO)$/.test(yahooCode)) {
      errors.push(`Row ${i+1}: Yahoo Finance Code is required (for example RELIANCE.NS or 500325.BO)`);
      continue;
    }

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

      trades.push({ ticker, yahoo_finance_code:yahooCode, type:"BUY", shares:qty, price, amount:qty*price,
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
        trades.push({ ticker, yahoo_finance_code:yahooCode, type:"BUY", shares:sellQty, price:purPrice, amount:sellQty*purPrice,
          traded_at:(purDate&&!isNaN(purDate))?purDate.toISOString():new Date().toISOString(),
          notes:purPrice === 0 ? "Imported (Bonus shares — original buy for sold lot)" : "Imported (original buy for sold lot)" });
      }
      trades.push({ ticker, yahoo_finance_code:yahooCode, type:"SELL", shares:sellQty, price:sellPrice, amount:sellQty*sellPrice,
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
  await db.prepare("INSERT INTO users (email,password,name,account_status) VALUES (?,?,?,'pending')").run(email.toLowerCase(),hashed,name||email.split('@')[0]);
  res.status(201).json({success:true,approval_required:true,message:'Signup successful. Please wait for admin approval before signing in.'});
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  const user = await db.prepare("SELECT * FROM users WHERE email=?").get(email.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ success:false, error:"Invalid email or password" });
  if(user.account_status!=='approved'||user.deleted_at)return res.status(403).json({success:false,error:accountAccessMessage(user)});
  const token = signUserToken(user);
  await refreshPricesForSession();
  res.json({ success:true, token, user:{ id:user.id, email:user.email, name:user.name } });
});

app.post("/api/auth/admin-login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success:false, error:"email and password required" });
  if (email.toLowerCase() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success:false, error:"Invalid admin credentials" });
  }
  const token = signAdminToken();
  await refreshPricesForSession();
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

const discovery=require('./stock-discovery').createStockDiscovery({yf:yahooClient,prices:yahooPrices,systemId:getOnepieceSystemUserId});
const namedWatchlists=createWatchlists({db,transactionRaw,systemId:getOnepieceSystemUserId,readPrices:yahooPrices.readStocks,discovery});
namedWatchlists.register(app,auth);
app.get('/api/admin/stocks/search',adminAuth,async(req,res)=>{try{res.set('Cache-Control','no-store').json({success:true,data:await discovery.search(req.query.q)});}catch(e){res.status(e.status||500).json({success:false,error:e.message});}});
app.get('/api/admin/stock-config',adminAuth,async(req,res)=>{
  try{res.set('Cache-Control','no-store').json({success:true,data:await namedWatchlists.universe()});}
  catch(e){res.status(500).json({success:false,error:e.message});}
});
app.put('/api/admin/default-watchlist/:ticker',adminAuth,async(req,res)=>{
 try{
 if(typeof req.body.included!=='boolean')return res.status(400).json({success:false,error:'included must be true or false.'});
 const systemId=await getOnepieceSystemUserId();
 if(req.body.included){const stock=await db.prepare('SELECT * FROM watchlist WHERE user_id=? AND ticker=?').get(systemId,req.params.ticker);if(!stock)return res.status(404).json({success:false,error:'Stock not found.'});try{validateNewStock(stock);}catch(e){return res.status(400).json({success:false,error:'Configure CODE, Stock Code and Yahoo Finance Code before adding to the default watchlist.'});}}
 const result=await db.prepare('UPDATE watchlist SET in_default_watchlist=? WHERE user_id=? AND ticker=?').run(req.body.included?1:0,systemId,req.params.ticker);
 if(!result.changes)return res.status(404).json({success:false,error:'Stock not found.'});
 res.json({success:true});
 }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.post('/api/admin/stock-config',adminAuth,async(req,res)=>{
  try{
    const stock=validateNewStock(req.body),systemId=await getOnepieceSystemUserId();
    let quote;try{quote=await yahooPrices.fetchStock(stock);}catch(e){return res.status(502).json({success:false,error:'Yahoo lookup failed: '+e.message});}
    const data=await transactionRaw(tx=>addUniverseStock(tx,systemId,stock,quote));
    res.status(201).json({success:true,data});
  }catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});
app.delete('/api/admin/stock-config/:ticker',adminAuth,async(req,res)=>{
  try{const systemId=await getOnepieceSystemUserId();const data=await transactionRaw(tx=>deleteUniverseStock(tx,systemId,req.params.ticker));res.json({success:true,data});}
  catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});
app.put('/api/admin/stock-config/:ticker',adminAuth,async(req,res)=>{
  try{
    const systemId=await getOnepieceSystemUserId();
    const data=await transactionRaw(tx=>saveUniverseConfig(tx,systemId,req.params.ticker,req.body));
    for(const key of Object.keys(priceCache))delete priceCache[key];
    res.json({success:true,data});
  }catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});
app.get('/api/admin/leaderboard',adminAuth,async(req,res)=>{
  try{
    const users=await db.prepare("SELECT id,name,email FROM users WHERE email<>? AND account_status='approved' AND deleted_at IS NULL").all(ONEPIECE_SYSTEM_EMAIL);
    const holdings=await db.prepare('SELECT * FROM portfolio').all();
    const trades=await db.prepare('SELECT * FROM trade_history').all();
    res.set('Cache-Control','no-store').json({success:true,data:leaderboard(users,holdings,trades,await namedWatchlists.universe(),xirr,matchPriceStock),as_of:new Date().toISOString()});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get('/api/admin/stocks',async(req,res)=>{
  try{
    const users=await db.prepare('SELECT id FROM users WHERE email<>?').all(ONEPIECE_SYSTEM_EMAIL);
    const stocks=[];
    for(const user of users)for(const list of await namedWatchlists.lists(user.id))stocks.push(...await namedWatchlists.stocks(user.id,list.id));
    stocks.push(...await db.prepare('SELECT * FROM watchlist WHERE user_id<>?').all(await getOnepieceSystemUserId()));
    const holdings=await db.prepare('SELECT * FROM portfolio WHERE shares>0').all();
    const data=uniqueStocks(holdings,stocks,await namedWatchlists.universe(),matchStock);
    res.set('Cache-Control','no-store').json({success:true,total:data.length,data});
  }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.get("/api/watchlist/table", auth, async (req, res) => {
  try {
    const systemUserId = await getOnepieceSystemUserId();
    const rows = await db.prepare(
      `SELECT id,ticker,code,stock_code,yahoo_finance_code,name,cmp,change,ath,ath_date,pe,source,updated_at,price_as_of,quote_fetched_at,quote_error
       FROM watchlist
       WHERE user_id=?
       ORDER BY ticker ASC`
    ).all(systemUserId);
    res.json({ success: true, data: await yahooPrices.readStocks(rows) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Failed to load watchlist table" });
  }
});

app.post('/api/prices/refresh',auth,async(req,res)=>{
  const summary=await refreshPricesForSession();
  res.set('Cache-Control','no-store').json({success:!summary.error,summary,error:summary.error});
});
app.get("/api/cron/watchlist", createWatchlistCronHandler({db,sync:coordinatedPriceRefresh}));

app.post("/api/watchlist/sync", auth, async (req, res) => {
  try {
    const summary = {cached:true};
    const systemUserId = await getOnepieceSystemUserId();
    const rows = await db.prepare(
      `SELECT id,ticker,code,stock_code,yahoo_finance_code,name,cmp,change,ath,ath_date,pe,source,updated_at,price_as_of,quote_fetched_at,quote_error
       FROM watchlist
       WHERE user_id=?
       ORDER BY ticker ASC`
    ).all(systemUserId);
    res.json({ success: true, summary, data: await yahooPrices.readStocks(rows) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || "Watchlist sync failed" });
  }
});

app.get("/api/price/:ticker", auth, async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  try {
    const holding = await db.prepare('SELECT yahoo_finance_code FROM portfolio WHERE user_id=? AND ticker=?').get(req.user.id,ticker);
    const data = await fetchPrice(holding?.yahoo_finance_code || ticker);
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
    const holding = await db.prepare('SELECT * FROM portfolio WHERE user_id=? AND ticker=?').get(req.user.id,ticker);
    const universe = await namedWatchlists.universe();
    const master = matchStock(holding || {ticker},universe);
    const stock   = await fetchPrice(master?.ticker || ticker);
    if (!(stock.ath > 0)) return res.status(422).json({ success: false, error: 'All-time high is unavailable. Update this stock from the Watchlist first.' });
    const cfg     = await getOrSeedSIP(req.user.id);
    const levels  = JSON.parse(cfg.levels);
    const overrides = await db.prepare('SELECT ticker,max_budget FROM stock_sip_budgets WHERE user_id=?').all(req.user.id);
    const override = overrides.find(o=>o.ticker===ticker || (master && matchStock(o,universe)?.ticker===master.ticker));
    const budget  = override?.max_budget ?? cfg.max_budget;
    const trades = await db.prepare("SELECT ticker,yahoo_finance_code,price,shares FROM trade_history WHERE user_id=? AND type='BUY'").all(req.user.id);
    const buys = trades.filter(t=>t.ticker===ticker || (master && matchStock(t,universe)?.ticker===master.ticker));
    let spent = buys.reduce((sum,t)=>sum+Number(t.price)*Number(t.shares),0);
    const fallPct = ((stock.price - stock.ath) / stock.ath) * 100;
    const analysis = levels.map(l => {
      const allocated = (l.allocation/100)*budget;
      const amount = Math.max(0,allocated-spent);
      spent = Math.max(0,spent-allocated);
      return {
        ...l, amount,
        triggerPrice: Math.round(stock.ath*(1+l.fall/100)),
        triggered: stock.price > 0 && stock.price <= stock.ath*(100+Number(l.fall))/100,
      };
    });
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

  const portfolioTrades=await db.prepare('SELECT type,traded_at FROM trade_history WHERE user_id=? ORDER BY traded_at,id').all(uid);
  res.json({ success:true, data:{ holdings: withTrades, xirr_eligible:xirrEligible(portfolioTrades,true) } });
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
      const quote = await fetchPrice(trades.find(t=>t.yahoo_finance_code)?.yahoo_finance_code || ticker);
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

    res.json({ success:true, ticker, xirrPct, xirr_eligible:xirrEligible(trades), livePrice, ath, cashflows });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/activity/heartbeat',auth,async(req,res)=>{
 try{await transactionRaw(tx=>userActivity.record(tx,req.user.id));res.status(204).end();}
 catch{res.status(503).json({success:false,error:'Activity tracking temporarily unavailable.'});}
});
app.get('/api/admin/activity',adminAuth,async(req,res)=>{
 try{res.set('Cache-Control','no-store').json({success:true,data:await userActivity.report(db,ONEPIECE_SYSTEM_EMAIL,Number(req.query.weeks||12))});}
 catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});

async function rebalanceContext(uid,ticker){
 const [holdings,stocks,cfg]=await Promise.all([
  db.prepare('SELECT * FROM portfolio WHERE user_id=? AND shares>0').all(uid),namedWatchlists.universe(),getOrSeedSIP(uid)
 ]);
 const allowed=new Set(stocks.filter(s=>Number(s.in_default_watchlist)!==0).map(s=>s.ticker));
 const members=await db.prepare('SELECT i.ticker FROM user_watchlist_items i JOIN user_watchlists l ON l.id=i.watchlist_id WHERE l.user_id=?').all(uid);
 members.forEach(s=>allowed.add(s.ticker));
 holdings.forEach(h=>{const s=matchPriceStock(h,stocks);if(s)allowed.add(s.ticker);});
 const sources=rebalancing.sourceRows(holdings,stocks,matchPriceStock);
 const source=sources.find(s=>s.ticker===ticker);
 const levels=JSON.parse(cfg.levels);
 let candidates=source?rebalancing.candidates(stocks,holdings,levels,allowed,source,matchPriceStock):[];
 if(source){
  const [trades,overrides]=await Promise.all([
   db.prepare("SELECT ticker,yahoo_finance_code,price,shares FROM trade_history WHERE user_id=? AND type='BUY'").all(uid),
   db.prepare('SELECT ticker,max_budget FROM stock_sip_budgets WHERE user_id=?').all(uid)
  ]);
  candidates=candidates.map(candidate=>{
   const identity=matchPriceStock(candidate,stocks)?.ticker || candidate.ticker;
   const override=overrides.find(o=>o.ticker===candidate.ticker || matchPriceStock(o,stocks)?.ticker===identity);
   const budget=Number(override?.max_budget ?? cfg.max_budget);
   const allocation=levels.filter(l=>Number(l.fall)>=candidate.fall).reduce((sum,l)=>sum+Number(l.allocation),0);
   const invested=trades.filter(t=>t.ticker===candidate.ticker || matchPriceStock(t,stocks)?.ticker===identity).reduce((sum,t)=>sum+Number(t.price)*Number(t.shares),0);
   const amount=Math.max(0,budget*allocation/100-invested);
   return {...candidate,allocation:budget>0?amount/budget*100:0,suggested_amount:amount,shares_to_buy:Math.floor(amount/candidate.price)};
  }).filter(candidate=>candidate.shares_to_buy>0);
 }
 return {sources,source,candidates};
}
app.get('/api/rebalancing',auth,async(req,res)=>{
 try{const context=await rebalanceContext(req.user.id,req.query.ticker);res.set('Cache-Control','no-store').json({success:true,data:{sources:context.sources,source:context.source||null,candidates:context.candidates,combinations:context.source?rebalancing.combinations(context.candidates,context.source.market_value):[],date:rebalancing.indiaDate()}});}
 catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});
app.post('/api/rebalancing',auth,async(req,res)=>{
 try{
  const context=await rebalanceContext(req.user.id,req.body?.sell?.ticker);
  const data=await transactionRaw(tx=>rebalancing.commit(tx,req.user.id,req.body,context));
  res.json({success:true,data});
 }catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});

app.get('/api/portfolio-opportunities', auth, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    // Page navigation reads the shared cache; session refresh owns all provider calls.
    const uid = req.user.id;
    const scope = req.query.scope === 'watchlist' ? 'watchlist' : 'portfolio';
    const cfg = await getOrSeedSIP(uid);
    const levels = JSON.parse(cfg.levels);
    const watchlistStocks = await db.prepare('SELECT ticker,stock_code,yahoo_finance_code,code,name FROM watchlist WHERE user_id=? ORDER BY ticker').all(await getOnepieceSystemUserId());
    const owned = await db.prepare('SELECT * FROM portfolio WHERE user_id=? AND shares>0 ORDER BY ticker').all(uid);
    const ownedTickers = new Set(owned.map(h => matchStock(h,watchlistStocks)?.ticker || h.ticker));
    const holdings = scope === 'watchlist'
      ? (await namedWatchlists.stocks(uid,req.query.watchlist_id)).map(stock => ({ ...stock, ok_code: stock.code || '' }))
      : owned;
    const overrides=await db.prepare('SELECT ticker,max_budget FROM stock_sip_budgets WHERE user_id=?').all(uid);
    const budgetByTicker=new Map(overrides.map(o=>[matchStock(o,watchlistStocks)?.ticker||o.ticker,Number(o.max_budget)]));
    const rows = [];
    const seen = new Set();
    for (const holding of holdings) {
      const master=matchStock(holding,watchlistStocks);
      if(scope === 'watchlist' && ownedTickers.has(master?.ticker || holding.ticker))continue;
      const identity=master?.ticker || holding.ticker;
      if(seen.has(identity))continue;
      seen.add(identity);
      const code=String(master?.code ?? holding.ok_code ?? holding.code ?? '').trim();
      const stockCode=String(master?.stock_code ?? holding.stock_code ?? '').trim();
      if(!stockCode)continue;
      const stockBudget=budgetByTicker.get(identity)??budgetByTicker.get(holding.ticker)??Number(cfg.max_budget);
      const aliases=[...new Set([holding.ticker,master?.ticker,master?.stock_code,master?.yahoo_finance_code].filter(Boolean))];
      const trades = await db.prepare(`SELECT type,shares,price FROM trade_history WHERE user_id=? AND (ticker IN (${aliases.map(()=>'?').join(',')}) OR (yahoo_finance_code<>'' AND yahoo_finance_code=?)) ORDER BY traded_at ASC,id ASC`).all(uid,...aliases,master?.yahoo_finance_code || holding.yahoo_finance_code || '');
      let quote;
      try{quote=await fetchPriceFromWatchlistTable(master?.ticker || holding.ticker);}catch(error){quote={name:holding.name||holding.stock_name||holding.ticker,price:null,ath:null,ath_date:null,quote_error:error.message};}
      const ath = Number(quote.ath || 0), price = Number(quote.price || 0);
      const fall = ath > 0 ? ((price - ath) / ath) * 100 : null;
      let cumulativeAllocation = 0;
      // All paid buys consume the stock budget, including catch-up purchases in deeper zones.
      const totalInvested = trades.filter(t=>t.type==='BUY' && Number(t.price)>0).reduce((sum,t)=>sum+Number(t.price)*Number(t.shares),0);
      const opportunityLevels = levels.map((level, index) => {
        const f = Number(level.fall);
        const lower = index < levels.length - 1 ? Number(levels[index + 1].fall) : -Infinity;
        const upperPrice = ath * (100 + f) / 100;
        const lowerPrice = lower === -Infinity ? 0 : ath * (100 + lower) / 100;
        const allocationAmount = stockBudget * Number(level.allocation) / 100;
        cumulativeAllocation += allocationAmount;
        const remainingAmount = Math.max(0,cumulativeAllocation-totalInvested);
        const active = ath > 0 && price > 0 && price <= upperPrice && price > lowerPrice;
        // Use the same non-overlapping price band for auto-selection and buy totals.
        // Zero-price bonus shares have no purchase-price zone; sales are not buys.
        const zoneBuys = trades.filter(t => t.type === 'BUY' && Number(t.price) > 0 && ath > 0 &&
          Number(t.price) <= upperPrice && Number(t.price) > lowerPrice);
        const investedAmount = zoneBuys.reduce((sum,t) => sum + Number(t.price) * Number(t.shares), 0);
        const boughtQuantity = zoneBuys.reduce((sum,t) => sum + Number(t.shares), 0);
        return { fall: f, allocation: Number(level.allocation), allocated_amount: allocationAmount,
          invested_amount: investedAmount, bought_quantity: boughtQuantity,
          cumulative_allocated_amount: cumulativeAllocation, remaining_amount: remainingAmount,
          suggested_amount: active ? remainingAmount : 0,
          shares_to_buy: active ? Math.floor(remainingAmount / price) : 0,
          trigger_price: upperPrice, zone_min: lower, zone_max: f,
          active, selected: zoneBuys.length > 0 };
      });
      rows.push({ ticker: holding.ticker, name: quote.name || holding.stock_name || holding.ticker,
        ok_code: code, max_budget:stockBudget,
        price:quote.price==null?null:price, ath:quote.ath==null?null:ath, ath_date: quote.ath_date || null, quote_error:quote.quote_error||null,
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
  const stocks = await db.prepare('SELECT ticker,stock_code,yahoo_finance_code,code,name FROM watchlist WHERE user_id=? ORDER BY id DESC').all(await getOnepieceSystemUserId());
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

async function resolveTradeYahoo(uid,ticker,value,required=false) {
  const code=String(value||'').trim().toUpperCase();
  if(!code){if(required)throw new Error('Yahoo Finance Code is required');return '';}
  if(!require('./stock-discovery').validSymbol(code))throw new Error('Use a Yahoo Finance Code ending .NS or .BO');
  const existing=await db.prepare('SELECT yahoo_finance_code FROM trade_history WHERE user_id=? AND ticker=? AND yahoo_finance_code<>? LIMIT 1').get(uid,ticker,'');
  if(existing && existing.yahoo_finance_code!==code)throw new Error('This ticker is already linked to a different Yahoo Finance Code');
  const universe=await namedWatchlists.universe();
  const matched=matchStock({ticker},universe);
  if(matched?.yahoo_finance_code && matched.yahoo_finance_code!==code)throw new Error('Ticker and Yahoo Finance Code refer to different stocks');
  if(!universe.some(s=>s.yahoo_finance_code===code)){
    const prepared=await discovery.prepare([code]);
    await transactionRaw(tx=>discovery.insert(tx,prepared));
  }
  return code;
}
async function saveTradeYahoo(uid,ticker,code){
  if(!code)return;
  await db.prepare('UPDATE trade_history SET yahoo_finance_code=? WHERE user_id=? AND ticker=?').run(code,uid,ticker);
  await db.prepare('UPDATE portfolio SET yahoo_finance_code=? WHERE user_id=? AND ticker=?').run(code,uid,ticker);
}

app.post("/api/trades", auth, async (req, res) => {
  const { ticker, exchange, type, shares, price, notes, traded_at } = req.body;
  if (!ticker) return res.status(400).json({ success:false, error:"ticker required" });
  let values;
  try { values = validateTradeNumbers(type, shares, price); }
  catch(error) { return res.status(400).json({ success:false, error:error.message }); }
  const uid=req.user.id, tradeDate=traded_at||new Date().toISOString();
  const trade = splitTradeSymbol(ticker, exchange);
  let yahooCode;
  try{yahooCode=await resolveTradeYahoo(uid,trade.ticker,req.body.yahoo_finance_code);}
  catch(error){return res.status(400).json({success:false,error:error.message});}
  const r=await db.prepare("INSERT INTO trade_history (user_id,exchange,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uid,trade.exchange,trade.ticker,values.type,values.shares,values.price,values.amount,notes||(values.price===0?'Bonus shares':null),tradeDate);
  await _syncPortfolio(uid, trade.ticker, values.type, values.shares, values.price);
  await _rebuildPortfolioForTicker(uid, trade.ticker);
  await saveTradeYahoo(uid,trade.ticker,yahooCode);
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
        const yahooCode = await resolveTradeYahoo(uid,trade.ticker,t.yahoo_finance_code,true);
        await db.prepare("INSERT INTO trade_history (user_id,exchange,ticker,type,shares,price,amount,notes,traded_at) VALUES (?,?,?,?,?,?,?,?,?)").run(uid,trade.exchange,trade.ticker,values.type,values.shares,values.price,values.amount,t.notes||(values.price===0?'Imported (Bonus shares)':null),t.traded_at||new Date().toISOString());
        affectedTickers.add(trade.ticker);
        await _syncPortfolio(uid, trade.ticker, values.type, values.shares, values.price);
        await saveTradeYahoo(uid,trade.ticker,yahooCode);
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
    catch(error) { return { ...w, price:null,cmp:null,ath:null,ath_date:null,change:null,quote_error:error.message }; }
  }));
  res.json({ success:true, data:enriched });
});
app.post("/api/watchlist", auth, async (req,res)=>{ const{ticker}=req.body; if(!ticker) return res.status(400).json({success:false,error:"ticker required"}); await db.prepare("INSERT OR IGNORE INTO watchlist (user_id,ticker) VALUES (?,?)").run(req.user.id,ticker.toUpperCase()); res.json({success:true}); });
app.delete("/api/watchlist/:ticker", auth, async (req,res)=>{ await db.prepare("DELETE FROM watchlist WHERE user_id=? AND ticker=?").run(req.user.id,req.params.ticker.toUpperCase()); res.json({success:true}); });

// ─────────────────────────────────────────
// ADMIN TABLE API
// ─────────────────────────────────────────
app.get('/api/admin/users',adminAuth,async(req,res)=>{
 try{const data=await db.prepare('SELECT id,name,email,created_at,account_status,deleted_at FROM users WHERE email<>? ORDER BY created_at DESC,id DESC').all(ONEPIECE_SYSTEM_EMAIL);res.set('Cache-Control','no-store').json({success:true,data});}
 catch(e){res.status(500).json({success:false,error:e.message});}
});
app.put('/api/admin/users/:id/access',adminAuth,async(req,res)=>{
 try{res.json({success:true,data:await changeUserAccess(db,Number(req.params.id),req.body.action,ONEPIECE_SYSTEM_EMAIL)});}
 catch(e){res.status(e.status||500).json({success:false,error:e.message});}
});
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
    if(table==='users')return res.status(405).json({success:false,error:'Users must sign up and be approved in User management.'});
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
    if(table==='users')return res.status(405).json({success:false,error:'Use User management to change account access.'});
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
    if(table==='users'){await changeUserAccess(db,id,'delete',ONEPIECE_SYSTEM_EMAIL);}else await db.prepare(`DELETE FROM "${table}" WHERE id=?`).run(id);
    res.json({ success:true });
  } catch (err) {
    res.status(500).json({ success:false, error: err.message });
  }
});

// ─────────────────────────────────────────
// SIP CONFIG
// ─────────────────────────────────────────
app.get('/api/sip-stock-budgets',auth,async(req,res)=>{
 try{
 const rows=await db.prepare('SELECT p.ticker,p.stock_name,b.max_budget FROM portfolio p LEFT JOIN stock_sip_budgets b ON b.user_id=p.user_id AND b.ticker=p.ticker WHERE p.user_id=? AND p.shares>0 ORDER BY p.ticker').all(req.user.id);
 const universe=await namedWatchlists.universe();
 res.json({success:true,data:rows.map(r=>({...r,name:matchStock(r,universe)?.name||r.stock_name||r.ticker}))});
 }catch(e){res.status(500).json({success:false,error:e.message});}
});
app.put('/api/sip-stock-budgets/:ticker',auth,async(req,res)=>{
 try{
 const ticker=req.params.ticker,budget=req.body.max_budget;
 if(budget!==null&&(typeof budget!=='number'||!Number.isFinite(budget)||budget<=0))return res.status(400).json({success:false,error:'Enter a budget greater than zero.'});
 const holding=await db.prepare('SELECT ticker FROM portfolio WHERE user_id=? AND ticker=? AND shares>0').get(req.user.id,ticker);
 if(!holding)return res.status(404).json({success:false,error:'Select a stock from your portfolio.'});
 if(budget===null)await db.prepare('DELETE FROM stock_sip_budgets WHERE user_id=? AND ticker=?').run(req.user.id,ticker);
 else await db.prepare('INSERT INTO stock_sip_budgets(user_id,ticker,max_budget) VALUES (?,?,?) ON CONFLICT(user_id,ticker) DO UPDATE SET max_budget=excluded.max_budget').run(req.user.id,ticker,budget);
 res.json({success:true});
 }catch(e){res.status(500).json({success:false,error:e.message});}
});
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
