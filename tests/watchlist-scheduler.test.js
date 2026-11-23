const {test}=require('node:test');
const assert=require('node:assert/strict');
const {watchlistSlot,createWatchlistCronHandler}=require('../watchlist-scheduler');
test('IST trading window includes 14 weekday half-hour slots and excludes weekends',()=>{
  const slots=new Set();
  for(let minutes=540;minutes<=930;minutes+=30){
    const date=new Date(Date.UTC(2026,9,19,0,minutes-330));
    assert.ok(watchlistSlot(date));
    slots.add(watchlistSlot(date));
  }
  assert.equal(slots.size,14);
  for(const date of ['2026-10-19T03:29:00Z','2026-10-19T10:01:00Z','2026-10-17T03:30:00Z','2026-10-18T03:30:00Z']){
    assert.equal(watchlistSlot(new Date(date)),null);
  }
  assert.ok(watchlistSlot(new Date('2026-10-23T10:00:00Z')));
});
test('cron authenticates, deduplicates intervals, skips off-hours and retries failures',async()=>{
  const client=require('@libsql/client').createClient({url:'file::memory:'});
  const db={exec:sql=>client.execute(sql),prepare:sql=>({run:async(...args)=>({changes:Number((await client.execute({sql,args})).rowsAffected)})})};
  let time=new Date('2026-10-19T03:30:00Z'),secret='test-only',calls=0,fail=false;
  const handler=createWatchlistCronHandler({db,secret:()=>secret,now:()=>time,sync:async()=>{calls++;if(fail)throw new Error('Test provider failure');return {total:25};}});
  async function call(auth='Bearer test-only',query={}){
    let status=200,body;
    await handler({headers:{authorization:auth},query},{set(){return this;},status(code){status=code;return this;},json(value){body=value;}});
    return {status,...body};
  }
  try{
    assert.equal((await call('')).status,401);
    secret='';assert.equal((await call()).status,503);secret='test-only';
    assert.equal((await call(undefined,{dry_run:'1'})).dryRun,true);
    assert.equal(calls,0);
    assert.equal((await call()).total,25);
    assert.equal((await call()).skipped,true);
    assert.equal(calls,1);
    time=new Date('2026-10-19T04:00:00Z');fail=true;
    assert.equal((await call()).status,500);
    fail=false;assert.equal((await call()).total,25);
    assert.equal(calls,3);
    time=new Date('2026-10-24T04:00:00Z');
    assert.equal((await call()).skipped,true);
    assert.equal(calls,3);
  }finally{client.close();}
});
