const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const XLSX=require('xlsx');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
test('download template parses through the real importer without errors or duplicate buys',()=>{
  const start=source.indexOf('function parseExcelTrades(');
  const context=vm.createContext({XLSX});
  vm.runInContext(source.slice(start,source.indexOf('// ─',start)),context);
  const result=context.parseExcelTrades(fs.readFileSync(path.join(root,'templates/onepiece-trade-import-template.xlsx')),'template.xlsx');
  assert.equal(result.errors.length,0,JSON.stringify(result.errors));
  assert.equal(result.trades.length,3);
  assert.ok(result.trades.every(t=>t.yahoo_finance_code==='RELIANCE.NS'));
  assert.equal(result.trades[0].type,'BUY');
  assert.equal(result.trades[0].shares,10);
  assert.equal(result.trades[0].price,2500);
  assert.equal(result.trades[1].price,0);
  assert.equal(result.trades[1].shares,5);
  assert.equal(result.trades[2].type,'SELL');
  assert.equal(result.trades[2].shares,5);
  assert.equal(result.trades[2].price,2600);
  assert.equal(result.trades[0].traded_at.slice(0,10),'2026-01-05');
  assert.equal(result.trades[1].traded_at.slice(0,10),'2026-02-10');
  assert.equal(result.trades[2].traded_at.slice(0,10),'2026-03-15');
});

test('preview rejects absent and invalid Yahoo codes on buy and sell rows',()=>{
  const context=vm.createContext({XLSX});
  const start=source.indexOf('function parseExcelTrades(');
  vm.runInContext(source.slice(start,source.indexOf('// ─',start)),context);
  for(const value of ['', 'RELIANCE', 'AAPL', 'BAD CODE.NS']){
    const book=XLSX.readFile(path.join(root,'templates/onepiece-trade-import-template.xlsx'));
    for(const cell of ['G3','G4','G9'])book.Sheets.Trades[cell]={t:'s',v:value};
    const result=context.parseExcelTrades(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'bad.xlsx');
    assert.equal(result.trades.length,0);assert.equal(result.errors.length,3);
    assert.ok(result.errors.every(e=>e.includes('Yahoo Finance Code')));
  }
});
test('template download handler returns an Excel attachment',()=>{
  let handler,buffer;
  const headers={};
  vm.runInNewContext(source.slice(source.indexOf('app.get("/api/trades/template"'),source.indexOf('app.get("/api/trades/export"')),{app:{get:(_p,fn)=>handler=fn},fs,path,__dirname:root});
  const res={set(k,v){headers[k]=v;return this;},type(v){headers.type=v;return this;},send(v){buffer=v;}};
  handler({},res);
  assert.match(headers['Content-Disposition'],/attachment; filename="onepiece-trade-import-template.xlsx"/);
  assert.equal(XLSX.read(buffer).SheetNames[0],'Trades');
});
