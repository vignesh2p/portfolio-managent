const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {leaderboard}=require('../admin-insights');
const {matchStock}=require('../stock-code-settings');
const {xirrEligible}=require('../xirr-eligibility');

test('portfolio and leaderboard use legacy current-holdings XIRR and exclude closed positions',async()=>{
 const source=fs.readFileSync('server.js','utf8');
 const solver={};vm.createContext(solver);
 vm.runInContext(source.slice(source.indexOf('function xirr('),source.indexOf('function computeXIRR(')),solver);
 const fixed=new Date('2026-10-27T04:00:00Z');
 class FixedDate extends Date{constructor(...args){super(...(args.length?args:[fixed]));}}
 const trade=(ticker,type,amount,date)=>({user_id:1,ticker,type,amount,traded_at:date});
 const trades=[trade('SOLD','BUY',1000,'2022-01-01'),trade('SOLD','SELL',2000,'2024-01-01'),trade('OPEN','BUY',1000,'2024-02-01')];
 // Stored shares are authoritative, including bonus shares.
 let holdings=[{user_id:1,ticker:'OPEN',shares:15}];
 let stocks=[{ticker:'OPEN',cmp:120}];
 let handler,body;
 const context={Date:FixedDate,app:{get:(_path,_auth,fn)=>{handler=fn;}},auth:()=>{},
  db:{prepare:sql=>({all:async uid=>{assert.equal(uid,1);return sql.includes('FROM portfolio')?holdings:trades;}})},
  namedWatchlists:{universe:async()=>stocks},leaderboard,xirr:solver.xirr,matchPriceStock:matchStock,xirrEligible};
 const route=source.slice(source.indexOf('app.get("/api/portfolio",'),source.indexOf('// GET /api/portfolio/:ticker/xirr'));
 vm.runInNewContext(route,context);
 const res={set(){return this;},json(value){body=value;}};
 async function check(){
  await handler({user:{id:1}},res);
  const ranked=leaderboard([{id:1}],holdings,trades,stocks,solver.xirr,matchStock,fixed)[0];
  assert.equal(body.data.xirr_pct,ranked.xirr_pct);
  return ranked;
 }
 assert.ok(Number.isFinite((await check()).xirr_pct));
 assert.equal(body.data.holdings[0].trades.length,1);
 const omitted=leaderboard([{id:1}],holdings,trades.filter(t=>t.ticker==='OPEN'),stocks,solver.xirr,matchStock,fixed)[0];
 assert.equal(body.data.xirr_pct,omitted.xirr_pct);
 const expected=solver.xirr([{amount:-1000,date:new Date('2024-02-01')},{amount:1800,date:fixed}]);
 assert.equal(body.data.xirr_pct,expected);
 stocks=[];assert.equal((await check()).xirr_pct,null);
 holdings=[];trades.pop();
 assert.equal((await check()).xirr_pct,null);
 assert.equal(body.data.holdings.length,0);
});
