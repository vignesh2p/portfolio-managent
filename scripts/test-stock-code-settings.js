const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { changeStockCode } = require('../stock-code-settings');

(async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const filename = path.join(os.tmpdir(),`onepiece-stock-code-${require('node:crypto').randomUUID()}.db`);
  const db = createClient({url:require('node:url').pathToFileURL(filename).href});
  try {
  await db.executeMultiple(`
    CREATE TABLE portfolio(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,shares REAL,avg_price REAL,stock_name TEXT DEFAULT '',ok_code TEXT DEFAULT '',UNIQUE(user_id,ticker));
    CREATE TABLE trade_history(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,exchange TEXT,amount REAL,stock_name TEXT DEFAULT '',ok_code TEXT DEFAULT '');
    INSERT INTO portfolio VALUES(1,1,'NSE:OLD',10,100,'',''),(2,2,'NSE:OLD',20,200,'','');
    INSERT INTO trade_history(id,user_id,ticker,exchange,amount) VALUES(1,1,'NSE:OLD','NSE',1000),(2,1,'NSE:OLD','NSE',200),(3,2,'NSE:OLD','NSE',4000);
  `);
  const stocks=[{stock_code:'NSE:OLD',name:'Original Company',code:'A123'}];
  async function change(uid,id,old,code,options){
    const tx=await db.transaction('write');
    try{const result=await changeStockCode(tx,uid,id,old,code,'BOM',stocks,options);await tx.commit();return result;}
    catch(e){await tx.rollback();throw e;}
    finally{tx.close();}
  }
  assert.equal((await change(1,1,'NSE:OLD','BOM:500001')).updatedTrades,2);
  const holding=(await db.execute('SELECT * FROM portfolio WHERE id=1')).rows[0];
  assert.equal(holding.ticker,'BOM:500001');assert.equal(holding.shares,10);assert.equal(holding.avg_price,100);
  assert.equal(holding.stock_name,'Original Company');assert.equal(holding.ok_code,'A123');
  assert.equal((await db.execute("SELECT count(*) AS n FROM trade_history WHERE user_id=1 AND ticker='BOM:500001' AND exchange='BOM'")).rows[0].n,2);
  assert.equal((await db.execute('SELECT ticker FROM portfolio WHERE id=2')).rows[0].ticker,'NSE:OLD');
  assert.equal((await change(1,1,'BOM:500001','BOM:500001',{okCode:'NEW-OK',expectedOkCode:'A123'})).updatedTrades,2);
  assert.equal((await db.execute('SELECT ok_code FROM portfolio WHERE id=1')).rows[0].ok_code,'NEW-OK');
  assert.equal((await db.execute("SELECT count(*) AS n FROM trade_history WHERE user_id=1 AND ok_code='NEW-OK' AND stock_name='Original Company'")).rows[0].n,2);
  assert.equal((await db.execute('SELECT ok_code FROM trade_history WHERE id=3')).rows[0].ok_code,'');
  assert.equal((await db.execute('SELECT sum(amount) AS total FROM trade_history WHERE user_id=1')).rows[0].total,1200);
  await assert.rejects(change(1,1,'BOM:500001','BOM:500001',{okCode:'BAD',expectedOkCode:'A123'}),{status:409});
  await assert.rejects(change(1,1,'BOM:500001','BOM:500001',{okCode:'x'.repeat(101)}),{status:400});
  await change(1,1,'BOM:500001','BOM:500001',{okCode:'',expectedOkCode:'NEW-OK'});
  assert.equal((await db.execute('SELECT ok_code FROM portfolio WHERE id=1')).rows[0].ok_code,'');
  await change(1,1,'BOM:500001','BOM:500004',{okCode:'BOTH',expectedOkCode:''});
  assert.equal((await db.execute('SELECT ticker,ok_code FROM trade_history WHERE id=1')).rows[0].ticker,'BOM:500004');
  assert.equal((await db.execute('SELECT ok_code FROM trade_history WHERE id=1')).rows[0].ok_code,'BOTH');
  await change(1,1,'BOM:500004','BOM:500001');
  await assert.rejects(change(2,1,'BOM:500001','BOM:500002'),{status:404});
  await assert.rejects(change(1,1,'NSE:OLD','BOM:500002'),{status:409});
  await db.execute("INSERT INTO trade_history(id,user_id,ticker,exchange,amount) VALUES(4,1,'BOM:500002','BOM',10)");
  await assert.rejects(change(1,1,'BOM:500001','BOM:500002'),{status:409});
  await db.execute("CREATE TRIGGER reject_change BEFORE UPDATE ON portfolio BEGIN SELECT RAISE(ABORT,'test failure'); END");
  await assert.rejects(change(1,1,'BOM:500001','BOM:500003',{okCode:'ROLLBACK'}));
  assert.equal((await db.execute("SELECT count(*) AS n FROM trade_history WHERE ticker='BOM:500003'")).rows[0].n,0);
  assert.equal((await db.execute('SELECT ok_code FROM trade_history WHERE id=1')).rows[0].ok_code,'BOTH');
  console.log('PASS: stock and OK code updates, OK-only and combined edits, clearing, validation, account isolation, stale edits, collisions, financial data preservation, and rollback');
  } finally { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(filename+suffix); } catch(error) { if(!['ENOENT','EBUSY'].includes(error.code)) throw error; } } }
})().catch(error=>{console.error(error);process.exitCode=1;});
