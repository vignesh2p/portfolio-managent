const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {matchStock}=require('../stock-code-settings');
const {applyOpportunityBeta}=require('../opportunity-beta');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
function setup(){
 const state={price:80,ath:100,trades:[],owned:[],budget:10000,cycle:null};
 const stocks=[{ticker:'ABC.NS',stock_code:'NSE:ABC',yahoo_finance_code:'ABC.NS',code:'',name:'ABC'}];
 let handler;
 vm.runInNewContext(source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'")),{
  app:{get:(p,a,h)=>handler=h},auth(){},matchStock,applyOpportunityBeta,betaCycles:{observe:async()=>state.cycle},getOnepieceSystemUserId:async()=>99,
  getOrSeedSIP:async()=>({max_budget:1000,levels:JSON.stringify([{fall:-10,allocation:10},{fall:-20,allocation:20},{fall:-30,allocation:70}])}),
  namedWatchlists:{stocks:async()=>stocks},fetchPriceFromWatchlistTable:async()=>({price:state.price,ath:state.ath}),
  db:{prepare:sql=>({all:async()=>sql.includes('stock_sip_budgets')?[{ticker:'ABC.NS',max_budget:state.budget}]:sql.includes('trade_history')?state.trades:sql.includes('FROM portfolio')?state.owned:stocks})}
 });
 return {state,call:async(scope='watchlist',mode)=>{let body;await handler({user:{id:1},query:{scope,mode}},{set(){return this;},status(){return this;},json:b=>body=b});assert.equal(body.success,true,body.error);return body.data.rows;}};
}
test('zone allocations remain independent of skipped zones and prior purchases',async()=>{
 const {state,call}=setup();
 for(const trades of [[],[{type:'BUY',price:90,shares:5}],[{type:'BUY',price:80,shares:1000}]]){
  state.trades=trades;
  const levels=(await call())[0].levels;
  assert.deepEqual(Array.from(levels,l=>l.allocated_amount),[1000,2000,7000]);
  assert.deepEqual(Array.from(levels,l=>l.shares_to_buy),[12,25,87]);
  assert.equal(levels[1].active,true);
  assert.equal(levels[1].suggested_amount,undefined);
 }
 state.price=70;assert.equal((await call())[0].levels[2].shares_to_buy,100);
 state.price=0;assert.ok((await call())[0].levels.every(l=>l.shares_to_buy===0));
});
test('watchlist excludes owned Yahoo identities, portfolio includes edited tickers and code-less discoveries',async()=>{
 const {state,call}=setup();
 state.owned=[{ticker:'MY-ABC',yahoo_finance_code:'ABC.NS'}];
 assert.equal((await call()).length,0);
 const rows=await call('portfolio');assert.equal(rows.length,1);assert.equal(rows[0].levels[1].allocated_amount,2000);
 state.owned=[];assert.equal((await call()).length,1);
});

test('Beta API adds carry-forward fields only when requested and honors stock budget',async()=>{
 const {state,call}=setup();state.budget=1000;
 state.trades=[{type:'BUY',price:50,shares:1}];
 const beta=(await call('watchlist','beta'))[0];
 assert.equal(beta.levels[1].carry_forward_amount,50);
 assert.equal(beta.levels[1].allocated_amount,200);
 assert.equal(beta.levels[1].suggested_investment,250);
 assert.equal(beta.levels[1].suggested_quantity,3);
 const normal=(await call())[0];
 assert.equal(normal.levels[1].allocated_amount,200);
 assert.equal(normal.levels[1].suggested_investment,undefined);
});
test('Beta API recalculates sales, fallback holdings, price and budget changes',async()=>{
 const {state,call}=setup();state.budget=1000;
 state.owned=[{ticker:'ABC.NS',shares:2,avg_price:40}];
 let row=(await call('portfolio','beta'))[0];assert.equal(row.levels[1].total_invested,80);
 state.trades=[{ticker:'ABC.NS',type:'BUY',shares:4,price:40},{ticker:'ABC.NS',type:'SELL',shares:2,price:100}];
 row=(await call('portfolio','beta'))[0];assert.equal(row.levels[1].suggested_investment,220);
 state.price=70;state.budget=2000;row=(await call('portfolio','beta'))[0];
 assert.equal(row.levels[2].active,true);assert.equal(row.levels[2].cumulative_allocation,2000);
 assert.equal(row.levels[2].suggested_investment,1920);assert.equal(row.levels[2].suggested_quantity,27);
});
test('Beta API uses saved cycle ATH and base without changing ordinary opportunities',async()=>{
 const {state,call}=setup();state.budget=50000;state.price=100;state.ath=140;
 state.trades=[{type:'BUY',shares:1,price:24000}];state.cycle={ath:150,base_invested:20000,ath_date:'2026-10-31',history:[]};
 const beta=(await call('watchlist','beta'))[0];
 assert.equal(beta.ath,150);assert.equal(beta.levels[2].active,true);assert.equal(beta.levels[0].trigger_price,135);
 assert.equal(beta.levels[1].allocated_amount,6000);assert.equal(beta.levels[1].cumulative_allocation,9000);
 assert.equal(beta.levels[1].suggested_investment,5000);assert.equal(beta.levels[1].cycle_invested,4000);
 const normal=(await call())[0];assert.equal(normal.ath,140);assert.equal(normal.levels[1].allocated_amount,10000);assert.equal(normal.beta_cycle,undefined);
});
