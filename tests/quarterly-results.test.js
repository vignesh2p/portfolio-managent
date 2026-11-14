const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildResults,normalize,createQuarterlyResults,monthOf}=require('../quarterly-results');
const now=new Date('2026-11-01T00:00:00Z');
const sample=(date,amount=100)=>({date,periodType:'3M',totalRevenue:amount,costOfRevenue:amount*.4,operatingExpense:amount*.2,pretaxIncome:amount*.3,taxProvision:amount*.06,netIncome:amount*.24,dilutedEPS:amount*.01});
const history=()=>Array.from({length:12},(_,i)=>sample(new Date(Date.UTC(2023,12+i*3,0)).toISOString(),100+i*10));
test('normalization separates income-statement expenses from cash-flow and balance-sheet fields',()=>{
 const values=normalize({...sample('2026-06-30'),rawMaterials:9999,changeInInventory:8888,minorityInterest:7777,salariesAndWages:0});
 assert.equal(values.operatingProfit,40);assert.equal(values.opm,40);assert.equal(values.taxRate,20);assert.equal(values.employeeCosts,0);
 assert.equal(values.materialCosts,null);assert.equal(values.inventoryChanges,null);assert.equal(values.minorityInterest,null);
 assert.equal(normalize({totalRevenue:100,operatingIncome:30}).expenses,70);
 assert.equal(normalize({totalRevenue:0,pretaxIncome:0,taxProvision:10}).taxRate,null);
});
test('8 consecutive quarters, growth comparisons from older history, complete TTM sums and mean rates',()=>{
 const raw=history(),result=buildResults('AAPL',raw,[],{currency:'USD'},now);
 assert.equal(result.quarters.length,8);assert.equal(result.quarters[0].date,'2024-12-31');assert.equal(result.quarters.at(-1).date,'2026-09-30');
 assert.equal(result.quarters[0].yoy.sales,40);assert.equal(result.ttm.sales,180+190+200+210);assert.equal(result.ttm.opm,40);assert.equal(result.ttm.taxRate,20);
 assert.equal(result.ttm.eps,1.8+1.9+2+2.1);assert.equal(result.currency,'USD');assert.equal(result.currency_inferred,false);
});
test('gaps remain missing, not zero; partial TTM cannot masquerade as a full year',()=>{
 const raw=history();raw.splice(10,1);const result=buildResults('RELIANCE.NS',raw,[],{},now);
 assert.equal(result.quarters[6].date,'2026-06-30');assert.equal(result.quarters[6].missing,true);assert.equal(result.quarters[6].values.sales,null);
 assert.equal(result.ttm.sales,null);assert.equal(result.quarters[7].qoq.sales,null);assert.equal(result.currency,'INR');
 const empty=buildResults('AAPL',[],[],{},now);assert.equal(empty.quarters.length,8);assert.equal(empty.latest_period,null);assert.equal(empty.coverage.missing,8);
});
test('annual backfill derives one missing fiscal quarter but never invents EPS or distributes missing quarters',()=>{
 const raw=['2025-03-31','2025-06-30','2025-09-30'].map(d=>sample(d));
 const annual=[{...sample('2025-12-31',450),periodType:'12M'}];
 const result=buildResults('AAPL',raw,annual,{},now),last=result.quarters.at(-1);
 assert.equal(last.date,'2025-12-31');assert.equal(last.values.sales,150);assert.ok(last.derived.includes('sales'));assert.equal(last.values.eps,null);
 assert.equal(last.values.operatingProfit,60);assert.equal(result.ttm.sales,450);assert.equal(result.ttm.eps,null);
 const twoMissing=buildResults('AAPL',raw.slice(0,2),annual,{},now);assert.equal(twoMissing.latest_period,'2025-06-30');
});
test('fiscal offsets and 53-week ends are normalized without mixing trailing or future periods',()=>{
 assert.equal(monthOf('2025-10-04'),monthOf('2025-09-27'));
 const data=buildResults('NVDA',[sample('2026-01-31'),sample('2026-04-30'),sample('2026-07-31'),{...sample('2026-10-31',999),periodType:'TTM'},sample('2027-01-31')],[],{},now);
 assert.equal(data.latest_period,'2026-07-31');assert.equal(data.quarters[6].date,'2026-04-30');assert.equal(data.quarters[5].date,'2026-01-31');
});
test('only verified HTTPS official filing URLs attach to an exact reporting period',()=>{
 const result=buildResults('AAPL',[sample('2026-06-30')],[],{filings:[{reportDate:'2026-06-30',url:'javascript:alert(1)'},{reportDate:'2026-06-30',url:'https://www.sec.gov/Archives/test.htm'}]},now);
 assert.equal(result.quarters.at(-1).filing_url,'https://www.sec.gov/Archives/test.htm');assert.equal(result.filings.length,1);
});
function database(){const rows=new Map();return {prepare:()=>({get:async t=>rows.get(t),run:async(t,payload,fetched_at)=>{rows.set(t,{payload,fetched_at});}})};}
test('service backfills, deduplicates concurrent requests, persists history and serves stale data on provider failure',async()=>{
 let calls=0,failed=false,time=now;const db=database(),raw=history();
 const yf={fundamentalsTimeSeries:async(t,o)=>{calls++;if(failed)throw Error('upstream');return o.type==='annual'?[]:raw;},quoteSummary:async()=>({price:{longName:'Apple'},financialData:{financialCurrency:'USD'}})};
 const service=createQuarterlyResults({yf,db,now:()=>time});
 const [a,b]=await Promise.all([service.get('AAPL'),service.get('AAPL')]);assert.equal(calls,1);assert.deepEqual(a,b);assert.equal(a.name,'Apple');
 assert.equal((await service.get('AAPL')).cached,true);assert.equal(calls,1);
 time=new Date(now.getTime()+7*3600000);failed=true;const stale=await service.get('AAPL');assert.equal(stale.stale,true);assert.equal(stale.quarters.length,8);
 await assert.rejects(service.get('../secret'),/valid Yahoo ticker/);
});
test('short histories trigger wider quarterly and annual requests; search supports NSE/BSE and US equities',async()=>{
 const calls=[],yf={fundamentalsTimeSeries:async(t,o)=>{calls.push(o);return o.type==='annual'?[]:[sample('2026-06-30')];},quoteSummary:async()=>({}),search:async()=>({quotes:[{symbol:'AAPL',quoteType:'EQUITY',exchange:'NMS'},{symbol:'RELIANCE.NS',quoteType:'EQUITY',exchange:'NSI'},{symbol:'500325.BO',quoteType:'EQUITY',exchange:'BSE'},{symbol:'BTC-USD',quoteType:'CRYPTOCURRENCY'}]})};
 const service=createQuarterlyResults({yf,db:database(),now:()=>now});const data=await service.get('AAPL');
 assert.equal(calls.length,3);assert.equal(calls[0].module,'all');assert.equal(data.coverage.missing,7);
 assert.deepEqual((await service.search('aa')).map(s=>s.ticker),['AAPL','RELIANCE.NS','500325.BO']);
});
test('portfolio API is authenticated, user-scoped, deduplicates Yahoo aliases and leaves unmapped stocks explicit',async()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('server.js','utf8'),handlers={},auth=()=>{};
 const stock={ticker:'RELIANCE',yahoo_finance_code:'RELIANCE.NS',name:'Reliance'};
 const db={prepare:sql=>({all:async uid=>{assert.match(sql,/WHERE user_id=\?/);assert.equal(uid,42);return [{ticker:'ALIAS',shares:2},{ticker:'SECOND',yahoo_finance_code:'RELIANCE.NS',shares:3},{ticker:'MISSING',shares:1},{ticker:'AAPL',yahoo_finance_code:'AAPL',shares:1}];}})};
 const code=source.slice(source.indexOf('const resultsService='),source.indexOf('function adminAuth'));
 vm.runInNewContext(code,{quarterlyResults:{...require('../quarterly-results'),createQuarterlyResults:()=>({})},yf:{},yahooClient:{},db,auth,app:{get:(path,middleware,handler)=>{assert.equal(middleware,auth);handlers[path]=handler;}},namedWatchlists:{universe:async()=>[stock]},matchPriceStock:h=>h.ticker==='ALIAS'?stock:null});
 let response;const res={set:()=>res,status:()=>res,json:value=>response=value};
 await handlers['/api/results/portfolio']({user:{id:42}},res);assert.equal(response.success,true);assert.equal(response.data.length,3);
 assert.deepEqual(Array.from(response.data,r=>r.ticker),['RELIANCE.NS',null,'AAPL']);
 assert.ok(handlers['/api/stock/:ticker/quarterly']);assert.ok(handlers['/api/results/search']);
});

test('summary metadata exposes trailing PE and only past result dates after the reporting period',()=>{
 const raw=history();
 const build=meta=>buildResults('AAPL',raw,[],meta,now);
 assert.equal(build({pe:24.5,latest_result_date:'2026-10-20'}).pe,24.5);
 assert.equal(build({latest_result_date:'2026-10-20'}).latest_result_date,'2026-10-20');
 for(const date of ['2026-12-01','2026-09-01','invalid',null])assert.equal(build({latest_result_date:date}).latest_result_date,null);
 assert.equal(build({pe:NaN}).pe,null);
});
test('service retrieves PE and earnings date, omitting estimated dates',async()=>{
 for(const estimated of [false,true]){
  const yf={fundamentalsTimeSeries:async()=>history(),quoteSummary:async()=>({}),quote:async()=>({trailingPE:30,earningsTimestamp:new Date('2026-10-20'),isEarningsDateEstimate:estimated})};
  const data=await createQuarterlyResults({yf,db:database(),now:()=>now}).get('AAPL');
  assert.equal(data.pe,30);assert.equal(data.latest_result_date,estimated?null:'2026-10-20');
 }
});

test('before/after PE rolls TTM EPS forward at the same price',()=>{
 const raw=history(),meta={currency:'USD',price_currency:'USD',price:148};
 const data=buildResults('AAPL',raw,[],meta,now);
 assert.equal(data.pe_comparison.before,20);
 assert.ok(Math.abs(data.pe_comparison.after-148/7.8)<1e-10);
 for(const changed of [{price:null},{price:0},{price_currency:'INR'},{currency:null}]){
  const result=buildResults('AAPL',raw,[],{...meta,...changed},now);
  assert.equal(result.pe_comparison.before,null);assert.equal(result.pe_comparison.after,null);
 }
 const missing=raw.map(r=>({...r}));missing.at(-5).dilutedEPS=null;
 const partial=buildResults('AAPL',missing,[],meta,now);
 assert.equal(partial.pe_comparison.before,null);assert.ok(partial.pe_comparison.after>0);
 for(const eps of [0,-1]){
  const loss=buildResults('AAPL',raw.map(r=>({...r,dilutedEPS:eps})),[],meta,now);
  assert.equal(loss.pe_comparison.before,null);assert.equal(loss.pe_comparison.after,null);
 }
});
