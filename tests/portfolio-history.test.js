const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {schema,totals,indiaDate,fillHistoricalDayChanges,createHistory}=require('../portfolio-history');
const {matchStock}=require('../stock-code-settings');
const now=new Date('2026-11-05T10:30:00Z');
const quotes=[{ticker:'A',price:110,prevClose:100,quote_fetched_at:now.toISOString(),price_as_of:now.toISOString()}, {ticker:'B',price:40,change:-10,quote_fetched_at:now.toISOString()}];
const holdings=[{ticker:'A',shares:10,avg_price:80},{ticker:'B',shares:20,avg_price:60}];
test('day change is weighted by previous value, profit uses holding cost, zero and missing are distinct',()=>{
 const sum=totals(holdings,h=>matchStock(h,quotes),now);
 assert.equal(sum.portfolio_value,1900);assert.equal(sum.profit_value,-100);assert.equal(sum.day_change,-100);assert.equal(sum.day_change_pct,-5);
 const ui={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../portfolio-history-ui.js'),'utf8'),ui);
 assert.equal(ui.portfolioDayChange(holdings,{A:quotes[0],B:quotes[1]}).pct,-5);
 assert.equal(ui.portfolioDayChange(holdings,{A:quotes[0]}),null);
 const missing=totals(holdings,()=>null,now);assert.equal(missing.portfolio_value,null);assert.equal(missing.profit_value,null);assert.equal(missing.missing_prices,2);
 const empty=totals([],()=>null,now);assert.equal(empty.portfolio_value,0);assert.equal(empty.day_change_pct,0);
 assert.equal(totals(holdings,h=>({...matchStock(h,quotes),stale:true}),now).stale_prices,2);
 assert.equal(indiaDate(new Date('2026-11-05T18:30:00Z')),'2026-11-06');
});
test('daily capture saves every user, is immutable on retry, isolates history and protects cron',async t=>{
 const file=path.join(require('node:os').tmpdir(),'history-'+require('node:crypto').randomUUID()+'.db');
 const client=require('@libsql/client').createClient({url:require('node:url').pathToFileURL(file).href});
 t.after(()=>{client.close();try{fs.unlinkSync(file);}catch{}});
 await client.executeMultiple(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT); CREATE TABLE trade_history(user_id INTEGER,traded_at TEXT); CREATE TABLE portfolio(user_id INTEGER,ticker TEXT,shares REAL,avg_price REAL); ${schema}; INSERT INTO users VALUES(1,'one@test'),(2,'two@test'),(3,'empty@test'),(4,'system@test'); INSERT INTO portfolio VALUES(1,'A',10,80),(2,'MISSING',5,20);`);
 const db={prepare:sql=>({all:async(...args)=>(await client.execute({sql,args})).rows})};
 let clock=now,refreshes=0;
 const service=createHistory({db,transaction:async fn=>{const tx=await client.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}},universe:async()=>quotes,matchStock,refresh:async()=>{refreshes++;},systemEmail:'system@test',now:()=>clock,secret:()=> 'test-secret'});
 const res=()=>({statusCode:200,set(){return this;},status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}});
 let r=res();await service.cron({headers:{},query:{}},r);assert.equal(r.statusCode,401);assert.equal(refreshes,0);
 const req={headers:{authorization:'Bearer test-secret'},query:{}};
 clock=new Date('2026-11-05T10:29:59Z');r=res();await service.cron(req,r);assert.equal(r.body.skipped,true);
 clock=now;r=res();await service.cron(req,r);assert.equal(r.body.saved,3);assert.equal(r.body.missing_prices,1);
 await client.execute('UPDATE portfolio SET shares=99 WHERE user_id=1');
 r=res();await service.cron(req,r);assert.equal(r.body.saved,0);
 r=res();await service.history({user:{id:1}},r);assert.equal(r.body.data.length,1);assert.equal(r.body.data[0].portfolio_value,1100);assert.equal(r.body.data[0].profit_value,300);assert.equal(r.body.data[0].day_change,100);assert.equal(r.body.data[0].day_change_pct,10);
 r=res();await service.history({user:{id:2}},r);assert.equal(r.body.data[0].portfolio_value,null);assert.equal(r.body.data[0].day_change,null);
 r=res();await service.history({user:{id:3}},r);assert.equal(r.body.data[0].portfolio_value,0);
 r=res();await service.history({user:{id:4}},r);assert.equal(r.body.data.length,0);
 clock=new Date('2026-11-07T10:30:00Z');r=res();await service.cron(req,r);assert.equal(r.body.saved,3); // weekends also have a daily snapshot
 r=res();await service.history({user:{id:1}},r);assert.deepEqual(r.body.data.map(x=>x.snapshot_date),['2026-11-05','2026-11-07']);
});

test('legacy daily changes use consecutive unchanged holdings and explain missing evidence',()=>{
 const rows=[{snapshot_date:'2026-11-04',recorded_at:'2026-11-04T10:30:00Z',portfolio_value:1000,cost_value:800,holding_count:1,day_change:null},{snapshot_date:'2026-11-05',recorded_at:'2026-11-05T10:30:00Z',portfolio_value:950,cost_value:800,holding_count:1,day_change:null}];
 const result=fillHistoricalDayChanges(rows,[]);
 assert.equal(result[0].day_change,null);assert.match(result[0].day_change_reason,/Previous daily/);
 assert.equal(result[1].day_change,-50);assert.equal(result[1].day_change_pct,-5);assert.equal(result[1].day_change_source,'saved_snapshots');
 assert.equal(rows[1].day_change,null);
 for(const trade of ['2026-11-05T09:00:00Z','invalid'])assert.equal(fillHistoricalDayChanges(rows,[{traded_at:trade}])[1].day_change,null);
 assert.equal(fillHistoricalDayChanges([rows[0],{...rows[1],cost_value:900}],[])[1].day_change,null);
 assert.equal(fillHistoricalDayChanges([rows[0],{...rows[1],snapshot_date:'2026-11-06'}],[])[1].day_change,null);
 assert.equal(fillHistoricalDayChanges([rows[0],{...rows[1],day_change:20,day_change_pct:2}],[])[1].day_change,20);
 assert.equal(fillHistoricalDayChanges([rows[0],{...rows[1],portfolio_value:null}],[])[1].day_change,null);
});
