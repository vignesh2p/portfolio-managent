const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {schema,validate,preview,createService,register}=require('../corporate-actions');
const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
const context=vm.createContext({});vm.runInContext(server.slice(server.indexOf('async function _rebuildPortfolioForTicker'),server.indexOf('// Startup reconciliation')),context);
async function setup(t){
 const file=path.join(require('node:os').tmpdir(),'actions-'+require('node:crypto').randomUUID()+'.db');
 const client=require('@libsql/client').createClient({url:require('node:url').pathToFileURL(file).href});
 t.after(()=>{client.close();try{fs.unlinkSync(file);}catch(e){if(!['EPERM','EBUSY'].includes(e.code))throw e;}});
 await client.executeMultiple(`CREATE TABLE portfolio(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,shares REAL,avg_price REAL,yahoo_finance_code TEXT,stock_name TEXT,ok_code TEXT,UNIQUE(user_id,ticker));
 CREATE TABLE trade_history(id INTEGER PRIMARY KEY,user_id INTEGER,exchange TEXT DEFAULT '',ticker TEXT,type TEXT,shares REAL,price REAL,amount REAL,notes TEXT,traded_at TEXT,yahoo_finance_code TEXT,stock_name TEXT,ok_code TEXT);${schema.join(';')};
 UPDATE corporate_action_rollout SET baseline='2026-01-01';
 INSERT INTO portfolio VALUES(1,1,'LOCAL',90,100,'ABC.NS','ABC',''),(2,2,'LOCAL',5,100,'ABC.NS','ABC','');
 INSERT INTO trade_history(user_id,ticker,type,shares,price,amount,traded_at) VALUES(1,'LOCAL','BUY',100,100,10000,'2025-06-01'),(1,'LOCAL','SELL',20,150,3000,'2026-01-05'),(1,'LOCAL','BUY',10,100,1000,'2026-03-01'),(2,'LOCAL','BUY',5,100,500,'2025-06-01');`);
 const db={prepare:sql=>({all:async(...args)=>(await client.execute({sql,args})).rows.map(r=>({...r})),get:async(...args)=>(await client.execute({sql,args})).rows[0],run:async(...args)=>client.execute({sql,args})})};
 const options={db,transaction:async fn=>{const tx=await client.transaction('write');try{const value=await fn(tx);await tx.commit();return value;}catch(e){await tx.rollback();throw e;}finally{tx.close();}},yf:{chart:async()=>({events:{splits:[]}})},universe:async()=>[],matchStock:()=>null,rebuild:context._rebuildPortfolioForTicker,now:()=> '2026-04-01'};
 return {client,db,options,s:createService(options)};
}
const action=(kind='split',ex_date='2026-02-01',numerator=2,denominator=1)=>({ticker:'ABC.NS',kind,ex_date,numerator,denominator,description:'Verified announcement'});
async function pending(s,uid=1){return (await s.list(uid)).actions.find(a=>a.status==='pending');}
const request=(a,decision='apply')=>({holding_ticker:a.holding_ticker,fingerprint:a.plan.fingerprint,decision,verified:true});
test('validates ratios, dates and action types',()=>{
 assert.equal(validate(action()).ticker,'ABC.NS');
 for(const a of [{...action(),ex_date:'2026-02-30'},action('split','2026-02-01',1,2),action('reverse_split','2026-02-01',2,1),{...action(),numerator:Infinity},{...action(),kind:'bogus'}])assert.throws(()=>validate(a));
});
test('history starts at each oldest buy and baseline history stays read without adjusting trades',async t=>{
 const {s,db}=await setup(t);await s.add(action('split','2025-01-01'),'admin');await s.add(action('split','2025-12-01'),'admin');
 const data=await s.list(1);assert.equal(data.actions.length,1);assert.equal(data.actions[0].status,'read');assert.equal(data.pending,0);
 await assert.rejects(s.decide(1,data.actions[0].id,request(data.actions[0])),/already handled/);
 assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=1').get()).shares,90);
});
test('split adjusts only pre-ex-date trades, preserves cash, isolates users and rejects duplicate apply',async t=>{
 const {s,db}=await setup(t);await s.add(action(),'admin');let a=await pending(s);assert.equal(a.plan.eligible_shares,80);assert.equal(a.plan.resulting_shares,170);
 await s.decide(1,a.id,request(a));
 const trades=await db.prepare('SELECT * FROM trade_history WHERE user_id=1 ORDER BY id').all();
 assert.deepEqual(trades.map(t=>[t.shares,t.price,t.amount]),[[200,50,10000],[40,75,3000],[10,100,1000]]);assert.match(trades[0].notes,/Split/);
 const h=await db.prepare('SELECT * FROM portfolio WHERE user_id=1').get();assert.equal(h.shares,170);assert.ok(Math.abs(h.avg_price-9000/170)<.0001);
 assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=2').get()).shares,5);
 assert.equal((await s.list(1)).pending,0);assert.equal((await s.list(2)).pending,1);
 await assert.rejects(s.decide(1,a.id,request(a)),/already handled/);
});
test('bonus adds a zero-cost BUY based on ex-date quantity and keeps paid trades intact',async t=>{
 const {s,db}=await setup(t);await s.add(action('bonus','2026-03-01',1,1),'admin');const a=await pending(s);assert.equal(a.plan.eligible_shares,80);
 await s.decide(1,a.id,request(a));const trades=await db.prepare('SELECT * FROM trade_history WHERE user_id=1 ORDER BY id').all();assert.equal(trades.length,4);
 assert.equal(trades[3].shares,80);assert.equal(trades[3].price,0);assert.equal(trades[3].amount,0);assert.match(trades[3].notes,/Bonus/);assert.equal(trades[3].traded_at,'2026-03-01');
 assert.equal(trades[0].shares,100);assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=1').get()).shares,170);
});
test('ignore persists without changing holdings; previews are invalidated by trade edits',async t=>{
 const {s,db}=await setup(t);await s.add(action(),'admin');const a=await pending(s);
 await db.prepare("UPDATE trade_history SET notes='edited' WHERE id=1").run();await assert.rejects(s.decide(1,a.id,request(a)),/changed/);
 const fresh=await pending(s);await s.decide(1,fresh.id,request(fresh,'ignore'));assert.equal((await s.list(1)).actions[0].status,'ignored');assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=1').get()).shares,90);
 await assert.rejects(s.add(action(),'admin'),/already been handled/);
});
test('future actions stay pending and cannot apply early; resolve actions chronologically',async t=>{
 const {s}=await setup(t);await s.add(action('split','2026-05-01'),'admin');const future=await pending(s);await assert.rejects(s.decide(1,future.id,request(future)),/ex-date/);assert.equal((await s.list(1)).pending,1);
 await s.add(action('bonus','2026-02-01',1,1),'admin');await s.add(action('split','2026-03-01'),'admin');const later=(await s.list(1)).actions.find(a=>a.ex_date==='2026-03-01');await assert.rejects(s.decide(1,later.id,request(later)),/earlier actions/);
});
test('reverse split preserves value; fractional entitlements and demergers require manual handling',async t=>{
 const {s,db}=await setup(t);await s.add(action('reverse_split','2026-02-01',1,2),'admin');const a=await pending(s);await s.decide(1,a.id,request(a));assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=1').get()).shares,50);
 const user2=await pending(s,2);await assert.rejects(s.decide(2,user2.id,request(user2)),/Fractional/);
 const plan=preview(action('demerger'),[{type:'BUY',shares:10,traded_at:'2025-01-01'}],{shares:10},'2026-04-01');assert.match(plan.blocked,/Demerger/);
});
test('feed starts at oldest buy, caches history, surfaces outages and yields to verified admin bonus',async t=>{
 const {options,s,db}=await setup(t);let calls=0;
 options.yf.chart=async(ticker,query)=>{calls++;assert.equal(ticker,'ABC.NS');assert.equal(query.period1,'2025-06-01');return {events:{splits:[{date:new Date('2026-02-01'),numerator:2,denominator:1}]}};};
 await s.sync(1);await s.sync(1);assert.equal(calls,1);assert.equal((await pending(s)).source,'Yahoo Finance');
 await s.add(action('bonus','2026-02-01',1,1),'admin');assert.equal((await s.list(1)).actions.length,1);assert.equal((await pending(s)).kind,'bonus');
 await db.prepare('DELETE FROM corporate_action_fetch').run();await s.sync(1);assert.equal((await s.list(1)).actions.length,1);
 options.yf.chart=async()=>{throw Error('offline');};await db.prepare('DELETE FROM corporate_action_fetch').run();assert.equal((await s.sync(1)).length,1);assert.equal((await s.list(1)).pending,1);
});
test('failed rebuild rolls back every trade change and leaves action pending',async t=>{
 const {s,db,options}=await setup(t);await s.add(action(),'admin');const a=await pending(s);const broken=createService({...options,rebuild:async()=>{throw Error('disk failure');}});
 await assert.rejects(broken.decide(1,a.id,request(a)),/disk failure/);assert.equal((await db.prepare('SELECT shares FROM trade_history WHERE id=1').get()).shares,100);assert.equal((await s.list(1)).pending,1);
});
test('selling an eligible stock does not silently dismiss its pending notification',async t=>{
 const {s,db}=await setup(t);await s.add(action('bonus','2026-02-01',1,1),'admin');await pending(s);
 await db.prepare("INSERT INTO trade_history(user_id,ticker,type,shares,price,amount,traded_at) VALUES(1,'LOCAL','SELL',90,100,9000,'2026-03-02')").run();
 await db.prepare('DELETE FROM portfolio WHERE user_id=1').run();
 const a=await pending(s);assert.equal(a.plan.eligible_shares,80);assert.equal(a.plan.resulting_shares,80);
 await s.decide(1,a.id,request(a));assert.equal((await db.prepare('SELECT shares FROM portfolio WHERE user_id=1').get()).shares,80);assert.equal((await s.list(1)).pending,0);
});
test('all routes use the correct user or administrator authentication middleware',async t=>{
 const {options}=await setup(t),routes=[],auth=()=>{},adminAuth=()=>{};
 register({get:(...r)=>routes.push(r),post:(...r)=>routes.push(r)},{...options,auth,adminAuth});
 assert.equal(routes.length,5);for(const route of routes)assert.equal(route[1],route[0].startsWith('/api/admin/')?adminAuth:auth);
});
