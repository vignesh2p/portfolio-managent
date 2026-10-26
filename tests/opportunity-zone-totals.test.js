const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

test('zone totals and automatic selections follow trades and user allocations in both scopes',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const route=source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'"));
  const levels=[-10,-15,-20,-25,-30,-35,-40].map(fall=>({fall,allocation:10}));
  let handler,selections=[],syncCalls=0;
  const trades=[{type:'BUY',price:90,shares:2},{type:'BUY',price:86,shares:3},{type:'BUY',price:85,shares:4},{type:'BUY',price:60,shares:5},{type:'BUY',price:40,shares:6},{type:'BUY',price:0,shares:100},{type:'SELL',price:88,shares:2},{type:'BUY',price:95,shares:2}];
vm.runInNewContext(route,{namedWatchlists:{stocks:async()=>[{ticker:'TEST',code:'OK1',stock_code:'NSE:TEST'}]},app:{get:(_p,_a,fn)=>handler=fn},auth:()=>{},getOrSeedSIP:async()=>({levels:JSON.stringify(levels),max_budget:10000}),getOnepieceSystemUserId:async()=>99,syncOnepieceWatchlistTable:async()=>{syncCalls++;},fetchPriceFromWatchlistTable:async()=>({ath:100,price:87}),matchStock:()=>null,db:{prepare:sql=>({all:async uid=>{
    if(sql.includes('stock_sip_budgets'))return [];
    if(sql.includes('watchlist'))return [{ticker:'TEST',code:'OK1',stock_code:'NSE:TEST'}];
    assert.equal(uid,1);
    if(sql.includes('opportunity_selection'))return selections;
    if(sql.includes('trade_history'))return trades;
    return [{ticker:'TEST',code:'OK1',stock_code:'NSE:TEST'}];
  }})}});
  const call=async(scope='portfolio')=>{
    let body;
    const before=syncCalls;
    await handler({user:{id:1},query:{scope}},{set(){return this;},json:v=>body=v,status(){return this;}});
    assert.equal(syncCalls,before,'page loads never refresh providers');
    assert.equal(body.success,true,body.error);
    return body.data.rows[0].levels;
  };
  for(const scope of ['portfolio']){
    const result=await call(scope);
    assert.equal(result[0].invested_amount,438);
    assert.equal(result[0].bought_quantity,5);
    assert.equal(result[1].invested_amount,340);
    assert.equal(result[1].bought_quantity,4);
    assert.equal(result[2].bought_quantity,0);
    assert.equal(result[6].invested_amount,540);
    assert.equal(result[6].bought_quantity,11);
    assert.equal(JSON.stringify(result.filter(l=>l.selected).map(l=>l.fall)),JSON.stringify([-10,-15,-40]));
    assert.equal(result[0].allocated_amount,1000);
  }
  selections=[{ticker:'TEST',selected_levels:'[-20]'}];
  const saved=await call();
  assert.equal(saved[0].selected,true);
  assert.equal(saved[2].selected,false);
  assert.equal(saved[0].invested_amount,438);
  levels[0].fall=-12;
  [5,15,20,10,25,15,10].forEach((allocation,i)=>levels[i].allocation=allocation);
  for(const scope of ['portfolio']){
    const custom=await call(scope);
    assert.equal(custom[0].fall,-12);
    assert.equal(custom[0].trigger_price,88);
    assert.equal(custom[0].allocated_amount,500);
    assert.equal(custom[1].allocated_amount,1500);
    assert.equal(custom[0].bought_quantity,3);
  }
});
test('custom level counts and exact decimal boundaries highlight and count each purchase in only one zone',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const route=source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'"));
 for(const falls of [[-10],[-10,-12.5,-30],[-5,-10,-15,-20,-25,-30,-35,-40,-45]]){
   const ath=2021,levels=falls.map(fall=>({fall,allocation:100/falls.length}));
   const thresholds=falls.map(f=>ath*(100+f)/100);
   const trades=thresholds.map(price=>({type:'BUY',price,shares:1}));
   let price=0,handler;
   vm.runInNewContext(route,{app:{get:(_p,_a,fn)=>handler=fn},auth:()=>{},syncOnepieceWatchlistTable:async()=>{},getOrSeedSIP:async()=>({levels:JSON.stringify(levels),max_budget:1000}),getOnepieceSystemUserId:async()=>99,namedWatchlists:{stocks:async()=>[{ticker:'TEST',code:'OK1',stock_code:'NSE:TEST'}]},matchStock:()=>null,fetchPriceFromWatchlistTable:async()=>({ath,price}),db:{prepare:sql=>({all:async()=>sql.includes('stock_sip_budgets')?[]:sql.includes('trade_history')?trades:[{ticker:'TEST',code:'OK1',stock_code:'NSE:TEST'}]})}});
   for(const scope of ['portfolio'])for(const candidate of [...thresholds,thresholds[0]+1,1,0]){
     price=candidate;let body;
     await handler({user:{id:1},query:{scope}},{set(){return this;},status(){return this;},json:v=>body=v});
     assert.equal(body.success,true,body.error);
     const result=body.data.rows[0].levels;
     assert.equal(result.length,falls.length);
     assert.equal(result.filter(l=>l.active).length,candidate>0&&candidate<=thresholds[0]?1:0);
     const boundary=thresholds.indexOf(candidate);if(boundary>=0)assert.equal(result[boundary].active,true);
     assert.equal(result.reduce((sum,l)=>sum+l.bought_quantity,0),trades.length);
     assert.ok(result.every(l=>l.bought_quantity===1));
   }
 }
});
