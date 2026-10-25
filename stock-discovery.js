const {addUniverseStock}=require('./admin-universe');
const validSymbol=s=>typeof s==='string'&&/^[A-Z0-9][A-Z0-9&._-]{0,49}\.(NS|BO)$/.test(s);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function createStockDiscovery({yf,prices,systemId}){
 const cache=new Map();
 async function search(query){
  if(typeof query!=='string'||query.trim().length<2||query.trim().length>80)fail(400,'Enter 2–80 characters to search.');
  const q=query.trim(),key=q.toUpperCase(),cached=cache.get(key);
  if(cached&&cached.expires>Date.now())return cached.data;
  let result;try{const queries=validSymbol(key)?[q]:[q,q+' .NS',q+' .BO'];const found=await Promise.allSettled(queries.map(term=>yf.search(term,{quotesCount:50,newsCount:0,region:'IN',lang:'en-IN'})));if(found.every(r=>r.status==='rejected'))throw new Error();result={quotes:found.filter(r=>r.status==='fulfilled').flatMap(r=>r.value.quotes||[])};}catch{fail(502,'Yahoo search is unavailable. Please retry.');}
  const bySymbol=new Map();
  for(const row of result.quotes||[])if(row.quoteType==='EQUITY'&&validSymbol(row.symbol))bySymbol.set(row.symbol,{symbol:row.symbol,name:row.longname||row.shortname||row.symbol,exchange:row.symbol.endsWith('.NS')?'NSE':'BSE'});
  // Exact-symbol lookup also works when Yahoo's ranked search omits a listing.
  if(validSymbol(key)&&!bySymbol.has(key))try{const row=await yf.quote(key);if(row.quoteType==='EQUITY'&&row.symbol===key)bySymbol.set(key,{symbol:key,name:row.longName||row.shortName||key,exchange:key.endsWith('.NS')?'NSE':'BSE'});}catch{}
  const data=[...bySymbol.values()];if(cache.size>=250)cache.delete(cache.keys().next().value);cache.set(key,{data,expires:Date.now()+30*60000});return data;
 }
 async function prepare(symbols){
  if(!Array.isArray(symbols)||symbols.length>30||symbols.some(s=>!validSymbol(s)))fail(400,'Select up to 30 Indian Yahoo stocks at a time.');
  const prepared=[];
  for(const symbol of new Set(symbols)){
   let verified;try{verified=await yf.quote(symbol);}catch{fail(502,'Unable to verify '+symbol+'. Please retry.');}
   if(verified.symbol!==symbol||verified.quoteType!=='EQUITY')fail(400,'Select an Indian equity.');
   const stock={ticker:symbol,code:'',stock_code:(symbol.endsWith('.NS')?'NSE:':'BSE:')+symbol.slice(0,-3),yahoo_finance_code:symbol};
   const quote=await prices.fetchStock(stock);prepared.push({stock,quote});
  }
  return prepared;
 }
 async function insert(tx,prepared){
  const uid=await systemId(),tickers=[];
  for(const {stock,quote} of prepared){
   const existing=(await tx.execute({sql:'SELECT ticker FROM watchlist WHERE user_id=? AND (yahoo_finance_code=? OR ticker=? OR stock_code=?)',args:[uid,stock.yahoo_finance_code,stock.ticker,stock.stock_code]})).rows[0];
   if(existing){tickers.push(existing.ticker);continue;}
   await addUniverseStock(tx,uid,stock,quote);
   await tx.execute({sql:'UPDATE watchlist SET in_default_watchlist=0 WHERE user_id=? AND ticker=?',args:[uid,stock.ticker]});
   tickers.push(stock.ticker);
  }
  return tickers;
 }
 return {search,prepare,insert};
}
module.exports={createStockDiscovery,validSymbol};
