const {randomUUID}=require('node:crypto');
const {TTL}=require('./yahoo-prices');
function createSharedPriceRefresh({db,transactionRaw,refresh,now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 let pending;
 async function run(){
  const owner=randomUUID(),deadline=now()+90000;
  while(true){
   const state=await transactionRaw(async tx=>{
    const row=(await tx.execute('SELECT * FROM yahoo_refresh_state WHERE id=1')).rows[0];
    if(Number(row.lease_until)>now())return {busy:true};
    if(Number(row.completed_at)>0&&now()-Number(row.completed_at)<TTL)return {cached:true,...JSON.parse(row.summary_json||'{}')};
    await tx.execute({sql:'UPDATE yahoo_refresh_state SET owner=?,lease_until=? WHERE id=1',args:[owner,now()+120000]});
    return {owned:true};
   });
   if(state.cached)return state;
   if(state.busy){if(now()>=deadline)return {refreshing:true};await wait(1000);continue;}
   try{
    const result=await refresh();
    await db.prepare('UPDATE yahoo_refresh_state SET completed_at=?,summary_json=?,lease_until=0,owner=NULL WHERE id=1 AND owner=?').run(now(),JSON.stringify(result),owner);
    return {...result,cached:false};
   }catch(error){
    await db.prepare('UPDATE yahoo_refresh_state SET lease_until=0,owner=NULL WHERE id=1 AND owner=?').run(owner);
    throw error;
   }
  }
 }
 return ()=>{
  if(!pending)pending=run().finally(()=>{pending=null;});
  return pending;
 };
}
module.exports={createSharedPriceRefresh};
