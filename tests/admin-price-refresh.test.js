const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {createSharedPriceRefresh}=require('../shared-price-refresh');
const {createYahooPrices}=require('../yahoo-prices');

test('manual refresh bypasses closed hours and completed cache, retains lease exclusion, and releases on failure',async()=>{
 const time=Date.parse('2026-11-08T18:00:00Z');let runs=0,fail=false;
 const row={lease_until:0,completed_at:time,summary_json:'{}'};
 const db={prepare:()=>({run:async()=>{row.lease_until=0;}})};
 const transactionRaw=async fn=>fn({execute:async q=>{if(typeof q==='string')return {rows:[row]};row.lease_until=q.args[1];return {rows:[]};}});
 const refresh=createSharedPriceRefresh({db,transactionRaw,now:()=>time,refresh:async options=>{assert.equal(options.force,true);runs++;if(fail)throw Error('offline');return {total:12,next:'Z'};}});
 assert.equal((await refresh()).marketClosed,true);
 assert.equal((await refresh({force:true})).total,12);assert.equal(runs,1);assert.equal(row.completed_at,time);
 row.lease_until=time+1000;assert.equal((await refresh({force:true})).refreshing,true);assert.equal(runs,1);
 row.lease_until=0;fail=true;await assert.rejects(refresh({force:true}),/offline/);assert.equal(row.lease_until,0);
});

test('forced quotes replace a fresh cache and preserve it when the provider fails',async()=>{
 let cached={data_json:JSON.stringify({price:10}),fetched_at:1000},calls=0,fail=false;
 const db={prepare:sql=>sql.includes('yahoo_symbol_aliases')?{get:async()=>({yahoo_symbol:'TEST.NS'})}:{get:async()=>cached,run:async(key,data_json,fetched_at)=>{cached={data_json,fetched_at};}}};
 const yf={quote:async()=>{calls++;if(fail)throw Error('offline');return {regularMarketPrice:20};},chart:async()=>{throw Error('no history');}};
 const service=createYahooPrices({db,yf,now:()=>1000});const stock={ticker:'TEST',yahoo_finance_code:'TEST.NS'};
 assert.equal((await service.fetchStock(stock)).price,10);assert.equal(calls,0);
 assert.equal((await service.fetchStock(stock,{force:true})).price,20);assert.equal(calls,1);
 const saved=cached.data_json;fail=true;
 const result=await service.fetchStock(stock,{force:true});assert.equal(result.stale,true);assert.equal(result.price,20);assert.equal(cached.data_json,saved);
});

test('admin endpoint enforces admin middleware, validates cursors, forces refresh and reports contention',async()=>{
 const source=fs.readFileSync('server.js','utf8');const start=source.indexOf("app.post('/api/admin/prices/refresh'");
 const code=source.slice(start,source.indexOf("app.get('/api/admin/stock-config'",start));
 const adminAuth=()=>{};let handler,options,result={total:0,next:null};
 vm.runInNewContext(code,{app:{post:(path,auth,fn)=>{assert.equal(auth,adminAuth);handler=fn;}},adminAuth,dbReady:Promise.resolve(),coordinatedPriceRefresh:async opts=>{options=opts;return result;}});
 const res={code:200,set(){return this;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await handler({body:{after:'ABC'}},res);assert.equal(options.force,true);assert.equal(options.after,'ABC');assert.equal(res.body.success,true);
 await handler({body:{after:42}},res);assert.equal(res.code,400);
 result={refreshing:true};await handler({body:{}},res);assert.equal(res.code,409);assert.equal(res.body.success,false);
});

test('forced universe batches advance through all stocks and count stale failures correctly',async()=>{
 const source=fs.readFileSync('server.js','utf8');const code=source.slice(source.indexOf('async function refreshYahooUniverse('),source.indexOf('const coordinatedPriceRefresh='));
 const stocks=Array.from({length:25},(_,i)=>({ticker:String(i).padStart(2,'0'),yahoo_finance_code:'TEST.NS'}));let calls=0,writes=0;
 const ctx={getOnepieceSystemUserId:async()=>1,db:{prepare:sql=>({all:async(id,after)=>stocks.filter(s=>s.ticker>after).slice(0,12),run:async()=>{if(sql.includes('SET cmp='))writes++;}})},yahooPrices:{fetchStock:async(stock,options)=>{assert.equal(options.force,true);calls++;return stock.ticker==='05'?{stale:true,quote_error:'offline'}:{price:20};}},syncBetaCyclesForQuote:async()=>{}};
 vm.createContext(ctx);vm.runInContext(code,ctx);let after='',total=0,failed=0;
 do{const batch=await ctx.refreshYahooUniverse({force:true,after});total+=batch.total;failed+=batch.failed;after=batch.next;}while(after!==null);
 assert.equal(calls,25);assert.equal(total,25);assert.equal(failed,1);assert.equal(writes,24);
});

test('admin button processes batches, prevents duplicate clicks, and restores controls after errors',async()=>{
 const nodes=new Map();let click,finish,calls=0,reloads=0;
 const node=()=>({textContent:'',children:[],addEventListener:(event,fn)=>{click=fn;},replaceChildren(){this.children=[];},appendChild(child){this.children.push(child);}});
 const document={getElementById:id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);},createElement:node};
 const ctx={document,refreshCurrentTable:async()=>{reloads++;},fetchJson:async(path,options)=>{calls++;if(calls===1){await new Promise(resolve=>{finish=resolve;});return {success:true,total:12,successful:11,failed:1,errors:[{ticker:'BAD',error:'offline'}],next:'L'};}assert.equal(JSON.parse(options.body).after,'L');return {success:true,total:1,successful:1,failed:0,next:null};}};
 vm.runInNewContext(fs.readFileSync('admin-price-refresh.js','utf8'),ctx);
 const work=click();await click();assert.equal(calls,1);assert.equal(nodes.get('refresh-prices-btn').disabled,true);finish();await work;
 assert.equal(calls,2);assert.equal(reloads,1);assert.match(nodes.get('price-refresh-status').textContent,/12 updated, 1 failed/);assert.equal(nodes.get('refresh-prices-btn').disabled,false);
 ctx.fetchJson=async()=>{throw Error('network unavailable');};await click();assert.match(nodes.get('price-refresh-status').textContent,/Refresh stopped: network unavailable/);assert.equal(nodes.get('refresh-prices-btn').disabled,false);
});
