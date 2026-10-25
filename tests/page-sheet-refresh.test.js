const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('watchlist reads the cached snapshot without invoking refresh on opening',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../onepiece.html'),'utf8');
  const code=html.slice(html.indexOf('async function loadWatchlistTable()'),html.indexOf('let userWatchlists'));
  const nodes={'watchlist-table':{},'watchlist-meta':{}};
  let calls=0,renders=0,fail=false;
  const data=[{ticker:'TEST',cmp:123}];
  const context={refreshWatchlistChoices:async()=>{},showSelectedWatchlist:async()=>{renders++;},document:{getElementById:id=>nodes[id]},escapeHtml:String,api:async(url,opts)=>{
    calls++;assert.equal(url,'/api/watchlist/table');assert.equal(opts,undefined);
    if(fail)throw Error('Sheets unavailable');
    return {success:true,data};
  },renderWatchlistTable:rows=>{assert.equal(rows,data);renders++;}};
  vm.createContext(context);vm.runInContext(code,context);
  await context.loadWatchlistTable();await context.loadWatchlistTable();
  assert.equal(calls,2);assert.equal(renders,2);
  fail=true;await context.loadWatchlistTable();
  assert.equal(renders,2);assert.match(nodes['watchlist-table'].innerHTML,/Sheets unavailable/);
});
test('opportunities read shared quotes without refreshing providers',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const code=source.slice(source.indexOf("app.get('/api/portfolio-opportunities'"),source.indexOf("app.put('/api/portfolio-opportunities'"));
  let handler,syncs=0,reads=0,fail=false;
  const holdings=[{ticker:'A',code:'A',stock_code:'NSE:A'},{ticker:'B',code:'B',stock_code:'NSE:B'}];
  const namedWatchlists={stocks:async()=>holdings};
  const context={app:{get:(_p,_a,fn)=>handler=fn},auth:()=>{},syncOnepieceWatchlistTable:async()=>{syncs++;if(fail)throw Error('Sheet refresh failed');},getOrSeedSIP:async()=>({levels:'[{"fall":-10,"allocation":100}]',max_budget:1000}),getOnepieceSystemUserId:async()=>99,matchStock:()=>null,fetchPrice:()=>{throw Error('Stale cache accessed');},fetchPriceFromWatchlistTable:async()=>{reads++;return {price:120,ath:150};},db:{prepare:sql=>({all:async()=>sql.includes('trade_history')||sql.includes('stock_sip_budgets')?[]:holdings})}};
  vm.runInNewContext(code,{...context,namedWatchlists});
  let body;
  const res={set(){return this;},status(){return this;},json:v=>body=v};
  for(const scope of ['portfolio','watchlist']){
    const before=syncs;await handler({user:{id:1},query:{scope}},res);
    assert.equal(syncs,before);assert.equal(body.data.rows.length,2);
    assert.ok(body.data.rows.every(r=>r.price===120));
  }
  assert.equal(reads,4);fail=true;
  await handler({user:{id:1},query:{}},res);
  assert.equal(body.success,true);assert.equal(reads,6);assert.equal(syncs,0);
});
