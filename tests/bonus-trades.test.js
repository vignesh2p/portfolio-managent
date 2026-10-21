const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const XLSX = require('xlsx');
const { validateTradeNumbers } = require('../trade-validation');
const server = fs.readFileSync(require('node:path').join(__dirname, '../server.js'), 'utf8');
const parser = server.slice(server.indexOf('function parseExcelTrades('), server.indexOf('// ─', server.indexOf('function parseExcelTrades(')));
const context = vm.createContext({ XLSX });
vm.runInContext(parser, context);
function parse(rows){
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Trades');
  return context.parseExcelTrades(XLSX.write(book, { type:'buffer', bookType:'xlsx' }), 'bonus.xlsx');
}
test('sheet preview retains numeric and formatted zero-price bonus buys', () => {
  const result = parse([
    ['Scrips Bought'], ['Stock','Pur Qty','Pur Date','Pur Price'],
    ['PAID',100,'01/01/2026',10], ['BONUS',100,'01/02/2026',0], ['BONUS2',50,'01/02/2026','0.00'],
    ['BLANK',100,'01/02/2026',''], ['BAD',100,'01/02/2026','0abc'], ['NEGATIVE',100,'01/02/2026',-1],
  ]);
  assert.equal(result.trades.length, 3); assert.equal(result.errors.length, 3);
  assert.equal(result.trades[1].price, 0); assert.equal(result.trades[1].amount, 0);
  assert.match(result.trades[1].notes, /Bonus/);
});
test('sold bonus lots include their zero-cost acquisition', () => {
  const result = parse([['Scrips Sold'], ['Stock','Pur Price','Pur Date','Sell Qty','Sell Price','Sell Date'], ['BONUS',0,'01/02/2026',50,20,'01/03/2026']]);
  assert.equal(result.trades.length, 2);
  assert.equal(result.trades[0].type, 'BUY'); assert.equal(result.trades[0].price, 0);
  assert.equal(result.trades[1].type, 'SELL'); assert.equal(result.trades[1].amount, 1000);
});
test('API validation accepts explicit zero but rejects missing prices, negative prices and zero sales', () => {
  assert.deepEqual(validateTradeNumbers('BUY','100','0'), { type:'BUY', shares:100, price:0, amount:0 });
  for(const invalid of [undefined, null, '', ' ', -1, 'bad', Infinity, false]) assert.throws(() => validateTradeNumbers('BUY',100,invalid));
  assert.throws(() => validateTradeNumbers('SELL',100,0));
  assert.throws(() => validateTradeNumbers('BUY',0,0));
});
