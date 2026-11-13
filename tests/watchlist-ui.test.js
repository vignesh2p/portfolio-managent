const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../onepiece.html'), 'utf8');
test('all inline browser scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
test('Update loads all rows before quotes, processes every row despite failures, and restores controls', async () => {
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', disabled: false }); return elements.get(id); };
  const calls = []; let active = 0, peak = 0;
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, ticker: String(i), stock_code: `BOM:${504605 + i}` }));
  const context = vm.createContext({ document: { getElementById: element }, escapeHtml: value => String(value), api: async path => {
    calls.push(path);
    if(path === '/api/watchlist/sync') return { success: true, data: rows };
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const id = Number(path.split('/')[3]);
    return id === 2 ? { success: false, error: 'Failed source' } : { success: true, cached: id === 1, data: { ...rows[id - 1], ath: 5750, ath_date: '2026-07-07' } };
  } });
  const start = html.indexOf('function renderWatchlistTable(');
  const end = html.indexOf('// -- SIP ', start);
  vm.runInContext(html.slice(start, end), context);
  await vm.runInContext('Promise.all([syncWatchlistData(), syncWatchlistData()])', context);
  assert.equal(calls[0], '/api/watchlist/sync'); assert.equal(calls.length, 8);
  assert.equal(peak, 1);
  assert.match(element('watchlist-meta').textContent, /5 fetched · 1 cached · 1 failed/);
  assert.match(element('watchlist-table').innerHTML, /All Time High Date/);
  assert.doesNotMatch(element('watchlist-table').innerHTML, /52 Week High/);
  assert.match(element('watchlist-update-result').innerHTML, /Failed source/);
  assert.equal(element('watchlist-update-btn').disabled, false);
  assert.equal(element('watchlist-refresh-btn').disabled, false);
});
