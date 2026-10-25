const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
test('both opportunity scopes hide blank codes and apply only the current user stock budget',async()=>{
 let handler,override=true;
 const stocks=[{ticker:'A',code:'A1',stock_code:'NSE:A'},{ticker:'B',code:'  '},{ticker:'C',code:''},{ticker:'D',code:'D1',stock_code:'  '},{ticker:'E',code:'E1'}];
 const route=source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'"));
 vm.runInNewContext(route,{app:{get:(p,a,h)=>handler=h},auth(){},getOrSeedSIP:async()=>({max_budget:1000,levels:'[{"fall":-10,"allocation":100}]'}),getOnepieceSystemUserId:async()=>99,namedWatchlists:{stocks:async()=>stocks},matchStock:(h,rows)=>rows.find(r=>r.ticker===h.ticker),fetchPriceFromWatchlistTable:async()=>({price:80,ath:100}),db:{prepare:sql=>({all:async uid=>{if(sql.includes('stock_sip_budgets')){assert.equal(uid,7);return override?[{ticker:'A',max_budget:2400}]:[];}return sql.includes('trade_history')?[]:stocks;}})}});
 for(const scope of ['portfolio','watchlist'])for(const custom of [true,false]){
 override=custom;let body;await handler({user:{id:7},query:{scope}},{set(){return this;},status(){return this;},json:r=>body=r});
 assert.equal(body.success,true);assert.equal(body.data.rows.length,1);
 const row=body.data.rows[0];assert.equal(row.max_budget,custom?2400:1000);assert.equal(row.levels[0].allocated_amount,row.max_budget);assert.equal(row.levels[0].shares_to_buy,Math.floor(row.max_budget/80));
 }
});
test('budget save validates ownership and positive amounts, reset deletes only the user override',async()=>{
 let handler,owned=true,writes=[];
 const route=source.slice(source.indexOf("app.put('/api/sip-stock-budgets/"),source.indexOf('app.get("/api/sip-config"'));
 vm.runInNewContext(route,{app:{put:(p,a,h)=>handler=h},auth(){},db:{prepare:sql=>({get:async(uid,ticker)=>{assert.equal(uid,7);assert.equal(ticker,'A');return owned?{ticker}:null;},run:async(...args)=>writes.push({sql,args})})}});
 async function call(budget){let status=200,body;await handler({user:{id:7},params:{ticker:'A'},body:{max_budget:budget}},{status:n=>{status=n;return {json:r=>body=r};},json:r=>body=r});return {status,body};}
 for(const value of [0,-1,'100',Infinity])assert.equal((await call(value)).status,400);
 owned=false;assert.equal((await call(100)).status,404);assert.equal(writes.length,0);
 owned=true;assert.equal((await call(2500)).body.success,true);assert.deepEqual(writes[0].args,[7,'A',2500]);
 await call(null);assert.match(writes[1].sql,/DELETE/);assert.deepEqual(writes[1].args,[7,'A']);
});
