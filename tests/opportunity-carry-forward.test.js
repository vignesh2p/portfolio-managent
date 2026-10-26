const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {matchStock}=require('../stock-code-settings');
const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
function setup(){
 const state={price:80,ath:100,trades:[],owned:[],budget:10000};
 const stocks=[{ticker:'ABC.NS',stock_code:'NSE:ABC',yahoo_finance_code:'ABC.NS',code:'',name:'ABC'}];
 let handler;
 vm.runInNewContext(source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'")),{
  app:{get:(p,a,h)=>handler=h},auth(){},matchStock,getOnepieceSystemUserId:async()=>99,
  getOrSeedSIP:async()=>({max_budget:1000,levels:JSON.stringify([{fall:-10,allocation:10},{fall:-20,allocation:20},{fall:-30,allocation:70}])}),
  namedWatchlists:{stocks:async()=>stocks},fetchPriceFromWatchlistTable:async()=>({price:state.price,ath:state.ath}),
  db:{prepare:sql=>({all:async()=>sql.includes('stock_sip_budgets')?[{ticker:'ABC.NS',max_budget:state.budget}]:sql.includes('trade_history')?state.trades:sql.includes('FROM portfolio')?state.owned:stocks})}
 });
 return {state,call:async(scope='watchlist')=>{let body;await handler({user:{id:1},query:{scope}},{set(){return this;},status(){return this;},json:b=>body=b});assert.equal(body.success,true,body.error);return body.data.rows;}};
}
test('skipped, partial, completed and over-budget buys carry forward without double spending',async()=>{
 const {state,call}=setup();
 let levels=(await call())[0].levels;
 assert.equal(levels[1].suggested_amount,3000);assert.equal(levels[1].shares_to_buy,37);
 assert.equal(levels[0].shares_to_buy,0);assert.equal(levels[2].shares_to_buy,0);
 state.trades=[{type:'BUY',price:90,shares:5},{type:'BUY',price:0,shares:200},{type:'SELL',price:90,shares:1}];
 levels=(await call())[0].levels;assert.equal(levels[1].suggested_amount,2550);assert.equal(levels[1].shares_to_buy,31);
 state.trades.push({type:'BUY',price:80,shares:31});
 levels=(await call())[0].levels;assert.equal(levels[1].suggested_amount,70);assert.equal(levels[1].shares_to_buy,0);
 state.price=70;levels=(await call())[0].levels;assert.equal(levels[2].suggested_amount,7070);assert.equal(levels[2].shares_to_buy,101);
 state.trades.push({type:'BUY',price:70,shares:101});assert.equal((await call())[0].levels[2].suggested_amount,0);
 state.price=95;assert.ok((await call())[0].levels.every(l=>l.shares_to_buy===0));
 state.price=0;assert.ok((await call())[0].levels.every(l=>l.shares_to_buy===0));
});
test('watchlist excludes owned Yahoo identities, portfolio includes edited tickers and code-less discoveries',async()=>{
 const {state,call}=setup();
 state.owned=[{ticker:'MY-ABC',yahoo_finance_code:'ABC.NS'}];
 assert.equal((await call()).length,0);
 const rows=await call('portfolio');assert.equal(rows.length,1);assert.equal(rows[0].levels[1].suggested_amount,3000);
 state.owned=[];assert.equal((await call()).length,1);
});
