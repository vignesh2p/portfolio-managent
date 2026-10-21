const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('export includes every in-range trade, bonus trades and both boundaries, sorted and user scoped', async () => {
  const client = require('@libsql/client').createClient({url:'file::memory:'});
  try {
    await client.execute('CREATE TABLE trade_history(id INTEGER PRIMARY KEY,user_id INTEGER,traded_at TEXT,price REAL)');
    const rows = Array.from({length:350},(_,i)=>({sql:'INSERT INTO trade_history VALUES (?,?,?,?)',args:[i+1,1,`2026-03-${String(28-i%28).padStart(2,'0')}T12:00:00`,i===0?0:10]}));
    rows.push(...[
      [351,1,'2026-03-01T00:00:00',10], [352,1,'2026-03-31T23:59:59.999Z',10],
      [353,1,'2026-02-28',10], [354,1,'2026-04-01',10], [355,2,'2026-03-15',10]
    ].map(args=>({sql:'INSERT INTO trade_history VALUES (?,?,?,?)',args})));
    await client.batch(rows,'write');
    await client.execute("ALTER TABLE trade_history ADD COLUMN ticker TEXT DEFAULT 'BONUS'");
    await client.execute('CREATE TABLE watchlist(id INTEGER,user_id INTEGER,ticker TEXT,stock_code TEXT,code TEXT,name TEXT)');
    await client.execute("INSERT INTO watchlist VALUES (1,99,'BONUS','NSE:BONUS','OK1','Bonus Company')");
    const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
    const route=source.slice(source.indexOf('app.get("/api/trades/export"'),source.indexOf('app.get("/api/trades",'));
    let handler;
    vm.runInNewContext(route,{app:{get:(_path,_auth,fn)=>handler=fn},auth:()=>{},getOnepieceSystemUserId:async()=>99,matchStock:require('../stock-code-settings').matchStock,db:{prepare:sql=>({all:async(...args)=>(await client.execute({sql,args})).rows})}});
    const call=async query=>{
      let status=200,body;
      const res={status(value){status=value;return this;},json(value){body=value;}};
      await handler({query,user:{id:1}},res);
      return {status,...body};
    };
    const result=await call({start:'2026-03-01',end:'2026-03-31'});
    assert.equal(result.data.length,352);
    assert.equal(result.data[0].stock_code,'NSE:BONUS');
    assert.equal(result.data[0].stock_name,'Bonus Company');
    assert.equal(result.data[0].id,351);
    assert.equal(result.data.at(-1).id,352);
    assert.ok(result.data.some(t=>t.price===0));
    assert.ok(result.data.every(t=>t.user_id===1));
    assert.deepEqual(result.data.map(t=>t.traded_at),result.data.map(t=>t.traded_at).sort());
    assert.equal((await call({start:'2026-03-31',end:'2026-03-31'})).data.length,1);
    assert.equal((await call({start:'2027-01-01',end:'2027-01-01'})).data.length,0);
    for(const query of [{},{start:'2026-02-30',end:'2026-03-31'},{start:'2026-04-01',end:'2026-03-01'},{start:['2026-03-01'],end:'2026-03-31'}]){
      assert.equal((await call(query)).status,400);
    }
  } finally { client.close(); }
});

test('frontend compiles and CSV preserves zero values, all rows and escaped notes',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../onepiece.html'),'utf8');
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
  const source=html.slice(html.indexOf('function downloadTradesCsv('),html.indexOf('async function deleteTrade('));
  let blob,clicked=false;
  const link={click(){clicked=true;},remove(){}};
  const context={Blob,URL:{createObjectURL(value){blob=value;return 'blob:test';},revokeObjectURL(){}},document:{createElement:()=>link,body:{appendChild(){}}}};
  vm.createContext(context);vm.runInContext(source,context);
  context.downloadTradesCsv(Array.from({length:352},()=>({ticker:'BONUS',stock_code:'NSE:BONUS',stock_name:'Bonus Company',type:'BUY',shares:10,traded_at:'2022-02-14T23:59:59Z',price:0,amount:0,notes:'Bonus, "shares"'})),'2026-03-01','2026-03-31');
  const csv=await blob.text();
  assert.equal(csv.split('\r\n').length,353);
  assert.equal(csv.split('\r\n')[0],'"Date","Scrip","Scrip Name","Action","Quantity","Buy / Sell @","Value","Brkg","Commentry"');
  assert.equal(csv.split('\r\n')[1],'"14-Feb-2022","NSE:BONUS","Bonus Company","BUY","10","0","0","","Bonus, ""shares"""');
  assert.ok(csv.includes('"0","0"'));
  assert.ok(csv.includes('"Bonus, ""shares"""'));
  assert.equal(link.download,'onepiece-trades-2026-03-01-to-2026-03-31.csv');
  assert.ok(clicked);
});
