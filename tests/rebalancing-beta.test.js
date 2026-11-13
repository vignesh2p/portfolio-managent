const {test}=require('node:test'),assert=require('node:assert/strict');
const r=require('../rebalancing');
const {applyOpportunityBeta}=require('../opportunity-beta');
test('Beta excludes funded, invalid, old and source stocks and preserves holding aliases',()=>{
 const rows=['SOURCE','HELD','NEW','FUNDED','INVALID','OLD'].map(ticker=>({ticker,name:ticker,ok_code:ticker,price:80,ath_date:'2026-10-01',fall_pct:-20,max_budget:1000,
  levels:applyOpportunityBeta([{fall:-10,allocation:20,active:false},{fall:-20,allocation:80,active:true}],[],1000,80,100)}));
 rows[3].levels[1].suggested_quantity=0;rows[4].levels[1].investment_error='Unknown history';rows[5].ath_date='2025-01-01';
 const stocks=rows.map(row=>({...row,stock_code:'NSE:'+row.ticker}));
 const match=(h,stocks)=>stocks.find(s=>s.ticker===(h.ticker==='ALIAS'?'HELD':h.ticker));
 const candidates=r.betaCandidates(rows,stocks,[{ticker:'ALIAS',shares:2}],{ticker:'SOURCE'},match,new Date('2026-11-01T00:00:00Z'));
 assert.deepEqual(candidates.map(c=>c.ticker),['ALIAS','NEW']);assert.equal(candidates[0].in_portfolio,true);
 assert.equal(candidates[0].suggested_investment,1000);assert.equal(candidates[0].carry_forward_amount,200);
});
test('Beta combinations use suggestion weights and cap stock capacity and sale proceeds',()=>{
 const rows=[{ticker:'A',price:100,fall:-10,allocation:50,suggested_investment:200},{ticker:'B',price:100,fall:-20,allocation:50,suggested_investment:800}];
 for(const budget of [500,1000,5000]){
  const plans=r.combinations(rows,budget);assert.ok(plans.length);
  for(const plan of plans){assert.ok(plan.total<=budget);for(const buy of plan.buys)assert.ok(buy.shares*buy.price<=buy.suggested_investment);}
 }
 const pair=r.combinations(rows,500).find(p=>p.buys.length===2);assert.deepEqual(pair.buys.map(b=>b.shares),[1,4]);
 assert.equal(r.combinations(rows,5000).find(p=>p.buys.length===2).remaining,4000);
});
test('Rebalance shares Beta budgets, alias trades, cycle ATH and calculations',async()=>{
 const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('server.js','utf8');
 const routes={},stocks=[{ticker:'HELD',stock_code:'NSE:HELD',code:'H',name:'Held',yahoo_finance_code:'HELD.NS'}];
 const owned=[{ticker:'ALIAS',shares:2,avg_price:100}];let cycleCalls=0;
 const context={app:{get:(p,a,h)=>routes[p]=h},auth(){},applyOpportunityBeta,
  getOrSeedSIP:async()=>({max_budget:5000,levels:JSON.stringify([{fall:-10,allocation:20},{fall:-20,allocation:80}])}),
  getOnepieceSystemUserId:async()=>99,matchStock:(h,rows)=>rows.find(s=>s.ticker===(h.ticker==='ALIAS'?'HELD':h.ticker)),
  fetchPriceFromWatchlistTable:async()=>({price:80,ath:90,ath_date:'2026-10-20'}),
  betaCycles:{observe:async input=>{cycleCalls++;assert.equal(input.budget,1000);assert.equal(input.fallback,200);return {ath:100,ath_date:'2026-10-01',base_invested:100};}},
  db:{prepare:sql=>({all:async(...args)=>{
   if(sql.includes('stock_sip_budgets'))return [{ticker:'HELD',max_budget:1000}];
   if(sql.includes('trade_history')){assert.ok(args.includes('ALIAS'));return [{ticker:'ALIAS',type:'BUY',shares:2,price:100}];}
   return sql.includes('FROM portfolio')?owned:stocks;
  }})}};
 vm.createContext(context);vm.runInContext(source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'")),context);
 let result;await routes['/api/portfolio-opportunities']({user:{id:7},query:{mode:'beta'}},{set(){return this;},json(v){result=v;},status(){return this;}});
 assert.equal(result.success,true);
 const rebalance=await context.loadOpportunityData(7,{mode:'beta'},stocks);
 assert.deepEqual(JSON.parse(JSON.stringify(rebalance.rows[0].levels)),JSON.parse(JSON.stringify(result.data.rows[0].levels)));
 assert.equal(rebalance.rows[0].ath,100);assert.equal(rebalance.rows[0].ath_date,'2026-10-01');assert.equal(cycleCalls,2);
 assert.match(source,/rebalancing\.betaCandidates\(beta.rows/);
});
