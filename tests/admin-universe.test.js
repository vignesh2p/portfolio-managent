const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateNewStock,addUniverseStock,deleteUniverseStock}=require('../admin-universe');
test('admin adds Yahoo details, rejects duplicates and deletes only universe/watchlist memberships',async()=>{
 const {createClient}=require('@libsql/client'),fs=require('node:fs'),path=require('node:path');
 const file=path.join(require('node:os').tmpdir(),'universe-crud-'+require('node:crypto').randomUUID()+'.db');
 const db=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
 await db.executeMultiple(`CREATE TABLE watchlist(user_id INTEGER,ticker TEXT,code TEXT,stock_code TEXT,yahoo_finance_code TEXT,name TEXT,cmp REAL,change REAL,ath REAL,ath_date TEXT,price_as_of TEXT,quote_fetched_at TEXT,quote_error TEXT,source TEXT,updated_at TEXT,UNIQUE(user_id,ticker));CREATE TABLE stock_yahoo_codes(ticker TEXT PRIMARY KEY,yahoo_finance_code TEXT);CREATE TABLE universe_stock_config(ticker TEXT);CREATE TABLE user_watchlist_items(ticker TEXT);CREATE TABLE trade_history(ticker TEXT);CREATE TABLE portfolio(ticker TEXT);`);
 const stock=validateNewStock({code:'REL',stock_code:'NSE:RELIANCE',yahoo_finance_code:'reliance.ns'});
 const quote={price:1500,name:'Reliance Industries',ath:1700,ath_date:'2026-01-01'};
 assert.throws(()=>validateNewStock({...stock,yahoo_finance_code:'bad symbol'}),/Yahoo/);
 await assert.rejects(addUniverseStock(db,99,stock,{...quote,stale:true}),/current price/);
 const added=await addUniverseStock(db,99,stock,quote);assert.equal(added.name,quote.name);
 assert.equal((await db.execute('SELECT cmp FROM watchlist')).rows[0].cmp,1500);
 await assert.rejects(addUniverseStock(db,99,stock,quote),/already exists/);
 for(const table of ['user_watchlist_items','trade_history','portfolio'])await db.execute({sql:`INSERT INTO ${table} VALUES (?)`,args:[stock.ticker]});
 await deleteUniverseStock(db,99,stock.ticker);
 for(const table of ['watchlist','user_watchlist_items','stock_yahoo_codes'])assert.equal((await db.execute(`SELECT * FROM ${table}`)).rows.length,0);
 for(const table of ['trade_history','portfolio'])assert.equal((await db.execute(`SELECT * FROM ${table}`)).rows.length,1);
 await assert.rejects(deleteUniverseStock(db,99,stock.ticker),/not found/);
 }finally{db.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
