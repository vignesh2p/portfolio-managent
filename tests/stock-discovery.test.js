const {test}=require('node:test'),assert=require('node:assert/strict');
const {createStockDiscovery}=require('../stock-discovery');
test('Indian equity filtering, cache, exact symbol fallback and input validation',async()=>{
 let calls=0;
 const yf={search:async()=>{calls++;return {quotes:[{symbol:'ABC.NS',quoteType:'EQUITY',shortname:'ABC'},{symbol:'ABC.BO',quoteType:'EQUITY'},{symbol:'ABC',quoteType:'EQUITY'},{symbol:'FUND.NS',quoteType:'ETF'},{symbol:'ABC.NS',quoteType:'EQUITY'}]}},quote:async symbol=>({symbol,quoteType:'EQUITY',longName:'Exact'})};
 const service=createStockDiscovery({yf,prices:{fetchStock:async()=>({price:10})},systemId:async()=>99});
 assert.deepEqual((await service.search('abc')).map(s=>s.symbol),['ABC.NS','ABC.BO']);await service.search('ABC');assert.equal(calls,3);
 assert.ok((await service.search('EXACT.BO')).some(s=>s.symbol==='EXACT.BO'));
 await assert.rejects(service.search('a'),/2–80/);await assert.rejects(service.prepare(['AAPL']),/Indian/);
 const prepared=await service.prepare(['ABC.NS']);assert.equal(prepared[0].stock.stock_code,'NSE:ABC');assert.equal(prepared[0].stock.code,'');
 yf.quote=async symbol=>({symbol,quoteType:'ETF'});await assert.rejects(service.prepare(['FUND.NS']),/equity/);
});
test('discovered stocks excluded from default; duplicate listing reuses existing ticker',async()=>{
 const {createClient}=require('@libsql/client');const file=require('node:path').join(require('node:os').tmpdir(),'discovery-'+require('node:crypto').randomUUID()+'.db');const db=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
 await db.executeMultiple(`CREATE TABLE watchlist(user_id INTEGER,ticker TEXT,code TEXT,stock_code TEXT,yahoo_finance_code TEXT,name TEXT,cmp REAL,change REAL,ath REAL,ath_date TEXT,price_as_of TEXT,quote_fetched_at TEXT,quote_error TEXT,source TEXT,updated_at TEXT,in_default_watchlist INTEGER DEFAULT 1,UNIQUE(user_id,ticker));CREATE TABLE stock_yahoo_codes(ticker TEXT PRIMARY KEY,yahoo_finance_code TEXT);`);
 const service=createStockDiscovery({systemId:async()=>99});const item={stock:{ticker:'ABC.NS',code:'',stock_code:'NSE:ABC',yahoo_finance_code:'ABC.NS'},quote:{price:10,name:'ABC'}};
 assert.deepEqual(await service.insert(db,[item]),['ABC.NS']);assert.deepEqual(await service.insert(db,[item]),['ABC.NS']);
 const rows=(await db.execute('SELECT * FROM watchlist')).rows;assert.equal(rows.length,1);assert.equal(rows[0].in_default_watchlist,0);
 const {schema,createWatchlists}=require('../named-watchlists');
 await db.execute('CREATE TABLE users(id INTEGER PRIMARY KEY)');await db.execute('INSERT INTO users VALUES (1),(2),(99)');for(const sql of schema)await db.execute(sql);
 const adapter={prepare:sql=>({all:async(...args)=>(await db.execute({sql,args})).rows,run:async(...args)=>db.execute({sql,args})})};
 const transactionRaw=async fn=>{const tx=await db.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 const lists=createWatchlists({db:adapter,transactionRaw,systemId:async()=>99,discovery:{prepare:async()=>[item],insert:service.insert}});
 const saved=await lists.save(1,null,{name:'Mine',tickers:[],discovered:['ABC.NS']});assert.equal((await lists.stocks(1,saved.id))[0].ticker,'ABC.NS');
 assert.equal((await lists.universe()).length,1);assert.equal((await lists.stocks(2)).length,0);
 const reused=await lists.save(2,null,{name:'Second user',tickers:['ABC.NS']});assert.equal((await lists.stocks(2,reused.id)).length,1);
 assert.equal((await db.execute('SELECT * FROM watchlist')).rows.length,1);

 }finally{db.close();try{require('node:fs').rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
