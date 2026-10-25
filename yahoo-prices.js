// Adapted from onepiece-yfinance's quote + monthly/daily history lookup.
const schema='CREATE TABLE IF NOT EXISTS yahoo_quote_cache (stock_code TEXT PRIMARY KEY,data_json TEXT NOT NULL,fetched_at INTEGER NOT NULL)';
const TTL=30*60*1000;
const sharedSchema=[
 'CREATE TABLE IF NOT EXISTS yahoo_shared_quotes (yahoo_symbol TEXT PRIMARY KEY,data_json TEXT NOT NULL,fetched_at INTEGER NOT NULL)',
 'CREATE TABLE IF NOT EXISTS yahoo_symbol_aliases (stock_code TEXT PRIMARY KEY,yahoo_symbol TEXT NOT NULL)',
 `INSERT OR IGNORE INTO yahoo_shared_quotes(yahoo_symbol,data_json,fetched_at) SELECT json_extract(data_json,'$.yahoo_symbol'),data_json,fetched_at FROM yahoo_quote_cache WHERE json_valid(data_json) AND json_extract(data_json,'$.yahoo_symbol') IS NOT NULL ORDER BY fetched_at DESC`,
 `INSERT OR IGNORE INTO yahoo_symbol_aliases(stock_code,yahoo_symbol) SELECT stock_code,json_extract(data_json,'$.yahoo_symbol') FROM yahoo_quote_cache WHERE json_valid(data_json) AND json_extract(data_json,'$.yahoo_symbol') IS NOT NULL`,
 'CREATE TABLE IF NOT EXISTS yahoo_refresh_state (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,completed_at INTEGER NOT NULL DEFAULT 0,summary_json TEXT)',
 'INSERT OR IGNORE INTO yahoo_refresh_state(id) VALUES (1)'
];
function yahooSymbol(code){
 const value=String(code||'').trim().toUpperCase();
 if(/^[A-Z0-9&._-]+\.(NS|BO)$/.test(value))return value;
 const match=value.match(/^(NSE|BOM|BSE):([A-Z0-9&._-]+)$/);
 if(!match)throw new Error('Set an exchange-qualified Yahoo Finance Code in Admin, such as NSE:RELIANCE or BOM:GRWRHITECH');
 return match[2]+(match[1]==='NSE'?'.NS':'.BO');
}
function tradingDate(date){const d=new Date(date);if(!Number.isFinite(+d))return null;return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function companyKey(name){return String(name||'').toLowerCase().replace(/\b(limited|ltd|inc|corporation|corp)\b/g,'').replace(/[^a-z0-9]/g,'');}
async function resolveYahooSymbol(yf,stock){
 let symbol=yahooSymbol(stock.yahoo_finance_code);
 // Numeric BSE identifiers are not always Yahoo symbols. Match the company name
 // exactly (ignoring punctuation and company suffixes) before choosing an alias.
 if(/^\d+\.BO$/.test(symbol)&&stock.name){
   const query=stock.name.replace(/\b(limited|ltd)\.?\s*$/i,'').trim();
   const found=await yf.search(query,{quotesCount:20,newsCount:0});
   const matches=(found.quotes||[]).filter(q=>q.symbol?.endsWith('.BO')&&[q.shortname,q.longname].some(n=>companyKey(n)===companyKey(stock.name)));
   if(new Set(matches.map(q=>q.symbol)).size===1)symbol=matches[0].symbol;
 }
 return symbol;
}
async function getYahooData(yf,stock,resolvedSymbol){
 const symbol=resolvedSymbol||await resolveYahooSymbol(yf,stock);
 const quote=await yf.quote(symbol);
 if(!quote||!Number.isFinite(quote.regularMarketPrice)||quote.regularMarketPrice<=0)throw new Error('No Yahoo price for '+symbol);
 let ath=null,ath_date=null,quote_error=null;
 try{
   const monthly=await yf.chart(symbol,{period1:'1970-01-01',interval:'1mo'});
   const candles=(monthly.quotes||[]).filter(q=>Number.isFinite(q.high)&&q.high>0);
   const peak=Math.max(...candles.map(q=>q.high));
   const months=candles.filter(q=>q.high===peak);
   if(!months.length)throw new Error('Historical highs unavailable');
   for(const month of months){
     const start=new Date(month.date),end=new Date(month.date);start.setUTCDate(start.getUTCDate()-2);end.setUTCDate(end.getUTCDate()+38);
     const daily=await yf.chart(symbol,{period1:start,period2:end,interval:'1d'});
     for(const day of daily.quotes||[]){
       const date=tradingDate(day.date);
       if(Number.isFinite(day.high)&&day.high>0&&date&&(ath===null||day.high>ath||(day.high===ath&&date<ath_date))){ath=day.high;ath_date=date;}
     }
   }
   if(ath===null||ath+0.02<peak)throw new Error('Exact ATH trading date could not be verified');
   const currentHigh=Math.max(quote.regularMarketPrice,quote.regularMarketDayHigh||0);
   if(currentHigh>ath&&quote.regularMarketTime){ath=currentHigh;ath_date=tradingDate(quote.regularMarketTime);}
   if(Number.isFinite(quote.fiftyTwoWeekHigh)&&quote.fiftyTwoWeekHigh>ath+0.02)throw new Error('Historical ATH is inconsistent with the quote');
 }catch(e){ath=null;ath_date=null;quote_error='ATH unavailable: '+e.message;}
 const price=quote.regularMarketPrice,change=quote.regularMarketChange??0;
 return {ticker:stock.ticker,yahoo_symbol:symbol,name:stock.name||quote.longName||quote.shortName||symbol,price,cmp:price,change,changePct:quote.regularMarketChangePercent??0,prevClose:quote.regularMarketPreviousClose??price-change,ath:ath===null?null:Number(ath.toFixed(2)),ath_date,source:'YAHOO_FINANCE',price_as_of:quote.regularMarketTime?new Date(quote.regularMarketTime).toISOString():null,quote_fetched_at:new Date().toISOString(),quote_error};
}
function createYahooPrices({db,yf,now=Date.now}){
 const pending=new Map(),failures=new Map();
 async function symbolFor(stock,allowNetwork){
   const code=String(stock.yahoo_finance_code||'').trim().toUpperCase(),direct=yahooSymbol(code);
   const alias=await db.prepare('SELECT yahoo_symbol FROM yahoo_symbol_aliases WHERE stock_code=?').get(code);
   if(alias)return alias.yahoo_symbol;
   if(!allowNetwork)return direct;
   const symbol=await resolveYahooSymbol(yf,stock);
   await db.prepare('INSERT INTO yahoo_symbol_aliases(stock_code,yahoo_symbol) VALUES (?,?) ON CONFLICT(stock_code) DO UPDATE SET yahoo_symbol=excluded.yahoo_symbol').run(code,symbol);
   return symbol;
 }
 async function readStock(stock){
   const symbol=await symbolFor(stock,false);
   const cached=await db.prepare('SELECT data_json,fetched_at FROM yahoo_shared_quotes WHERE yahoo_symbol=?').get(symbol);
   if(!cached)throw new Error('Price is not cached yet. The shared universe refresh will load it.');
   const data=JSON.parse(cached.data_json),stale=now()-Number(cached.fetched_at)>=TTL;
   return {...data,ticker:stock.ticker,name:stock.name||data.name,stale,cache_expires_at:new Date(Number(cached.fetched_at)+TTL).toISOString(),quote_error:stale?'Cached Yahoo price is older than 30 minutes; refresh pending.':data.quote_error};
 }
 async function readStocks(stocks){
   const [quotes,aliases]=await Promise.all([
     db.prepare('SELECT yahoo_symbol,data_json,fetched_at FROM yahoo_shared_quotes').all(),
     db.prepare('SELECT stock_code,yahoo_symbol FROM yahoo_symbol_aliases').all()
   ]);
   const bySymbol=new Map(quotes.map(q=>[q.yahoo_symbol,q]));
   const byCode=new Map(aliases.map(a=>[a.stock_code,a.yahoo_symbol]));
   return stocks.map(stock=>{
     try{
       const code=String(stock.yahoo_finance_code||'').trim().toUpperCase();
       const cached=bySymbol.get(byCode.get(code)||yahooSymbol(code));
       if(!cached)throw new Error('Price is not cached yet. The shared universe refresh will load it.');
       const data=JSON.parse(cached.data_json),stale=now()-Number(cached.fetched_at)>=TTL;
       return {...stock,...data,ticker:stock.ticker,name:stock.name||data.name,cmp:data.price,stale,cache_expires_at:new Date(Number(cached.fetched_at)+TTL).toISOString(),quote_error:stale?'Cached Yahoo price is older than 30 minutes; refresh pending.':data.quote_error};
     }catch(error){return {...stock,price:null,cmp:null,change:null,changePct:null,ath:null,ath_date:null,price_as_of:null,quote_fetched_at:null,source:'YAHOO_FINANCE',quote_error:error.message};}
   });
 }
 async function fetchStock(stock){
   const key=await symbolFor(stock,true);
   const failure=failures.get(key);if(failure&&now()-failure.at<60000)throw failure.error;
   if(pending.has(key))return pending.get(key);
   const work=(async()=>{
     const cached=await db.prepare('SELECT data_json,fetched_at FROM yahoo_shared_quotes WHERE yahoo_symbol=?').get(key);
     const saved=cached?JSON.parse(cached.data_json):null;
     if(saved&&now()-Number(cached.fetched_at)<TTL)return {...saved,ticker:stock.ticker};
     try{
       const data=await getYahooData(yf,stock,key);
       await db.prepare('INSERT INTO yahoo_shared_quotes(yahoo_symbol,data_json,fetched_at) VALUES (?,?,?) ON CONFLICT(yahoo_symbol) DO UPDATE SET data_json=excluded.data_json,fetched_at=excluded.fetched_at').run(key,JSON.stringify(data),now());
       return data;
     }catch(e){if(saved)return {...saved,ticker:stock.ticker,quote_error:'Last known Yahoo data; refresh failed: '+e.message,stale:true};failures.set(key,{at:now(),error:e});throw e;}
   })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
 }
 return {fetchStock,readStock,readStocks};
}
async function applyCachedUniverseQuotes(tx,systemId){
 await tx.execute({sql:`UPDATE watchlist SET (cmp,change,ath,ath_date,price_as_of,quote_fetched_at,quote_error)=(SELECT json_extract(q.data_json,'$.price'),json_extract(q.data_json,'$.change'),json_extract(q.data_json,'$.ath'),json_extract(q.data_json,'$.ath_date'),json_extract(q.data_json,'$.price_as_of'),json_extract(q.data_json,'$.quote_fetched_at'),json_extract(q.data_json,'$.quote_error') FROM yahoo_symbol_aliases a JOIN yahoo_shared_quotes q ON q.yahoo_symbol=a.yahoo_symbol WHERE a.stock_code=watchlist.yahoo_finance_code) WHERE user_id=? AND yahoo_finance_code IN (SELECT a.stock_code FROM yahoo_symbol_aliases a JOIN yahoo_shared_quotes q ON q.yahoo_symbol=a.yahoo_symbol)`,args:[systemId]});
}
module.exports={schema,sharedSchema,TTL,yahooSymbol,tradingDate,getYahooData,createYahooPrices,applyCachedUniverseQuotes};
