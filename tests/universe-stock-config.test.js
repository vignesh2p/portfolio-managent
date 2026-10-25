const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const {schema,yahooCodeSchema,applyYahooCodes,applyUniverseConfig,saveUniverseConfig}=require('../universe-stock-config');
test('admin universe edits persist through refresh, reject conflicts, and preserve stock identity',async()=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const file=path.join(os.tmpdir(),'universe-'+require('node:crypto').randomUUID()+'.db');
 const client=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
 await client.executeMultiple(`CREATE TABLE watchlist(user_id INTEGER,ticker TEXT,code TEXT,stock_code TEXT,name TEXT,cmp REAL);INSERT INTO watchlist VALUES(99,'NSE:A','A1','NSE:A','Alpha',100),(99,'NSE:B','B1','NSE:B','Beta',200),(1,'NSE:A','PRIVATE','NSE:A','Private',100);`);
 await client.execute(schema);
 await client.execute(yahooCodeSchema);
 await client.execute("ALTER TABLE watchlist ADD COLUMN yahoo_finance_code TEXT NOT NULL DEFAULT ''");
 await client.executeMultiple("CREATE TABLE yahoo_refresh_state(id INTEGER,completed_at INTEGER);INSERT INTO yahoo_refresh_state VALUES(1,123);");
 for(const col of ['change REAL','ath REAL','ath_date TEXT','price_as_of TEXT','quote_fetched_at TEXT','quote_error TEXT'])await client.execute('ALTER TABLE watchlist ADD COLUMN '+col);
 await applyYahooCodes(client,99);
 const transaction=async fn=>{const tx=await client.transaction('write');try{const r=await fn(tx);await tx.commit();return r;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 const body={code:'NEW',stock_code:'BOM:500001',expected_code:'A1',expected_stock_code:'NSE:A'};
 const updated=await transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',body));assert.equal(updated.ticker,'NSE:A');assert.equal(updated.stock_code,'BOM:500001');
 await assert.rejects(transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',body)),/updated/);
 const current={expected_code:'NEW',expected_stock_code:'BOM:500001'};
 await assert.rejects(transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',{...current,code:'B1',stock_code:'NSE:C'})),/another stock/);
 await assert.rejects(transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',{...current,code:'OK',stock_code:'bad code'})),/valid Stock Code/);
 await assert.rejects(transaction(tx=>saveUniverseConfig(tx,99,'MISSING',body)),/not found/);
 await client.execute("UPDATE watchlist SET code='A1',stock_code='NSE:A',cmp=150 WHERE user_id=99 AND ticker='NSE:A'");
 await transaction(tx=>applyUniverseConfig(tx,99));
 const row=(await client.execute("SELECT * FROM watchlist WHERE user_id=99 AND ticker='NSE:A'")).rows[0];assert.equal(row.code,'NEW');assert.equal(row.stock_code,'BOM:500001');assert.equal(row.cmp,150);assert.equal(row.yahoo_finance_code,'NSE:A');
 const changed=await transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',{...current,code:'NEW',stock_code:'BOM:500001',yahoo_finance_code:'RELIANCE.NS',expected_yahoo_finance_code:'NSE:A'}));
 assert.equal(changed.yahoo_finance_code,'RELIANCE.NS');
 await transaction(tx=>applyUniverseConfig(tx,99));
 assert.equal((await client.execute("SELECT yahoo_finance_code FROM watchlist WHERE user_id=99 AND ticker='NSE:A'")).rows[0].yahoo_finance_code,'RELIANCE.NS');
 assert.equal((await client.execute('SELECT completed_at FROM yahoo_refresh_state')).rows[0].completed_at,0);
 await assert.rejects(transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',{...current,code:'NEW',stock_code:'BOM:500001',yahoo_finance_code:'INVALID',expected_yahoo_finance_code:'RELIANCE.NS'})),/valid Yahoo Finance/);
 assert.equal((await client.execute('SELECT code FROM watchlist WHERE user_id=1')).rows[0].code,'PRIVATE');
 await transaction(tx=>saveUniverseConfig(tx,99,'NSE:A',{...current,code:'',stock_code:'NSE:A'}));
 assert.equal((await client.execute("SELECT code FROM universe_stock_config WHERE ticker='NSE:A'")).rows[0].code,'');
 }finally{client.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
test('stock configuration routes require admin authorization and user settings routes are removed',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
 const routes=[],adminAuth=()=>{};
 const code=source.slice(source.indexOf("app.get('/api/admin/stock-config'"),source.indexOf("app.get('/api/admin/leaderboard'"));
 vm.runInNewContext(code,{app:{get:(path,middleware)=>routes.push({path,middleware}),put:(path,middleware)=>routes.push({path,middleware}),post:(path,middleware)=>routes.push({path,middleware}),delete:(path,middleware)=>routes.push({path,middleware})},adminAuth});
 assert.equal(routes.length,5);assert.ok(routes.every(route=>route.middleware===adminAuth));assert.ok(!source.includes("app.put('/api/settings/stocks"));
 assert.ok(!source.includes("fetchGoogleSheet"));
});
