const {test}=require('node:test'),assert=require('node:assert/strict');
const {createSharedPriceRefresh}=require('../shared-price-refresh');
const {TTL}=require('../yahoo-prices');
test('different users and server instances share one refresh until the 30-minute window expires',async()=>{
 let time=1000000,runs=0;const row={lease_until:0,completed_at:0};
 let transactionQueue=Promise.resolve();
 const execute=async query=>{
  if(typeof query==='string')return {rows:[{...row}]};
  if(query.sql.includes('SET owner=')){row.owner=query.args[0];row.lease_until=query.args[1];}
  return {rows:[]};
 };
 const transactionRaw=fn=>{const work=transactionQueue.then(()=>fn({execute}));transactionQueue=work.catch(()=>{});return work;};
 const db={prepare:sql=>({run:async(...args)=>{if(sql.includes('completed_at')){if(row.owner===args[2])Object.assign(row,{completed_at:args[0],summary_json:args[1],lease_until:0,owner:null});}else if(row.owner===args[0])Object.assign(row,{lease_until:0,owner:null});}})};
 const options={db,transactionRaw,now:()=>time,wait:()=>new Promise(resolve=>setTimeout(resolve,1)),refresh:async()=>{runs++;await new Promise(resolve=>setTimeout(resolve,5));return {total:157};}};
 const instanceA=createSharedPriceRefresh(options),instanceB=createSharedPriceRefresh(options);
 const result=await Promise.all([instanceA(),instanceA(),instanceB()]);assert.equal(runs,1);assert.ok(result.every(x=>x.total===157));
 time+=TTL-1;assert.equal((await instanceB()).cached,true);assert.equal(runs,1);
 time++;await Promise.all([instanceA(),instanceB()]);assert.equal(runs,2);
 // An abandoned server lease can be recovered after its expiry.
 row.lease_until=time-1;row.completed_at=0;row.owner='dead';await instanceB();assert.equal(runs,3);
});
