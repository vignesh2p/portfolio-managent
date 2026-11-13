const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DEFAULTS,validateSettings,financialYear,longTermFrom,tax,analyzeAccount,familyReview}=require('../tax-harvesting');
const now=new Date('2026-10-30T10:00:00Z');
const trade=(id,type,shares,price,traded_at,ticker='ABC')=>({id,type,shares,price,traded_at,ticker});
const holding=(shares,current_price=100,ticker='ABC')=>({shares,current_price,ticker,quote_fetched_at:now.toISOString()});
const analyze=(trades,holdings,extra={})=>analyzeAccount({user:{id:1,name:'A'},trades,holdings,now,...extra});
test('FY rolls at midnight IST on April 1 and long term starts after anniversary',()=>{
 assert.equal(financialYear('2026-03-31').year,2025);assert.equal(financialYear('2026-04-01').year,2026);
 assert.equal(longTermFrom('2025-10-30',12),'2026-10-31');assert.equal(longTermFrom('2024-02-29',12),'2025-03-01');
 const a=analyze([trade(1,'BUY',2,10,'2025-10-30'),trade(2,'SELL',1,20,'2026-10-30')],[holding(1)]);
 assert.equal(a.realized.stcg,10);assert.equal(a.realized.ltcg,0);
});
test('FIFO uses prior-year buys and sells, partial lots and fully exited stocks',()=>{
 const a=analyze([trade(1,'BUY',100,10,'2024-01-01'),trade(2,'SELL',40,20,'2025-01-02'),trade(3,'BUY',100,20,'2026-05-01'),trade(4,'SELL',80,30,'2026-06-01')],[holding(80)]);
 assert.equal(a.complete,true);assert.equal(a.realized.ltcg,1200);assert.equal(a.realized.stcg,200);
 assert.equal(a.positions[0].lots[0].quantity,80);
 const exited=analyze([trade(1,'BUY',10,10,'2024-01-01'),trade(2,'SELL',10,20,'2026-06-01')],[]);
 assert.equal(exited.realized.ltcg,100);
});
test('loss setoff prioritizes STCG and never uses LTCL against STCG',()=>{
 assert.equal(tax({ltcg:100000,ltcl:200000,stcg:100000,stcl:0}).tax,20000);
 assert.equal(tax({ltcg:225000,ltcl:0,stcg:100000,stcl:150000}).tax,6250);
 assert.equal(tax({ltcg:225000,ltcl:50000,stcg:100000,stcl:150000}).tax,0);
});
test('gain harvesting shares one exemption across all securities',()=>{
 const a=analyze([trade(1,'BUY',2000,100,'2024-01-01'),trade(2,'BUY',2000,100,'2024-01-01','XYZ')],[holding(2000,200),holding(2000,200,'XYZ')]);
 assert.equal(a.recommendations.reduce((s,r)=>s+r.exemption_used,0),125000);
 assert.equal(a.recommendations[0].quantity,1250);assert.equal(a.after.tax,0);
 assert.equal(a.recommendations[0].estimated_tax_saving,0);
});

test('gain suggestions sum applicable FIFO lots including a partially used final lot',()=>{
 const a=analyze([trade(1,'BUY',500,100,'2024-01-01'),trade(2,'BUY',1000,50,'2024-03-01')],[{...holding(1500,200),stock_name:'ABC Industries'}]);
 assert.equal(a.recommendations.length,1);
 const r=a.recommendations[0];
 assert.equal(r.quantity,1000);assert.equal(r.lot_count,2);assert.equal(r.stock_name,'ABC Industries');
 assert.equal(r.buy_date,'2024-01-01');assert.equal(r.buy_date_end,'2024-03-01');
 assert.equal(r.estimated_pnl,125000);assert.equal(r.exemption_used,125000);assert.equal(r.estimated_proceeds,200000);
 assert.equal(a.after.tax,0);assert.equal(a.positions[0].quantity,1500);
});

test('loss suggestions sum quantities, losses and tax savings without mixing harvest types',()=>{
 const a=analyze([
  trade(1,'BUY',2000,10,'2024-01-01','SOLD'),trade(2,'SELL',2000,110,'2026-06-01','SOLD'),
  trade(3,'BUY',10,200,'2024-01-01'),trade(4,'BUY',20,150,'2024-02-01'),
  trade(5,'BUY',10,200,'2026-04-01'),trade(6,'BUY',20,150,'2026-05-01')
 ],[holding(60)]);
 assert.equal(a.recommendations.length,2);
 assert.deepEqual(a.recommendations.map(r=>[r.sequence,r.category,r.quantity,r.lot_count,r.estimated_pnl,r.estimated_tax_saving]),[
  [1,'LTCL Loss Harvest',30,2,-2000,250],[2,'STCL Loss Harvest',30,2,-2000,250]
 ]);
 assert.equal(a.before.tax-a.after.tax,500);
});
test('STCL plan cannot double count already offset gains',()=>{
 const a=analyze([trade(1,'BUY',100,10,'2026-04-01','SOLD'),trade(2,'SELL',100,110,'2026-06-01','SOLD'),trade(3,'BUY',200,200,'2026-04-01'),trade(4,'BUY',200,200,'2026-04-01','XYZ')],[holding(200),holding(200,100,'XYZ')]);
 assert.equal(a.before.tax,2000);assert.equal(a.after.tax,0);
 assert.equal(a.recommendations.length,1);assert.equal(a.recommendations[0].quantity,100);
 assert.equal(a.recommendations[0].category,'STCL Loss Harvest');
});
test('LTCL does not trigger a loss sale for STCG only',()=>{
 const a=analyze([trade(1,'BUY',100,10,'2026-04-01','SOLD'),trade(2,'SELL',100,110,'2026-06-01','SOLD'),trade(3,'BUY',200,200,'2024-04-01')],[holding(200)]);
 assert.equal(a.before.tax,2000);assert.equal(a.recommendations.length,0);
});
test('never selects later losing lot ahead of an older unsold profitable lot',()=>{
 const a=analyze([trade(1,'BUY',10,50,'2026-04-01'),trade(2,'BUY',20,200,'2026-05-01'),trade(3,'BUY',100,10,'2026-04-01','SOLD'),trade(4,'SELL',100,110,'2026-06-01','SOLD')],[holding(30)]);
 assert.equal(a.recommendations.length,0);
});
test('unmatched sells, mismatched holdings, bad dates and grandfathering suppress estimates',()=>{
 for(const [trades,holdings] of [
  [[trade(1,'SELL',10,100,'2026-05-01')],[]],
  [[trade(1,'BUY',10,100,'2025-05-01')],[holding(12)]],
  [[trade(1,'BUY',10,100,'2026-02-30')],[holding(10)]],
  [[trade(1,'BUY',10,100,'2017-05-01')],[holding(10)]]
 ]){const a=analyze(trades,holdings);assert.equal(a.complete,false);assert.equal(a.before,null);assert.equal(a.recommendations.length,0);assert.ok(a.issues.length);}
});
test('stale quotes and fractional quantities block sale recommendations',()=>{
 const a=analyze([trade(1,'BUY',10,10,'2024-01-01')],[{...holding(10),quote_fetched_at:'2026-01-01'}]);
 assert.equal(a.complete,true);assert.equal(a.recommendations.length,0);assert.match(a.positions[0].blocked,/stale/);
 const b=analyze([trade(1,'BUY',1.5,10,'2024-01-01')],[holding(1.5)]);assert.equal(b.recommendations.length,0);
});
test('family review uses identity and keeps taxpayer exemptions separate',()=>{
 const a=analyze([trade(1,'BUY',2000,100,'2024-01-01')],[holding(2000,200)]);
 const b=analyze([trade(1,'BUY',2000,100,'2024-01-01')],[holding(2000,200)],{user:{id:2,name:'B'}});
 familyReview([a,b],new Map([[2,[trade(2,'BUY',1,100,'2026-10-20')]]]),DEFAULTS,'2026-10-30');
 assert.equal(a.recommendations[0].exemption_used,125000);assert.equal(b.recommendations[0].exemption_used,125000);
 assert.equal(a.recommendations[0].family_flags.length,2);
});
test('admin settings reject missing, strings, nonfinite and out of range values',()=>{
 assert.deepEqual(validateSettings(DEFAULTS),DEFAULTS);
 for(const values of [{...DEFAULTS,stcg_rate:101},{...DEFAULTS,ltcg_exemption:-1},{...DEFAULTS,holding_months:12.1},{...DEFAULTS,stcg_rate:'20'},{}])assert.throws(()=>validateSettings(values));
});
test('fully sold grandfathered lots and blank costs cannot produce tax estimates',()=>{
 const a=analyze([trade(1,'BUY',10,100,'2017-01-01'),trade(2,'SELL',10,200,'2026-06-01')],[]);
 assert.equal(a.complete,false);assert.equal(a.before,null);
 for(const price of ['',null,false])assert.equal(analyze([trade(1,'BUY',10,price,'2025-01-01')],[holding(10)]).complete,false);
 assert.equal(analyze([trade(1,'BUY',10,0,'2025-01-01')],[holding(10)]).complete,true);
});
test('zero configured rates do not trigger loss sales with zero benefit',()=>{
 const a=analyze([trade(1,'BUY',10,10,'2026-04-01','SOLD'),trade(2,'SELL',10,20,'2026-06-01','SOLD'),trade(3,'BUY',100,200,'2026-04-01')],[holding(100)],{settings:{...DEFAULTS,stcg_rate:0}});
 assert.equal(a.recommendations.length,0);
});
