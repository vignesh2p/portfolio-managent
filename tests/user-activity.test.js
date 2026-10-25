const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const {schema,record,report,weekStart}=require('../user-activity');
test('activity persists by India day, deduplicates tabs/retries and groups Monday weeks without backfilling',async()=>{
 const file=require('node:path').join(require('node:os').tmpdir(),'activity-'+require('node:crypto').randomUUID()+'.db');const client=createClient({url:require('node:url').pathToFileURL(file).href});
 try{
 await client.executeMultiple("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,account_status TEXT);INSERT INTO users VALUES(1,'A','a@test','approved'),(2,'B','b@test','blocked'),(3,'Never','n@test','approved'),(99,'System','system@test','approved');");
 for(const sql of schema)await client.execute(sql);
 const write=async(id,time)=>{const tx=await client.transaction('write');try{const r=await record(tx,id,new Date(time));await tx.commit();return r;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 assert.equal((await write(1,'2026-10-18T18:29:30Z')).counted,true); // Sunday IST
 assert.equal((await write(1,'2026-10-18T18:29:59Z')).counted,false);
 await write(1,'2026-10-18T18:30:00Z'); // Monday IST
 await write(1,'2026-10-19T12:31:00Z');
 await write(2,'2026-10-19T12:31:00Z');
 await write(99,'2026-10-19T12:31:00Z');
 const db={prepare:sql=>({all:async(...args)=>(await client.execute({sql,args})).rows,get:async(...args)=>(await client.execute({sql,args})).rows[0]})};
 const data=await report(db,'system@test',4,new Date('2026-10-25T10:00:00Z'));
 assert.equal(data.weeks.length,4);assert.equal(data.weeks.at(-1).week,'2026-10-19');assert.equal(data.weeks.at(-1).active_users,2);assert.equal(data.weeks.at(-1).active_minutes,3);
 const a=data.users.find(u=>u.id===1);assert.equal(a.active_minutes,3);assert.equal(a.active_days,2);assert.equal(a.active_weeks,2);
 assert.equal(data.users.find(u=>u.id===3).last_seen,null);assert.ok(data.tracking_since);
 await assert.rejects(report(db,'system@test',999),/Choose/);assert.equal(weekStart('2027-01-01'),'2026-12-28');
 }finally{client.close();try{require('fs').unlinkSync(file);}catch{}}
});
test('client heartbeat excludes hidden, unfocused, idle and signed-out states',async()=>{
 const vm=require('vm'),fs=require('fs');let now=Date.now(),interval,calls=0;const events={};
 class Clock extends Date{static now(){return now;}}
 const ctx={Date:Clock,TOKEN:'user1',BASE:'',globalThis:null,document:{visibilityState:'visible',hidden:false,hasFocus:()=>true,addEventListener:(n,fn)=>events[n]=fn},window:{addEventListener:(n,fn)=>events[n]=fn},setInterval:fn=>interval=fn,fetch:async()=>{calls++;return {ok:true};}};ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(fs.readFileSync('user-activity-client.js','utf8'),ctx);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);await interval();assert.equal(calls,1);
 now+=61000;await interval();assert.equal(calls,1); // idle
 ctx.document.visibilityState='hidden';events.pointerdown({isTrusted:true});await interval();assert.equal(calls,1);
 ctx.document.visibilityState='visible';ctx.document.hasFocus=()=>false;events.pointerdown({isTrusted:true});await interval();assert.equal(calls,1);
 ctx.document.hasFocus=()=>true;events.pointerdown({isTrusted:true});await new Promise(r=>setImmediate(r));assert.equal(calls,2);
 ctx.TOKEN=null;now+=60000;events.pointerdown({isTrusted:true});await interval();assert.equal(calls,2);
 ctx.TOKEN='user2';await interval();assert.equal(calls,3);
});
test('activity routes use user and admin authentication respectively',()=>{
 const source=require('fs').readFileSync('server.js','utf8');assert.match(source,/app.post\('\/api\/activity\/heartbeat',auth,/);assert.match(source,/app.get\('\/api\/admin\/activity',adminAuth,/);assert.match(source,/userActivity.record\(tx,req.user.id\)/);
});
