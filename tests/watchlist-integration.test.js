const { test } = require('node:test');
const assert = require('node:assert/strict');

test('actual app migrates, imports, enriches and preserves the watchlist through HTTP', async t => {
  // Isolated database and provider stubs: never reads production credentials or data.
  const fs = require('node:fs');
  const path = require('node:path');
  const tempFile = path.join(require('node:os').tmpdir(), `onepiece-watchlist-test-${require('node:crypto').randomUUID()}.db`);
  process.env.ONEPIECE_TURSO_DATABASE_URL = require('node:url').pathToFileURL(tempFile).href;
  const libsql = require('@libsql/client');
  const createClient = libsql.createClient;
  let database;
  libsql.createClient = options => (database = createClient(options));
  t.after(() => {
    database?.close();
    libsql.createClient = createClient;
    for (const suffix of ['', '-wal', '-shm']) {
      // libsql retains transaction handles until GC; Windows may keep these
      // temporary files locked until the test process exits.
      try { fs.unlinkSync(tempFile + suffix); } catch (error) { if (!['ENOENT', 'EBUSY', 'EPERM'].includes(error.code)) throw error; }
    }
  });
  process.env.ONEPIECE_TURSO_AUTH_TOKEN = 'test';
  process.env.JWT_SECRET = 'watchlist-integration-test';
  process.env.FIRECRAWL_API_KEY = 'test-provider-key';
  process.env.GOOGLE_SHEETS_URL = 'https://example.test/stocks.csv';
  process.env.GOOGLE_SHEETS_CSV_URL = 'https://example.test/stocks.csv';
  const axios = require('axios');
  let providerCalls = 0;
  axios.get = async () => ({ data: 'stock_code,name,cmp,week52_high\nBOM:504605,Uni-Abex Alloy Products Ltd,4500,5000' });
  axios.post = async (url, body) => {
    providerCalls++;
    assert.match(url, /^https:\/\/api\.firecrawl\.dev\/v2\//);
    const data = url.endsWith('/search') ? { web: [{ url: 'https://www.tradingview.com/symbols/BSE-UNIABEXAL/' }] }
      : body.url.includes('google.com') ? {
        metadata: { title: 'Uni-Abex Alloy Products Ltd (504605) Stock Price & News - Google Finance' },
        markdown: '504605:BOM\nUni-Abex Alloy Products Ltd\n\n₹4,895.00\n\nSep 22, 3:30 PM UTC+5:30 · INR',
      } : { markdown: '# Uni-Abex Alloy Products Limited\nUNIABEXAL reached its all-time high on Jul 7, 2026 with the price of 5,750.00 INR' };
    return { data: { success: true, data } };
  };
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = require('jsonwebtoken').sign({ id: 999 }, process.env.JWT_SECRET);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
    return { status: response.status, ...await response.json() };
  };
  assert.equal((await fetch(base + '/api/watchlist/1/quote', { method: 'POST' })).status, 401);
  const imported = await call('/api/watchlist/sync', 'POST');
  assert.equal(imported.status, 200, imported.error);
  assert.equal(imported.data.length, 1);
  assert.equal(imported.data[0].ath, 5000);
  assert.equal(imported.data[0].ath_date, null);
  const id = imported.data[0].id;
  const updated = await call(`/api/watchlist/${id}/quote`, 'POST');
  assert.equal(updated.status, 200, updated.error);
  assert.equal(updated.data.cmp, 4895); assert.equal(updated.data.ath, 5750);
  assert.equal(updated.data.ath_date, '2026-07-07');
  const table = await call('/api/watchlist/table');
  assert.equal(table.data[0].ath, 5750);
  const price = await call('/api/price/504605');
  assert.equal(price.data.ath, 5750);
  const reimported = await call('/api/watchlist/sync', 'POST');
  assert.equal(reimported.status, 200, reimported.error);
  assert.equal(reimported.data[0].cmp, 4895);
  assert.equal(reimported.data[0].ath_date, '2026-07-07');
  assert.notEqual(reimported.data[0].id, id);
  assert.equal((await call(`/api/watchlist/${id}/quote`, 'POST')).status, 409);
  const cached = await call(`/api/watchlist/${reimported.data[0].id}/quote`, 'POST');
  assert.equal(cached.cached, true); assert.equal(providerCalls, 3);
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal((await call('/api/watchlist/sync', 'POST')).status, 503);
  assert.equal((await call('/api/watchlist/table')).data[0].ath, 5750);

  await database.execute("INSERT INTO users(id,email,password,name) VALUES (999,'bonus-test@example.test','test-only','Bonus test')");
  const trade = (ticker,type,shares,price,date) => ({ ticker,type,shares,price,amount:999999,traded_at:date });
  const bonusImport = await call('/api/trades/import', 'POST', { trades:[
    trade('NSE:BONUS','BUY',100,10,'2026-01-01'),
    trade('NSE:BONUS','BUY',100,0,'2026-02-01'),
    trade('NSE:ORDER','BUY',100,10,'2026-01-01'),
    trade('NSE:ORDER','BUY',100,20,'2026-03-01'),
    trade('NSE:ORDER','SELL',50,15,'2026-02-15'),
    trade('NSE:ORDER','BUY',100,0,'2026-02-01'),
    trade('NSE:INVALID','BUY',100,null,'2026-01-01'),
  ] });
  assert.equal(bonusImport.summary.imported, 6); assert.equal(bonusImport.summary.skipped, 1);
  const portfolio = await call('/api/portfolio');
  const bonus = portfolio.data.holdings.find(h => h.ticker === 'NSE:BONUS');
  const ordered = portfolio.data.holdings.find(h => h.ticker === 'NSE:ORDER');
  assert.equal(bonus.shares, 200); assert.equal(bonus.avg_price, 5);
  assert.equal(ordered.shares, 250); assert.equal(ordered.avg_price, 11);
  const history = await database.execute("SELECT amount FROM trade_history WHERE user_id=999 AND price=0");
  assert.ok(history.rows.every(row => row.amount === 0));
  const manualBonus = await call('/api/trades','POST',trade('NSE:BONUS','BUY',50,0,'2026-03-01'));
  assert.equal(manualBonus.success, true);
  const afterBonus = (await call('/api/portfolio')).data.holdings.find(h => h.ticker === 'NSE:BONUS');
  assert.equal(afterBonus.shares, 250); assert.equal(afterBonus.avg_price, 4);
});
