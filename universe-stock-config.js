const schema=`CREATE TABLE IF NOT EXISTS universe_stock_config (ticker TEXT PRIMARY KEY,code TEXT NOT NULL,stock_code TEXT NOT NULL,updated_at TEXT NOT NULL)`;
const yahooCodeSchema='CREATE TABLE IF NOT EXISTS stock_yahoo_codes (ticker TEXT PRIMARY KEY,yahoo_finance_code TEXT NOT NULL)';
async function applyYahooCodes(tx,systemId){
  await tx.execute({sql:'INSERT OR IGNORE INTO stock_yahoo_codes(ticker,yahoo_finance_code) SELECT ticker,stock_code FROM watchlist WHERE user_id=?',args:[systemId]});
  await tx.execute({sql:'UPDATE watchlist SET yahoo_finance_code=(SELECT yahoo_finance_code FROM stock_yahoo_codes c WHERE c.ticker=watchlist.ticker) WHERE user_id=?',args:[systemId]});
}
async function applyUniverseConfig(tx,systemId){
  await tx.execute({sql:`UPDATE watchlist SET code=(SELECT code FROM universe_stock_config c WHERE c.ticker=watchlist.ticker),stock_code=(SELECT stock_code FROM universe_stock_config c WHERE c.ticker=watchlist.ticker) WHERE user_id=? AND ticker IN (SELECT ticker FROM universe_stock_config)`,args:[systemId]});
  await applyYahooCodes(tx,systemId);
}
async function saveUniverseConfig(tx,systemId,ticker,body){
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
  const code=typeof body.code==='string'?body.code.trim():null;
  const stockCode=typeof body.stock_code==='string'?body.stock_code.trim().toUpperCase():'';
  if(code===null||code.length>100||/[\u0000-\u001f\u007f]/.test(code))fail(400,'CODE must be text up to 100 characters.');
  if(!/^(?:(?:NSE|BSE|BOM):)?[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(stockCode))fail(400,'Enter a valid Stock Code, such as NSE:RELIANCE.');
  const rows=(await tx.execute({sql:'SELECT ticker,code,stock_code,yahoo_finance_code,name FROM watchlist WHERE user_id=?',args:[systemId]})).rows;
  const stock=rows.find(s=>s.ticker===ticker);
  if(!stock)fail(404,'Stock not found in the universe');
  const yahooCode=body.yahoo_finance_code===undefined?stock.yahoo_finance_code:String(body.yahoo_finance_code).trim().toUpperCase();
  if(!/^(?:(?:NSE|BSE|BOM):[A-Z0-9][A-Z0-9&._-]{0,49}|[A-Z0-9][A-Z0-9&._-]{0,49}\.(?:NS|BO))$/.test(yahooCode))fail(400,'Enter a valid Yahoo Finance Code, such as RELIANCE.NS or NSE:RELIANCE.');
  if(body.yahoo_finance_code!==undefined&&body.expected_yahoo_finance_code!==stock.yahoo_finance_code)fail(409,'This stock was updated. Refresh and try again.');
  if(body.expected_code!==stock.code||body.expected_stock_code!==stock.stock_code)fail(409,'This stock was updated. Refresh and try again.');
  if(rows.some(s=>s.ticker!==ticker&&[s.ticker,s.stock_code,s.code].some(v=>v&&(String(v).toUpperCase()===stockCode||(code&&String(v).toUpperCase()===code.toUpperCase())))))fail(409,'That CODE or Stock Code belongs to another stock.');
  await tx.execute({sql:'INSERT INTO universe_stock_config(ticker,code,stock_code,updated_at) VALUES (?,?,?,?) ON CONFLICT(ticker) DO UPDATE SET code=excluded.code,stock_code=excluded.stock_code,updated_at=excluded.updated_at',args:[ticker,code,stockCode,new Date().toISOString()]});
  await tx.execute({sql:'UPDATE watchlist SET code=?,stock_code=? WHERE user_id=? AND ticker=?',args:[code,stockCode,systemId,ticker]});
  await tx.execute({sql:'INSERT INTO stock_yahoo_codes(ticker,yahoo_finance_code) VALUES (?,?) ON CONFLICT(ticker) DO UPDATE SET yahoo_finance_code=excluded.yahoo_finance_code',args:[ticker,yahooCode]});
  await tx.execute({sql:'UPDATE watchlist SET yahoo_finance_code=? WHERE user_id=? AND ticker=?',args:[yahooCode,systemId,ticker]});
  if(yahooCode!==stock.yahoo_finance_code){
    await tx.execute({sql:"UPDATE watchlist SET cmp=NULL,change=NULL,ath=NULL,ath_date=NULL,price_as_of=NULL,quote_fetched_at=NULL,quote_error='Yahoo code changed; refresh pending' WHERE user_id=? AND ticker=?",args:[systemId,ticker]});
    await tx.execute('UPDATE yahoo_refresh_state SET completed_at=0 WHERE id=1');
  }
  return {...stock,code,stock_code:stockCode,yahoo_finance_code:yahooCode};
}
module.exports={schema,yahooCodeSchema,applyYahooCodes,applyUniverseConfig,saveUniverseConfig};
