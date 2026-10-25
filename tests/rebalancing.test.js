const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const r=require('../rebalancing');
const match=(h,stocks)=>stocks.find(s=>s.ticker===h.ticker);
test('ATH age strictly exceeds 365 days; SIP bands do not overlap and combinations use full budget weights',()=>{
 const now=new Date('2026-10-25T00:00:00+05:30');
 const stocks=[{ticker:'OLD',ath_date:'2025-10-24',price:100},{ticker:'YEAR',ath_date:'2025-10-25'},{ticker:'BAD',ath_date:'2025-02-30'}];
 assert.deepEqual(r.sourceRows(stocks.map(s=>({ticker:s.ticker,shares:2,avg_price:50})),stocks,match,now).map(s=>s.ticker),['OLD']);
 const levels=[{fall:-10,allocation:25},{fall:-30,allocation:75}];
 const targets=[{ticker:'A',price:90},{ticker:'B',price:70},{ticker:'C',price:80},{ticker:'D',price:85}].map(s=>({...s,code:s.ticker,stock_code:'NSE:'+s.ticker,ath:100,ath_date:'2026-10-01'}));
 const rows=r.candidates(targets,[],levels,new Set(['A','B','C','D']),{ticker:'OLD'},match,now);
 assert.equal(rows.find(s=>s.ticker==='B').fall,-30);
 const plans=r.combinations(rows,10000);assert.ok(plans.some(p=>p.buys.length===3&&p.buys.every(b=>b.fall===-10)));
 const mixed=plans.find(p=>p.buys.length===2&&p.buys.some(b=>b.ticker==='A')&&p.buys.some(b=>b.ticker==='B'));
 assert.equal(mixed.buys.find(b=>b.ticker==='A').shares,27);assert.equal(mixed.buys.find(b=>b.ticker==='B').shares,107);
 assert.ok(plans.every(p=>p.total<=10000&&p.buys.every(b=>b.shares>=1)));
 assert.equal(r.daysSince('2027-01-01',now),null);
});
test('rebalance is atomic, user scoped, oversell/overspend safe and idempotent',async()=>{
 const filename=require('node:path').join(require('node:os').tmpdir(),'rebalance-'+require('node:crypto').randomUUID()+'.db');
 const client=createClient({url:require('node:url').pathToFileURL(filename).href});
 try{
 await client.executeMultiple(`CREATE TABLE portfolio(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,shares REAL,avg_price REAL,stock_name TEXT,ok_code TEXT,UNIQUE(user_id,ticker));CREATE TABLE trade_history(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,exchange TEXT,type TEXT,shares REAL,price REAL,amount REAL,notes TEXT,traded_at TEXT,stock_name TEXT,ok_code TEXT);INSERT INTO portfolio VALUES(1,1,'OLD',10,50,'Old','O'),(2,2,'OLD',10,50,'Other user','O');`);
 await client.execute(r.schema);
 const context={sources:[{ticker:'OLD',name:'Old',code:'O'}],candidates:[{ticker:'A',name:'Alpha',code:'A'},{ticker:'B',name:'Beta',code:'B'}]};
 const base={request_id:'confirmation-00000001',date:r.indiaDate(),sell:{ticker:'OLD',shares:10,price:100},buys:[{ticker:'A',shares:5,price:100},{ticker:'B',shares:5,price:100}]};
 const execute=async(body,uid=1,ctx=context)=>{const tx=await client.transaction('write');try{const result=await r.commit(tx,uid,body,ctx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 await assert.rejects(execute({...base,sell:{...base.sell,shares:11}}),/exceeds your current holding/);
 await assert.rejects(execute({...base,buys:[{ticker:'A',shares:11,price:100}]}),/exceeds sale proceeds/);
 await assert.rejects(execute(base,3),/current holding/);
 await client.execute("INSERT INTO trade_history(user_id,ticker,type,shares,price,traded_at) VALUES(1,'B','BUY',1,1,'2099-01-01')");
 await assert.rejects(execute(base),/latest trade/);
 assert.equal((await client.execute("SELECT shares FROM portfolio WHERE user_id=1 AND ticker='OLD'")).rows[0].shares,10);
 assert.equal((await client.execute('SELECT COUNT(*) AS n FROM trade_history')).rows[0].n,1);
 await client.execute('DELETE FROM trade_history');
 const saved=await execute(base);assert.equal(saved.trade_ids.length,3);
 const retry=await execute(base,1,{sources:[],candidates:[]});assert.deepEqual(retry,saved);
 assert.equal((await client.execute('SELECT COUNT(*) AS n FROM trade_history')).rows[0].n,3);
 assert.equal((await client.execute("SELECT shares FROM portfolio WHERE user_id=2 AND ticker='OLD'")).rows[0].shares,10);
 assert.equal((await client.execute("SELECT shares FROM portfolio WHERE user_id=1 AND ticker='A'")).rows[0].shares,5);
 await assert.rejects(execute({...base,sell:{...base.sell,price:101}}),/already used/);
 }finally{client.close();try{require('node:fs').unlinkSync(filename);}catch{}}
});

test('replacement quantities use sale market value, all affordable singles remain available, and each SIP level sorts by ATH age',()=>{
 const stocks=[{ticker:'OLD',price:200,ath_date:'2024-01-01'}];
 const source=r.sourceRows([{ticker:'OLD',shares:10,avg_price:50}],stocks,match,new Date('2026-10-25'))[0];
 assert.equal(source.invested_amount,500);assert.equal(source.market_value,2000);
 const rows=[40,5,20,10,15].map((days,i)=>({ticker:'NEW'+i,allocation:50,fall:-10,price:100,days_since:days}));
 const plans=r.combinations(rows,source.market_value),singles=plans.filter(p=>p.buys.length===1);
 assert.equal(singles.length,5);assert.deepEqual(singles.map(p=>p.buys[0].days_since),[5,10,15,20,40]);assert.ok(singles.every(p=>p.buys[0].shares===20));
 assert.match(require('fs').readFileSync('server.js','utf8'),/rebalancing.combinations\(context.candidates,context.source.market_value\)/);
});

test('replacement suggestions include days 0 through 99 only, excluding unknown and future ATH dates',()=>{
 const now=new Date('2026-10-25T00:00:00+05:30');
 const date=days=>new Date(Date.parse('2026-10-25T00:00:00Z')-days*86400000).toISOString().slice(0,10);
 const stocks=[0,99,100,101].map(days=>({ticker:'D'+days,ath_date:date(days)})).concat([{ticker:'MISSING',ath_date:null},{ticker:'INVALID',ath_date:'bad'},{ticker:'FUTURE',ath_date:date(-1)}]).map(s=>({...s,code:s.ticker,stock_code:'NSE:'+s.ticker,price:90,ath:100}));
 const rows=r.candidates(stocks,[],[{fall:-10,allocation:100}],new Set(stocks.map(s=>s.ticker)),{ticker:'OLD'},match,now);
 assert.deepEqual(rows.map(s=>s.days_since),[0,99]);
 assert.ok(r.combinations(rows,1000).every(p=>p.buys.every(b=>b.days_since<100)));
});
