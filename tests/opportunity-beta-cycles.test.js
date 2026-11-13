const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const {schema,indexSchema,createBetaCycles,historicalCycleStart}=require('../opportunity-beta-cycles');
const {applyOpportunityBeta}=require('../opportunity-beta');
const levels=[10,15,20,25,30].map((allocation,i)=>({allocation,fall:-10*(i+1)}));
const buy=amount=>({ticker:'ABC',type:'BUY',price:amount,shares:1});
test('Yahoo ATH day reconstructs earlier average cost and counts same-day trades in the new cycle',()=>{
 const trades=[{...buy(20000),traded_at:'2025-01-01'},
  {ticker:'ABC',type:'SELL',shares:0.25,price:10000,traded_at:'2025-02-01'},
  {...buy(4000),traded_at:'2025-03-01T12:00:00'},
  {...buy(1000),traded_at:'2025-03-02'}];
 assert.deepEqual(historicalCycleStart('2025-03-01',trades,0,'2026-10-31T12:00:00Z'),{base:15000,resetAt:'2025-03-01T00:00:00+05:30'});
 assert.equal(historicalCycleStart('2025-03-01',[{...buy(4000),traded_at:'2025-02-28T20:00:00Z'}],0,'2026-10-31T12:00:00Z').base,0);
 for(const date of [null,'2025-02-30','2030-01-01'])assert.equal(historicalCycleStart(date,trades,0,'2026-10-31T12:00:00Z'),null);
 assert.equal(historicalCycleStart('2025-03-01',[buy(100)],0,'2026-10-31T12:00:00Z'),null);
 assert.equal(historicalCycleStart('2025-03-01',[],5000,'2026-10-31T12:00:00Z'),null);
 assert.equal(historicalCycleStart('2025-03-01',[],0,'2026-10-31T12:00:00Z').base,0);
});
test('existing observation-date cycle is corrected once, with its old snapshot preserved',async()=>{
 const fs=require('node:fs'),file=require('node:path').join(require('node:os').tmpdir(),'beta-history-'+require('node:crypto').randomUUID()+'.db');
 const db=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
  await db.execute(schema);await db.execute(indexSchema);
  const transaction=async fn=>{const tx=await db.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
  const store=createBetaCycles({db,transaction,now:()=> '2026-10-31T12:00:00Z'});
  const input={userId:1,ticker:'ABC',ath:150,athDate:'2025-03-01',budget:50000,levels,trades:[buy(20000),buy(4000)],price:100};
  const old=await store.observe(input);assert.equal(old.kind,'baseline');const oldSnapshot=JSON.stringify(old.snapshot);
  input.trades[0].traded_at='2025-01-01';input.trades[1].traded_at='2025-03-02';
  const corrected=await store.observe(input);assert.equal(corrected.kind,'yahoo_history');assert.equal(corrected.reset_at,'2025-03-01T00:00:00+05:30');
  assert.equal(corrected.base_invested,20000);assert.equal(corrected.cycle_cap,30000);assert.equal(corrected.snapshot.levels[2].suggested_investment,9500);
  assert.equal(JSON.stringify(corrected.history[0].snapshot),oldSnapshot);
  assert.equal((await store.observe(input)).id,corrected.id);
  const initial=await store.observe({...input,userId:2});assert.equal(initial.kind,'yahoo_history');assert.equal(initial.history.length,0);
  const next=await store.observe({...input,ath:160,athDate:'2025-04-01'});assert.equal(next.base_invested,24000);assert.equal(next.reset_at,'2025-04-01T00:00:00+05:30');
  assert.equal(next.history.length,2);assert.equal(next.snapshot.levels[2].cycle_invested,0);
 }finally{db.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
test('persistent ATH cycles reset only upward, snapshot history, and use remaining capacity',async()=>{
 const fs=require('node:fs'),file=require('node:path').join(require('node:os').tmpdir(),'beta-cycles-'+require('node:crypto').randomUUID()+'.db');
 const db=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
  await db.execute(schema);await db.execute(indexSchema);
  const transaction=async fn=>{const tx=await db.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
  let now='2026-01-01T12:00:00Z';const store=createBetaCycles({db,transaction,now:()=>now});
  const input={userId:1,ticker:'ABC',ath:100,athDate:'2026-01-01',budget:50000,levels,trades:[buy(20000)],price:70};
  const baseline=await store.observe(input);assert.equal(baseline.kind,'baseline');assert.equal(baseline.base_invested,0);
  const original=JSON.stringify(baseline.snapshot);
  now='2026-02-01T12:00:00Z';input.ath=120;input.athDate='2026-02-01';input.price=120;
  const reset=await store.observe(input);assert.equal(reset.base_invested,20000);assert.equal(reset.cycle_cap,30000);
  assert.deepEqual(reset.snapshot.levels.map(l=>l.cumulative_allocation),[3000,7500,13500,21000,30000]);
  assert.deepEqual(reset.snapshot.levels.map(l=>l.total_exposure_target),[23000,27500,33500,41000,50000]);
  assert.equal(JSON.stringify(reset.history[0].snapshot),original);
  input.trades.push(buy(4000));input.price=84;
  const afterBuy=await store.observe(input);assert.equal(afterBuy.id,reset.id);assert.equal(afterBuy.base_invested,20000);
  assert.equal(afterBuy.snapshot.levels[2].cycle_invested,4000);assert.equal(afterBuy.snapshot.levels[2].carry_forward_amount,3500);
  assert.equal(afterBuy.snapshot.levels[2].suggested_investment,9500);assert.equal(afterBuy.snapshot.levels[2].suggested_quantity,113);
  assert.equal(afterBuy.snapshot.levels[2].active,true);
  // Lower ATH, unavailable quotes, and equal highs must not reset.
  assert.equal((await store.observe({...input,ath:110})).id,reset.id);
  assert.equal((await store.observe({...input,ath:130,allowReset:false})).id,reset.id);
  const reopened=createBetaCycles({db,transaction,now:()=>now});assert.equal((await reopened.observe(input)).id,reset.id);
  const next=await store.observe({...input,ath:140});assert.equal(next.base_invested,24000);assert.equal(next.cycle_cap,26000);assert.equal(next.history.length,2);
  assert.equal(next.snapshot.levels[2].cycle_invested,0);assert.equal(next.snapshot.levels[2].suggested_investment,11700);
  const other=await store.observe({...input,userId:2});assert.equal(other.kind,'baseline');assert.equal(other.history.length,0);
  const records=(await db.execute('SELECT * FROM opportunity_beta_cycles')).rows;assert.equal(records.length,4);
 }finally{db.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
test('cycle accounting handles sales, depleted budgets and budget edits without changing its base',()=>{
 const cycle={base_invested:20000};
 let result=applyOpportunityBeta(levels,[buy(20000),buy(4000)],50000,100,150,0,cycle);
 assert.equal(result[2].suggested_investment,9500);assert.equal(result[2].suggested_quantity,95);
 result=applyOpportunityBeta(levels,[buy(50000)],50000,100,150,0,cycle);assert.ok(result.every(l=>l.suggested_investment===0));
 result=applyOpportunityBeta(levels,[buy(24000)],18000,100,150,0,cycle);assert.ok(result.every(l=>l.suggested_investment===0));
 result=applyOpportunityBeta(levels,[buy(24000)],60000,100,150,0,cycle);assert.equal(result[2].cycle_cap,40000);assert.equal(result[2].suggested_investment,14000);
 result=applyOpportunityBeta(levels,[buy(20000),{ticker:'ABC',type:'SELL',price:15000,shares:0.5}],50000,100,150,0,cycle);
 assert.equal(result[2].cycle_invested,-10000);assert.equal(result[2].suggested_investment,23500);
 assert.ok(result.every(l=>l.total_invested+l.suggested_investment<=50000));assert.equal(cycle.base_invested,20000);
});
test('shared quote refresh observes higher ATH for tracked users with their own budgets',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
 const code=source.slice(source.indexOf('async function syncBetaCyclesForQuote'),source.indexOf('function matchPriceStock'));
 const stock={ticker:'ABC',stock_code:'NSE:ABC',yahoo_finance_code:'ABC.NS'},seen=[];
 const context={matchStock:require('../stock-code-settings').matchStock,betaCycles:{observe:async input=>seen.push(input)},
  getOrSeedSIP:async()=>({max_budget:50000,levels:JSON.stringify(levels)}),
  db:{prepare:sql=>({all:async(...args)=>{
   if(sql.includes('opportunity_beta_cycles')){assert.match(sql,/ath<\?/);assert.deepEqual(args,['ABC',120]);return [{user_id:7}];}
   assert.equal(args[0],7);
   if(sql.includes('stock_sip_budgets'))return [{ticker:'NSE:ABC',max_budget:60000}];
   if(sql.includes('trade_history'))return [buy(20000)];
   return [{ticker:'ABC',shares:1,avg_price:20000}];
  }})}};
 vm.createContext(context);vm.runInContext(code,context);
 await context.syncBetaCyclesForQuote(stock,{ath:120,ath_date:'2026-10-31',price:120});
 assert.equal(seen.length,1);assert.equal(seen[0].budget,60000);assert.equal(seen[0].userId,7);assert.equal(seen[0].fallback,20000);
 await context.syncBetaCyclesForQuote(stock,{ath:130,price:130,stale:true});assert.equal(seen.length,1);
});
