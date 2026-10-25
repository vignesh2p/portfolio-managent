const {test}=require('node:test'),assert=require('node:assert/strict');
const {yahooSymbol,tradingDate,getYahooData,createYahooPrices,TTL}=require('../yahoo-prices');
const stock={ticker:'RELIANCE',stock_code:'NSE:WRONG',yahoo_finance_code:'NSE:RELIANCE',name:'Reliance Industries Ltd'};
function provider(){return {quote:async symbol=>({symbol,regularMarketPrice:100,regularMarketTime:new Date('2026-10-23T10:00:00Z'),regularMarketChange:2,fiftyTwoWeekHigh:120}),chart:async(symbol,{interval})=>({quotes:interval==='1mo'?[{date:new Date('2024-01-01'),high:150}]:[{date:new Date('2024-01-05T18:30:00Z'),high:150},{date:new Date('2024-01-07'),high:140}]}),search:async()=>({quotes:[]})};}
test('maps NSE/BOM/BSE and preserves already-qualified Yahoo symbols without guessing exchanges',()=>{
 assert.equal(yahooSymbol('NSE:RELIANCE'),'RELIANCE.NS');assert.equal(yahooSymbol('BOM:GRWRHITECH'),'GRWRHITECH.BO');assert.equal(yahooSymbol('BSE:500655'),'500655.BO');assert.equal(yahooSymbol('reliance.ns'),'RELIANCE.NS');assert.throws(()=>yahooSymbol('500655'),/exchange/);
 assert.equal(tradingDate('2024-01-05T18:30:00Z'),'2024-01-06');
});
test('returns quote and exact daily ATH date in India timezone',async()=>{
 const row=await getYahooData(provider(),stock);assert.equal(row.price,100);assert.equal(row.ath,150);assert.equal(row.ath_date,'2024-01-06');assert.equal(row.source,'YAHOO_FINANCE');
});
test('resolves a numeric BSE code only with exact normalized company name and correct exchange',async()=>{
 const yf=provider();yf.search=async()=>({quotes:[{symbol:'GRWRHITECH.NS',longname:'Garware Hi-Tech Films Limited'},{symbol:'GRWRHITECH.BO',longname:'Garware Hi-Tech Films Limited'},{symbol:'WRONG.BO',longname:'Other company'}]});
 const row=await getYahooData(yf,{ticker:'500655',yahoo_finance_code:'BOM:500655',name:'Garware Hi-Tech Films Ltd'});assert.equal(row.yahoo_symbol,'GRWRHITECH.BO');
});
test('does not invent ATH or its date from a monthly/52-week fallback',async()=>{
 const yf=provider();yf.chart=async()=>{throw Error('Unavailable');};const row=await getYahooData(yf,stock);assert.equal(row.price,100);assert.equal(row.ath,null);assert.equal(row.ath_date,null);assert.match(row.quote_error,/ATH unavailable/);
 const other=provider();other.chart=async(s,{interval})=>({quotes:interval==='1mo'?[{date:new Date('2024-01-01'),high:150}]:[]});assert.equal((await getYahooData(other,stock)).ath_date,null);
});
test('persistent 30-minute Yahoo-symbol cache, read-only page access and last-known Yahoo fallback',async()=>{
 const cache=new Map();let now=1000000,calls=0,fail=false;
 const yf=provider(),quote=yf.quote;yf.quote=async symbol=>{calls++;if(fail)throw Error('Provider down');return quote(symbol);};
 const aliases=new Map();
 const db={prepare:sql=>sql.includes('yahoo_symbol_aliases')?{get:async key=>aliases.has(key)?{yahoo_symbol:aliases.get(key)}:undefined,run:async(key,symbol)=>aliases.set(key,symbol)}:{get:async key=>cache.get(key),run:async(key,data_json,fetched_at)=>cache.set(key,{data_json,fetched_at})}};
 const service=createYahooPrices({db,yf,now:()=>now});
 await Promise.all([service.fetchStock(stock),service.fetchStock(stock)]);assert.equal(calls,1);
 assert.equal(TTL,30*60*1000);assert.ok(cache.has('RELIANCE.NS'));assert.ok(!cache.has('NSE:RELIANCE'));
 await service.fetchStock({...stock,yahoo_finance_code:'RELIANCE.NS'});assert.equal(calls,1);
 await service.readStock(stock);assert.equal(calls,1);
 now+=TTL-1;await createYahooPrices({db,yf,now:()=>now}).fetchStock(stock);assert.equal(calls,1);
 now+=2;fail=true;assert.equal((await service.readStock(stock)).stale,true);assert.equal(calls,1);
 await assert.rejects(service.readStock({...stock,yahoo_finance_code:'NSE:MISSING'}),/not cached/);assert.equal(calls,1);
 const stale=await service.fetchStock(stock);assert.equal(stale.stale,true);assert.equal(stale.source,'YAHOO_FINANCE');assert.match(stale.quote_error,/Last known Yahoo/);
 await assert.rejects(service.fetchStock({...stock,yahoo_finance_code:'NSE:NEW'}),/Provider down/);
});
test('refresh uses only the saved universe, with no Sheets loader or destructive replacement',()=>{
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
 assert.ok(!source.includes('fetchGoogleSheet'));
 assert.match(source,/refresh:refreshYahooUniverse/);
 assert.ok(!source.includes('syncOnepieceWatchlistTable'));
});
test('migrates existing quotes to shared Yahoo keys and restores snapshot prices without provider calls',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {createClient}=require('@libsql/client');
 const {schema,sharedSchema,applyCachedUniverseQuotes}=require('../yahoo-prices');
 const file=path.join(os.tmpdir(),'yahoo-shared-'+require('node:crypto').randomUUID()+'.db');
 const client=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
   await client.execute(schema);
   const data={yahoo_symbol:'GRWRHITECH.BO',price:100,change:1,ath:150,ath_date:'2024-01-06',quote_fetched_at:'2026-10-24T10:00:00Z',quote_error:null};
   await client.execute({sql:'INSERT INTO yahoo_quote_cache VALUES (?,?,?)',args:['BOM:500655',JSON.stringify(data),Date.now()]});
   for(const sql of sharedSchema)await client.execute(sql);
   assert.equal((await client.execute('SELECT yahoo_symbol FROM yahoo_shared_quotes')).rows[0].yahoo_symbol,'GRWRHITECH.BO');
   await client.executeMultiple("CREATE TABLE watchlist(user_id INTEGER,yahoo_finance_code TEXT,cmp REAL,change REAL,ath REAL,ath_date TEXT,price_as_of TEXT,quote_fetched_at TEXT,quote_error TEXT);INSERT INTO watchlist(user_id,yahoo_finance_code) VALUES (99,'BOM:500655');");
   const tx=await client.transaction('write');try{await applyCachedUniverseQuotes(tx,99);await tx.commit();}finally{tx.close();}
   assert.equal((await client.execute('SELECT cmp FROM watchlist')).rows[0].cmp,100);
 }finally{client.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
