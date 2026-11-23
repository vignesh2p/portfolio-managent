const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const {createDatabaseUsage,platformUsage}=require('../database-usage');
test('usage aggregates every table, attributes indirect ownership, separates shared data and caches scans',async()=>{
 const client=createClient({url:':memory:'});
 try{
  await client.executeMultiple(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,account_status TEXT,password TEXT);
   INSERT INTO users VALUES(1,'A','a@test','approved','private-hash'),(2,'B','b@test','blocked','other-hash'),(3,'Universe','system@test','approved','system-hash');
   CREATE TABLE portfolio(user_id INTEGER,ticker TEXT,shares REAL);INSERT INTO portfolio VALUES(1,'ABC',10),(2,'XYZ',2),(99,'ORPHAN',1);
   CREATE TABLE user_watchlists(id INTEGER,user_id INTEGER);INSERT INTO user_watchlists VALUES(10,1);
   CREATE TABLE user_watchlist_items(watchlist_id INTEGER,ticker TEXT);INSERT INTO user_watchlist_items VALUES(10,'ABC');
   CREATE TABLE cache(symbol TEXT,data TEXT);INSERT INTO cache VALUES('ABC','shared');
   CREATE TABLE tax_family_links(viewer_id INTEGER,subject_id INTEGER);INSERT INTO tax_family_links VALUES(2,1);
   CREATE TABLE watchlist(user_id INTEGER,ticker TEXT);INSERT INTO watchlist VALUES(3,'ABC');
   CREATE TABLE empty_table(id INTEGER);`);
  let queries=0,time=new Date('2026-11-14T05:00:00Z');
  const db={prepare:sql=>({all:async()=>{queries++;return (await client.execute(sql)).rows;},get:async()=>{queries++;return (await client.execute(sql)).rows[0];}})};
  const service=createDatabaseUsage({db,env:{},systemEmail:'system@test',now:()=>time});
  const d=await service.get();
  assert.ok(d.storage_bytes>0);assert.equal(d.users.find(u=>u.id===1).rows,4);assert.equal(d.users.find(u=>u.id===2).rows,3);
  assert.equal(d.users.find(u=>u.system).rows,2);assert.equal(d.shared.rows,2);
  assert.equal(d.total_rows,11);assert.equal(d.tables.find(t=>t.name==='empty_table').rows,0);
  assert.equal(d.estimated_bytes,d.users.reduce((n,u)=>n+u.estimated_bytes,0)+d.shared.estimated_bytes);
  assert.ok(!JSON.stringify(d).includes('private-hash'));assert.equal(d.provider.status,'not_configured');
  const before=queries;assert.equal(await service.get(),d);assert.equal(queries,before);
  time=new Date(time.getTime()+300001);await service.get();assert.ok(queries>before);
 }finally{client.close();}
});
test('platform usage is scoped to a database and UTC month, with unavailable distinct from zero',async()=>{
 const env={TURSO_PLATFORM_API_TOKEN:'private-token',TURSO_ORGANIZATION:'org',TURSO_DATABASE_NAME:'db'};
 const date=new Date('2026-11-14T05:00:00Z');
 const result=await platformUsage(env,async(url,options)=>{
  assert.equal(url.hostname,'api.turso.tech');assert.equal(url.searchParams.get('from'),'2026-11-01T00:00:00.000Z');
  assert.equal(options.headers.Authorization,'Bearer private-token');
  return {ok:true,json:async()=>({database:{total:{rows_read:0,rows_written:20,storage_bytes:4096}}})};
 },date);
 assert.equal(result.rows_read,0);assert.equal(result.bytes_synced,null);assert.equal(result.status,'available');
 const failed=await platformUsage(env,async()=>{throw Error('private-token');},date);
 assert.equal(failed.status,'unavailable');assert.ok(!JSON.stringify(failed).includes('private-token'));
});
test('usage route requires administrator middleware and returns sanitized failures',async()=>{
 const admin=()=>{},routes=[];
 createDatabaseUsage({db:{prepare(){throw Error('secret connection');}},env:{}}).register({get:(...args)=>routes.push(args)},admin);
 assert.equal(routes[0][0],'/api/admin/database-usage');assert.equal(routes[0][1],admin);
 let status,body;const res={set(){return this;},status(n){status=n;return this;},json(v){body=v;}};
 await routes[0][2]({},res);assert.equal(status,503);assert.ok(!JSON.stringify(body).includes('secret connection'));
});
