const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../onepiece.html'), 'utf8');
const code = html.slice(html.indexOf('function getSortedPortfolioHoldings('), html.indexOf('function renderPortfolioTable('));
const context = vm.createContext({ calcXIRR: trades => trades.length ? trades[0].xirr : null });
vm.runInContext(code, context);
const holdings = [
  { ticker:'B', shares:2, avg_price:20, trades:[{ xirr:-5 }] },
  { ticker:'A', shares:10, avg_price:10, trades:[{ xirr:15 }] },
  { ticker:'C', shares:3, avg_price:5, trades:[] },
];
const prices = { A:{ price:12, changePct:2, name:'Alpha' }, B:{ price:10, changePct:-1, name:'Beta' }, C:null };
const sort = (field, direction='asc') => Array.from(context.getSortedPortfolioHoldings(holdings, prices, field, direction), h => h.ticker);
test('numeric portfolio sorting handles gains, losses and descending order', () => {
  assert.deepEqual(sort('shares'), ['B','C','A']);
  assert.deepEqual(sort('cost','desc'), ['A','B','C']);
  for(const field of ['price','value','pnl','pnlPct','change','xirr']) {
    assert.deepEqual(sort(field), ['B','A','C']);
    assert.deepEqual(sort(field,'desc'), ['A','B','C']);
  }
});
test('text sorting and unavailable values are stable without mutating holdings', () => {
  assert.deepEqual(sort('symbol'), ['A','B','C']);
  assert.deepEqual(sort('name','desc'), ['B','A','C']);
  assert.deepEqual(holdings.map(h => h.ticker), ['B','A','C']);
});
test('changing the sort moves existing rows and keeps their rendered data', () => {
  const nodes = Object.fromEntries(holdings.map(h => [`port-row-${h.ticker}`, { ticker:h.ticker, priceCell:'existing value' }]));
  const appended = [];
  nodes['port-rows'] = { appendChild: row => appended.push(row) };
  nodes['portfolio-sort-field'] = { value:'value' };
  nodes['portfolio-sort-order'] = { value:'desc' };
  context.document = { getElementById: id => nodes[id] };
  context.portfolioHoldings = holdings;
  context.priceMap = prices;
  context.applyPortfolioSort();
  assert.deepEqual(appended.map(row => row.ticker), ['A','B','C']);
  assert.equal(appended[0], nodes['port-row-A']);
  assert.equal(appended[0].priceCell, 'existing value');
});
