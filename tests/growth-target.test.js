const {test}=require('node:test'),assert=require('node:assert/strict');
const {createGrowthTargets,validateTarget}=require('../growth-target');
test('target validation accepts zero and decimals and rejects invalid inputs',()=>{
 for(const value of [0,30,15.5,1000])assert.equal(validateTarget(value),value);
 for(const value of [undefined,null,'30',NaN,Infinity,-1,1001])assert.throws(()=>validateTarget(value));
});
test('target defaults to 30 and is persisted and retrieved by authenticated user',async()=>{
 const rows=new Map(),routes={},auth=()=>{};
 const db={prepare:sql=>({get:async uid=>rows.has(uid)?{target_growth_pct:rows.get(uid)}:undefined,run:async(uid,value)=>rows.set(uid,value)})};
 const service=createGrowthTargets(db);service.register({get:(path,a,h)=>{assert.equal(a,auth);routes.get=h;},put:(path,a,h)=>{assert.equal(a,auth);routes.put=h;}},auth);
 let result,status;const res={set(){return this;},status(s){status=s;return this;},json(j){result=j;}};
 await routes.get({user:{id:1}},res);assert.equal(result.data.target_growth_pct,30);
 await routes.put({user:{id:1},body:{target_growth_pct:18.5}},res);assert.equal(result.success,true);
 assert.equal(await service.get(1),18.5);assert.equal(await service.get(2),30);
 await routes.put({user:{id:1},body:{target_growth_pct:'bad'}},res);assert.equal(status,400);assert.equal(await service.get(1),18.5);
});
test('rebalance context uses user-scoped trades, prices, XIRR and saved target',async()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('server.js','utf8'),r=require('../rebalancing');
 const holdings=[{ticker:'LOW',shares:1},{ticker:'HIGH',shares:1},{ticker:'UNKNOWN',shares:1}];
 const stocks=holdings.map(h=>({...h,price:100,ath_date:'2020-01-01'}));
 const trades=[{ticker:'LOW',rate:19},{ticker:'HIGH',rate:21}];
 const ctx={db:{prepare:sql=>({all:async uid=>{assert.equal(uid,7);return sql.includes('FROM portfolio')?holdings:sql.includes('trade_history')?trades:[];}})},namedWatchlists:{universe:async()=>stocks},athAgeSettings:{get:async()=>365},growthTargets:{get:async uid=>{assert.equal(uid,7);return 20;}},matchPriceStock:(h,rows)=>rows.find(s=>s.ticker===h.ticker),computeXIRR:(rows,price)=>{assert.equal(price,100);return rows[0]?.rate??null;},rebalancing:r};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function rebalanceContext'),source.indexOf("app.get('/api/rebalancing'")),ctx);
 const result=await ctx.rebalanceContext(7);assert.equal(result.targetGrowth,20);assert.deepEqual(Array.from(result.sources,s=>s.ticker),['LOW']);
});
