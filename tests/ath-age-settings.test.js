const {test}=require('node:test'),assert=require('node:assert/strict');
const {createAthAgeSettings,validateAthAge}=require('../ath-age-settings');
test('ATH age validation accepts non-negative integers and rejects invalid inputs',()=>{
 for(const value of [0,180,365,730])assert.equal(validateAthAge(value),value);
 for(const value of [undefined,null,'365',NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateAthAge(value));
});
test('ATH age defaults to 365 and is persisted and retrieved by authenticated user',async()=>{
 const rows=new Map(),routes={},auth=()=>{};
 const db={prepare:sql=>({get:async uid=>rows.has(uid)?{ath_age_days:rows.get(uid)}:undefined,run:async(uid,value)=>rows.set(uid,value)})};
 const service=createAthAgeSettings(db);service.register({get:(path,a,h)=>{assert.equal(a,auth);routes.get=h;},put:(path,a,h)=>{assert.equal(a,auth);routes.put=h;}},auth);
 let result,status;const res={set(){return this;},status(s){status=s;return this;},json(j){result=j;}};
 await routes.get({user:{id:1}},res);assert.equal(result.data.ath_age_days,365);
 await routes.put({user:{id:1},body:{ath_age_days:180}},res);assert.equal(result.success,true);
 assert.equal(await service.get(1),180);assert.equal(await service.get(2),365);
 await routes.put({user:{id:1},body:{ath_age_days:'bad'}},res);assert.equal(status,400);assert.equal(await service.get(1),180);
});

const r=require('../rebalancing');
test('custom ATH cutoff is strict and preserves XIRR exclusion and ordering',()=>{
 const now=new Date('2026-11-13T00:00:00Z');
 const stocks=[['OLDER',181],['BOUNDARY',180],['RECENT',179],['MISSING',200],['HIGH',200]].map(([ticker,days])=>({ticker,price:100,ath_date:new Date(now-days*86400000).toISOString().slice(0,10)}));
 const holdings=stocks.map(s=>({ticker:s.ticker,shares:1,avg_price:90,xirr_pct:s.ticker==='MISSING'?null:s.ticker==='HIGH'?30:10}));
 const match=(h,rows)=>rows.find(s=>s.ticker===h.ticker);
 assert.deepEqual(r.sourceRows(holdings,stocks,match,now).map(s=>s.ticker),[]);
 assert.deepEqual(r.sourceRows(holdings,stocks,match,now,30,180).map(s=>s.ticker),['OLDER']);
 assert.deepEqual(r.sourceRows(holdings,stocks,match,now,30,178).map(s=>s.ticker),['RECENT','BOUNDARY','OLDER']);
});
const fs=require('node:fs'),vm=require('node:vm');
test('settings load and save ATH age and rebalance displays the configured cutoff',async()=>{
 const html=fs.readFileSync(require.resolve('../onepiece.html'),'utf8');
 for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 const elements={};
 const document={getElementById:id=>elements[id]??=( {value:'',textContent:'',innerHTML:'',disabled:false,reportValidity:()=>true,addEventListener:()=>{}})};
 let saved=180;
 const ctx={document,api:async(url,options)=>{if(url==='/api/rebalancing')return {success:true,data:{ath_age_days:saved,target_growth_pct:30,sources:[]}};if(options)saved=JSON.parse(options.body).ath_age_days;return {success:true,data:{ath_age_days:saved}};}};
 vm.createContext(ctx);
 vm.runInContext(html.slice(html.indexOf('async function loadAthAge(){'),html.indexOf('async function loadSettings(){')),ctx);
 await ctx.loadAthAge();assert.equal(elements['set-ath-age'].value,180);
 elements['set-ath-age'].value='730';await ctx.saveAthAge();assert.equal(saved,730);assert.match(elements['ath-age-message'].textContent,/730 days/);
 vm.runInContext(fs.readFileSync(require.resolve('../rebalancing-ui.js'),'utf8'),ctx);
 await ctx.loadRebalancing();assert.match(elements['rebalance-description'].textContent,/more than 730 days/);assert.match(elements['rebalance-table'].innerHTML,/more than 730 days/);
});
