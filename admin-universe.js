function fail(status,message){throw Object.assign(new Error(message),{status});}
function validateNewStock(body){
 const code=typeof body.code==='string'?body.code.trim():'';
 const stock_code=String(body.stock_code||'').trim().toUpperCase();
 const yahoo_finance_code=String(body.yahoo_finance_code||'').trim().toUpperCase();
 if(!code||code.length>100||/[\u0000-\u001f\u007f]/.test(code))fail(400,'Enter CODE (up to 100 characters).');
 if(!/^(?:(?:NSE|BSE|BOM):)?[A-Z0-9][A-Z0-9&._-]{0,49}$/.test(stock_code))fail(400,'Enter a valid Stock Code.');
 if(!/^(?:(?:NSE|BSE|BOM):[A-Z0-9][A-Z0-9&._-]{0,49}|[A-Z0-9][A-Z0-9&._-]{0,49}\.(?:NS|BO))$/.test(yahoo_finance_code))fail(400,'Enter a Yahoo Finance Code such as RELIANCE.NS or GRWRHITECH.BO.');
 return {ticker:stock_code,code,stock_code,yahoo_finance_code};
}
async function addUniverseStock(tx,systemId,stock,quote){
 const rows=(await tx.execute({sql:'SELECT ticker,code,stock_code,yahoo_finance_code FROM watchlist WHERE user_id=?',args:[systemId]})).rows;
 if(rows.some(s=>[s.ticker,s.code,s.stock_code].some(v=>v&&[stock.code.toUpperCase(),stock.stock_code].includes(String(v).toUpperCase()))||s.yahoo_finance_code===stock.yahoo_finance_code))fail(409,'That CODE, Stock Code or Yahoo Finance Code already exists.');
 if(!Number.isFinite(quote.price)||quote.price<=0||quote.stale)fail(502,'Yahoo did not return a current price. Stock was not added.');
 const name=quote.name||quote.yahoo_symbol,stamp=new Date().toISOString();
 await tx.execute({sql:`INSERT INTO watchlist(user_id,ticker,code,stock_code,yahoo_finance_code,name,cmp,change,ath,ath_date,price_as_of,quote_fetched_at,quote_error,source,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[systemId,stock.ticker,stock.code,stock.stock_code,stock.yahoo_finance_code,name,quote.price,quote.change??null,quote.ath??null,quote.ath_date??null,quote.price_as_of??null,quote.quote_fetched_at??null,quote.quote_error??null,'YAHOO_FINANCE',stamp]});
 await tx.execute({sql:'INSERT INTO stock_yahoo_codes(ticker,yahoo_finance_code) VALUES (?,?) ON CONFLICT(ticker) DO UPDATE SET yahoo_finance_code=excluded.yahoo_finance_code',args:[stock.ticker,stock.yahoo_finance_code]});
 return {...stock,name,cmp:quote.price,ath:quote.ath,ath_date:quote.ath_date,quote_error:quote.quote_error};
}
async function deleteUniverseStock(tx,systemId,ticker){
 const row=(await tx.execute({sql:'SELECT ticker FROM watchlist WHERE user_id=? AND ticker=?',args:[systemId,ticker]})).rows[0];
 if(!row)fail(404,'Stock not found');
 await tx.execute({sql:'DELETE FROM user_watchlist_items WHERE ticker=?',args:[ticker]});
 await tx.execute({sql:'DELETE FROM universe_stock_config WHERE ticker=?',args:[ticker]});
 await tx.execute({sql:'DELETE FROM stock_yahoo_codes WHERE ticker=?',args:[ticker]});
 await tx.execute({sql:'DELETE FROM watchlist WHERE user_id=? AND ticker=?',args:[systemId,ticker]});
 return {deleted:true};
}
module.exports={validateNewStock,addUniverseStock,deleteUniverseStock};
