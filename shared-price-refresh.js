const {randomUUID}=require('node:crypto');
const {TTL}=require('./yahoo-prices');
const {watchlistSlot,SCHEDULE}=require('./watchlist-scheduler');
function createSharedPriceRefresh({db,transactionRaw,refresh,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 let pending;
 async function run(options={}){
  const force=options.force===true;
  const owner=randomUUID(),deadline=now()+90000;
  while(true){
   // Apply the same IST window to browser fallbacks and scheduled callers.
   if(!force&&!watchlistSlot(new Date(now())))return {skipped:true,marketClosed:true,reason:'Outside the weekday trading window',schedule:SCHEDULE};
   const state=await transactionRaw(async tx=>{
    const row=(await tx.execute('SELECT * FROM yahoo_refresh_state WHERE id=1')).rows[0];
    if(Number(row.lease_until)>now())return {busy:true};
    if(!force&&Number(row.completed_at)>0&&now()-Number(row.completed_at)<TTL)return {cached:true,...JSON.parse(row.summary_json||'{}')};
    await tx.execute({sql:'UPDATE yahoo_refresh_state SET owner=?,lease_until=? WHERE id=1',args:[owner,now()+120000]});
    return {owned:true};
   });
   if(state.cached)return state;
   if(state.busy){if(force||now()>=deadline)return {refreshing:true};await wait(1000);continue;}
   try{
    const result=await refresh(options);
    // A manual batch must not mark the entire universe as freshly cached.
    if(force)await db.prepare('UPDATE yahoo_refresh_state SET lease_until=0,owner=NULL WHERE id=1 AND owner=?').run(owner);
    else await db.prepare('UPDATE yahoo_refresh_state SET completed_at=?,summary_json=?,lease_until=0,owner=NULL WHERE id=1 AND owner=?').run(now(),JSON.stringify(result),owner);
    return {...result,cached:false};
   }catch(error){
    await db.prepare('UPDATE yahoo_refresh_state SET lease_until=0,owner=NULL WHERE id=1 AND owner=?').run(owner);
    throw error;
   }
  }
 }
 return (options={})=>{
  if(options.force===true&&pending)return Promise.resolve({refreshing:true});
  if(!pending)pending=run(options).finally(()=>{pending=null;});
  return pending;
 };
}
module.exports={createSharedPriceRefresh};
