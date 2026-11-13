const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('user and admin logins respond without calling a blocked price provider',async()=>{
 const source=fs.readFileSync('server.js','utf8');
 const code=source.slice(source.indexOf('app.post("/api/auth/login"'),source.indexOf('app.get("/api/auth/admin-me"'));
 const handlers=new Map();let refreshes=0;
 vm.runInNewContext(code,{app:{post:(path,fn)=>handlers.set(path,fn)},
  db:{prepare:()=>({get:async()=>({id:1,email:'user@test',name:'User',password:'hash',account_status:'approved'})})},
  bcrypt:{compare:async()=>true},signUserToken:()=> 'user-token',signAdminToken:()=> 'admin-token',
  ADMIN_EMAIL:'admin@test',ADMIN_PASSWORD:'pass',
  refreshPricesForSession:()=>{refreshes++;return new Promise(()=>{});}});
 for(const [path,email,token] of [['/api/auth/login','user@test','user-token'],['/api/auth/admin-login','admin@test','admin-token']]){
  let body;
  await handlers.get(path)({body:{email,password:'pass'}},{json:value=>{body=value;}});
  assert.equal(body.token,token);
 }
 assert.equal(refreshes,0);
});

test('portfolio requests finish while a background price refresh remains pending',async()=>{
 const html=fs.readFileSync('onepiece.html','utf8');
 const api=html.slice(html.indexOf('let priceCacheReady='),html.indexOf('async function adminApi'));
 const warm=html.slice(html.indexOf('function warmSessionPrices()'),html.indexOf('function showAdminApp'));
 let finishRefresh;const calls=[],status={};
 const context={TOKEN:'token',BASE:'',document:{getElementById:()=>status},fetch:async(path,opts)=>{
  calls.push({path,opts});
  if(path==='/api/prices/refresh')await new Promise(resolve=>{finishRefresh=resolve;});
  return {status:200,text:async()=>JSON.stringify({success:true,summary:{cached:true}})};
 }};
 vm.createContext(context);vm.runInContext(api+warm,context);
 const refresh=context.warmSessionPrices();
 assert.equal(context.warmSessionPrices(),refresh);
 assert.equal((await context.api('/api/portfolio')).success,true);
 assert.equal(calls.length,2);assert.equal(calls[0].opts.priority,'low');
 finishRefresh();await refresh;
 assert.equal(vm.runInContext('priceCacheReady',context),null);
});

test('universe refresh preserves saved mirror prices on provider failure and budget expiry',async()=>{
 const source=fs.readFileSync('server.js','utf8');
 const code=source.slice(source.indexOf('async function refreshYahooUniverse('),source.indexOf('const coordinatedPriceRefresh='));
 let time=0;const writes=[];
 const context={Date:{now:()=>time},getOnepieceSystemUserId:async()=>1,
  db:{prepare:sql=>({all:async()=>[{ticker:'A'}],run:async(...args)=>writes.push({sql,args})})},
  yahooPrices:{fetchStock:async()=>{throw Error('Provider offline');}}};
 vm.createContext(context);vm.runInContext(code,context);
 const failed=await context.refreshYahooUniverse();
 assert.equal(failed.failed,1);assert.equal(writes.length,1);
 assert.match(writes[0].sql,/SET quote_error=/);assert.ok(!writes[0].sql.includes('cmp='));
 writes.length=0;
 context.Date.now=()=>{time+=76000;return time;};
 const expired=await context.refreshYahooUniverse();
 assert.equal(expired.failed,1);assert.equal(writes.length,0);
});

test('session refresh reports saved quote time across cached, closed and failed refreshes',async()=>{
 const source=fs.readFileSync('server.js','utf8');
 const code=source.slice(source.indexOf('async function refreshPricesForSession(){'),source.indexOf('// ─',source.indexOf('async function refreshPricesForSession(){')));
 let outcome={cached:true},saved='2026-11-13T03:45:18.285Z';
 const ctx={dbReady:Promise.resolve(),getOnepieceSystemUserId:async()=>42,
  coordinatedPriceRefresh:async()=>{if(outcome instanceof Error)throw outcome;return outcome;},
  db:{prepare:sql=>{assert.match(sql,/MAX\(quote_fetched_at\).*user_id=\? AND cmp>0/);return {get:async uid=>{assert.equal(uid,42);return {last_price_updated_at:saved};}};}}};
 vm.createContext(ctx);vm.runInContext(code,ctx);
 for(outcome of [{cached:true},{marketClosed:true},{refreshing:true},new Error('Provider offline')])assert.equal((await ctx.refreshPricesForSession()).last_price_updated_at,saved);
 saved=null;assert.equal((await ctx.refreshPricesForSession()).last_price_updated_at,null);
 saved='invalid';assert.equal((await ctx.refreshPricesForSession()).last_price_updated_at,null);
});

test('shared price banner displays saved update time in IST, including closed markets',async()=>{
 const html=fs.readFileSync('onepiece.html','utf8');
 const warm=html.slice(html.indexOf('function warmSessionPrices()'),html.indexOf('function showAdminApp'));
 const status={};let result;
 const ctx={priceCacheReady:null,document:{getElementById:id=>id==='price-cache-status'?status:null},api:async()=>result};
 vm.createContext(ctx);vm.runInContext(warm,ctx);
 for(const state of [{cached:true},{marketClosed:true},{refreshing:true},{failed:2}]){
  result={success:true,summary:{...state,last_price_updated_at:'2026-11-13T03:45:18.285Z'}};
  await ctx.warmSessionPrices();
  assert.match(status.textContent,/Last price updated: 13 Nov 2026, 09:15:18 am IST/);
 }
 result={success:true,summary:{}};await ctx.warmSessionPrices();assert.match(status.textContent,/Last price updated: Unavailable/);
});
