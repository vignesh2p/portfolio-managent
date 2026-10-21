const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { stockQuoteCode, savedQuoteIsFresh, preserveQuote, refreshWatchlistQuote } = require('../watchlist-quotes');
const now = Date.parse('2026-09-22T12:00:00Z');
const quote = { price: 4895, ath: 5750, ath_date: '2026-07-07', price_as_of: 'Sep 22, 3:30 PM IST', fetched_at: new Date(now).toISOString(), cached: false };
async function fixture(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.execute(`CREATE TABLE watchlist(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,ticker TEXT,stock_code TEXT,cmp REAL,ath REAL,ath_date TEXT,price_as_of TEXT,quote_fetched_at TEXT,quote_error TEXT,change REAL,source TEXT,updated_at TEXT)`);
  await client.execute("INSERT INTO watchlist(user_id,ticker,stock_code,cmp,source) VALUES (10,'504605','BOM:504605',4500,'ONEPIECE_SHEET')");
  const db = { prepare: sql => ({
    get: async (...args) => (await client.execute({ sql, args })).rows[0],
    run: async (...args) => { const result = await client.execute({ sql, args }); return { changes: result.rowsAffected }; },
  }) };
  return { client, db, userId: 10, id: 1, now: () => now };
}
test('uses stock_code, supports bare BSE codes, and rejects ambiguous unqualified symbols', () => {
  assert.equal(stockQuoteCode({ ticker: 'OTHER', stock_code: 'BSE:504605' }), 'BOM:504605');
  assert.equal(stockQuoteCode({ ticker: '504605' }), 'BOM:504605');
  assert.throws(() => stockQuoteCode({ ticker: 'RELIANCE', code: '123456' }));
});
test('persists all three fields and reuses DB quotes across service instances for one hour', async t => {
  const f = await fixture(t);
  await refreshWatchlistQuote({ ...f, getQuote: async code => { assert.equal(code, 'BOM:504605'); return quote; } });
  const row = await f.db.prepare('SELECT * FROM watchlist WHERE id=1').get();
  assert.equal(row.cmp, 4895); assert.equal(row.ath, 5750); assert.equal(row.ath_date, '2026-07-07');
  assert.equal(row.source, 'FIRECRAWL'); assert.equal(row.quote_fetched_at, quote.fetched_at);
  const cached = await refreshWatchlistQuote({ ...f, now: () => now + 3599999, getQuote: () => { throw new Error('must not fetch'); } });
  assert.equal(cached.cached, true);
  assert.equal(savedQuoteIsFresh(row, now + 3600000), false);
  let fetched = false;
  await refreshWatchlistQuote({ ...f, now: () => now + 3600000, getQuote: async () => { fetched = true; return quote; } });
  assert.equal(fetched, true);
});
test('failed lookup preserves previous price and ATH and records the failure', async t => {
  const f = await fixture(t);
  await refreshWatchlistQuote({ ...f, getQuote: async () => quote });
  await assert.rejects(refreshWatchlistQuote({ ...f, now: () => now + 3600000, getQuote: async () => { throw new Error('Source unavailable'); } }), /Source unavailable/);
  const row = await f.db.prepare('SELECT * FROM watchlist WHERE id=1').get();
  assert.equal(row.cmp, 4895); assert.equal(row.ath, 5750); assert.equal(row.ath_date, '2026-07-07');
  assert.equal(row.quote_error, 'Source unavailable');
});
test('a different user or a row replaced during fetch cannot be updated', async t => {
  const f = await fixture(t);
  await assert.rejects(refreshWatchlistQuote({ ...f, userId: 11, getQuote: async () => quote }), error => error.status === 409);
  await assert.rejects(refreshWatchlistQuote({ ...f, getQuote: async () => {
    await f.client.execute("DELETE FROM watchlist WHERE id=1");
    await f.client.execute("INSERT INTO watchlist(user_id,ticker,stock_code,cmp) VALUES (10,'OTHER','NSE:OTHER',100)");
    return quote;
  } }), error => error.status === 409);
  assert.equal((await f.db.prepare('SELECT * FROM watchlist WHERE id=2').get()).cmp, 100);
});
test('sheet reload preserves quotes only for the same instrument', () => {
  const previous = { ticker: '504605', stock_code: 'BOM:504605', source: 'FIRECRAWL', cmp: 4895, ath: 5750, ath_date: quote.ath_date, quote_fetched_at: quote.fetched_at };
  const imported = { ticker: '504605', stock_code: 'BSE:504605', cmp: 4000, week52_high: 5000, source: 'ONEPIECE_SHEET' };
  const kept = preserveQuote(imported, previous);
  assert.equal(kept.cmp, 4895); assert.equal(kept.ath, 5750); assert.equal(kept.quote_fetched_at, quote.fetched_at);
  const changed = preserveQuote({ ...imported, stock_code: 'BOM:123456' }, previous);
  assert.equal(changed.ath, undefined); assert.equal(changed.cmp, 4000);
});
