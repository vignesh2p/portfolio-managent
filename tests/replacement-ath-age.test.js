const {test}=require('node:test'),assert=require('node:assert/strict');
const {createReplacementAthAgeSettings,validateReplacementAthAge}=require('../replacement-ath-age-settings');
const r=require('../rebalancing'),fs=require('fs'),vm=require('vm');
test('replacement ATH limit defaults to 100, validates, and persists per authenticated user',async()=>{
 for(const n of [1,100,250,1000])assert.equal(validateReplacementAthAge(n),n);
 for(const n of [0,-1,1.5,null,undefined,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateReplacementAthAge(n));
 const rows=new Map(),routes={},auth=()=>{};
 const service=createReplacementAthAgeSettings({prepare:()=>({get:async uid=>rows.has(uid)?{replacement_ath_age_days:rows.get(uid)}:undefined,run:async(uid,n)=>rows.set(uid,n)})});
 service.register({get:(path,a,h)=>{assert.equal(path,'/api/replacement-ath-age');assert.equal(a,auth);routes.get=h;},put:(path,a,h)=>{assert.equal(a,auth);routes.put=h;}},auth);
 let body,status;const res={set(){return this;},status(n){status=n;return this;},json(b){body=b;}};
 await routes.get({user:{id:1}},res);assert.equal(body.data.replacement_ath_age_days,100);
 await routes.put({user:{id:1},body:{replacement_ath_age_days:250}},res);assert.equal(body.success,true);assert.equal(await service.get(1),250);assert.equal(await service.get(2),100);
 await routes.put({user:{id:1},body:{replacement_ath_age_days:0}},res);assert.equal(status,400);assert.equal(await service.get(1),250);
});
test('both candidate paths honor custom strict boundaries, invalid ATH dates, and source exclusion',()=>{
 const now=new Date('2026-11-15T00:00:00Z');
 const stocks=[0,99,100,149,150,null].map((age,i)=>({ticker:'S'+i,name:'S'+i,stock_code:'NSE:S'+i,price:80,ath:100,ath_date:age===null?null:new Date(now-age*86400000).toISOString().slice(0,10)}));
 const match=(h,s)=>s.find(row=>row.ticker===h.ticker),source={ticker:'SOURCE'},held=[{ticker:'S3',shares:1}];
 const rows=stocks.map(s=>({...s,levels:[{active:true,fall:-10,allocation:100,suggested_quantity:10,suggested_investment:800}]}));
 assert.deepEqual(r.betaCandidates(rows,stocks,held,source,match,now).map(s=>s.days_since),[0,99]);
 const candidates=r.betaCandidates(rows,stocks,held,source,match,now,150);
 assert.deepEqual(candidates.map(s=>s.days_since),[0,99,100,149]);assert.equal(candidates.at(-1).in_portfolio,true);
 assert.deepEqual(r.candidates(stocks,held,[{fall:-10,allocation:100}],new Set(stocks.map(s=>s.ticker)),source,match,now,150).map(s=>s.days_since),[0,99,100,149]);
 assert.deepEqual(r.betaCandidates(rows,stocks,held,{ticker:'S0'},match,now,1),[]);
 const groups=r.opportunityGroups(candidates,800);assert.equal(groups.portfolio.candidates.length,1);assert.equal(groups.new.candidates.length,3);
});
test('unified settings includes the replacement limit and both empty states display it',async()=>{
 const html=fs.readFileSync('onepiece.html','utf8');for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 const elements={},document={getElementById:id=>elements[id]??={value:'',textContent:'',disabled:false,reportValidity:()=>true,addEventListener(){}}};let value=100;
 const context={document,api:async(path,opts)=>{assert.equal(path,'/api/replacement-ath-age');if(opts)value=JSON.parse(opts.body).replacement_ath_age_days;return {success:true,data:{replacement_ath_age_days:value}};}};
 vm.createContext(context);assert.match(html,/id="user-settings-table"/);assert.match(html,/id="set-replacement-ath-age"/);
 vm.runInContext(fs.readFileSync('rebalancing-ui.js','utf8'),context);vm.runInContext('rebalanceProposal={replacement_ath_age_days:250,opportunities:{portfolio:{candidates:[],combinations:[]},new:{candidates:[],combinations:[]}}}',context);
 for(const scope of ['portfolio','new'])assert.match(context.rebalanceScopeContent(scope,1000),/fewer than 250 days/);
 const server=fs.readFileSync('server.js','utf8');assert.match(server,/replacementAthAgeSetting.schema/);assert.match(server,/replacementAthAgeSettings.get\(uid\)/);assert.match(server,/betaCandidates\(beta.rows,stocks,holdings,source,matchPriceStock,undefined,replacementAthAgeDays\)/);
});
