const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const jwt=require('jsonwebtoken');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createUserAuth}=require('../user-access');
const {schema,register}=require('../tax-harvesting-routes');
const {DEFAULTS,financialYear}=require('../tax-harvesting');

test('tax endpoints enforce ownership, consent, single use, revocation and audited admin updates',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tax-routes-')),filename=path.join(directory,'test.db');
 const client=createClient({url:'file:'+filename.replaceAll('\\','/')}),routes=new Map();
 const db={prepare:sql=>({all:async(...args)=>(await client.execute({sql,args})).rows,get:async(...args)=>(await client.execute({sql,args})).rows[0],run:async(...args)=>{const r=await client.execute({sql,args});return {changes:r.rowsAffected};}})};
 const transaction=async fn=>{const tx=await client.transaction('write');try{const r=await fn(tx);await tx.commit();return r;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 try{
 for(const sql of [...schema,
  'CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,account_status TEXT,deleted_at TEXT,token_version INTEGER)',
  'CREATE TABLE portfolio(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,shares REAL,avg_price REAL)',
  'CREATE TABLE trade_history(id INTEGER PRIMARY KEY,user_id INTEGER,ticker TEXT,type TEXT,shares REAL,price REAL,traded_at TEXT)'])await client.execute(sql);
 for(let id=1;id<=3;id++)await client.execute({sql:"INSERT INTO users VALUES(?,?,?,'approved',NULL,0)",args:[id,'Person '+id,'p'+id+'@test']});
 const year=financialYear().year;
 await client.execute({sql:'INSERT INTO portfolio VALUES(1,1,\'ABC\',100,100)',args:[]});
 await client.execute({sql:'INSERT INTO trade_history VALUES(1,1,\'ABC\',\'BUY\',100,100,?)',args:[(year-2)+'-04-01']});
 const app=Object.fromEntries(['get','post','put','delete'].map(method=>[method,(path,...handlers)=>routes.set(method+' '+path,handlers)]));
 const secret='test-secret',auth=createUserAuth({db,jwt,secret});
 const adminAuth=(req,res,next)=>{try{req.user=jwt.verify(req.headers.authorization.slice(7),secret);if(req.user.role==='admin')return next();}catch{}res.status(403).json({success:false});};
 register(app,{db,auth,adminAuth,transaction,universe:async()=>[{ticker:'ABC',name:'ABC Industries',cmp:200,quote_fetched_at:new Date().toISOString()}],matchStock:(h,stocks)=>stocks.find(s=>s.ticker===h.ticker)});
 async function call(method,path,id,body={},params={},query={}){
  const req={headers:{authorization:id?'Bearer '+jwt.sign(id==='admin'?{role:'admin',email:'admin@test'}:{id,role:'user',version:0},secret):''},body,params,query};
  const res={code:200,set(){return this;},status(n){this.code=n;return this;},json(value){this.body=value;return this;}};
  const handlers=routes.get(method+' '+path);let i=0;const next=async()=>{if(i<handlers.length)await handlers[i++](req,res,next);};
  // createUserAuth calls next without awaiting it; collect final response completion.
  let done;const completed=new Promise(resolve=>done=resolve);const json=res.json;res.json=function(value){json.call(this,value);done();return this;};
  await next();await completed;return res;
 }
 assert.equal((await call('get','/api/tax-harvesting',null)).code,401);
 let result=await call('get','/api/tax-harvesting',1,{}, {},{user_id:2});
 assert.deepEqual(result.body.data.accounts.map(a=>a.user_id),[1]);assert.equal(result.body.data.accounts[0].recommendations.length,1);
 assert.equal(result.body.data.accounts[0].recommendations[0].stock_name,'ABC Industries');assert.equal(result.body.data.accounts[0].positions[0].stock_name,'ABC Industries');
 assert.equal((await call('get','/api/admin/tax-settings',1)).code,403);
 assert.equal((await call('post','/api/tax-harvesting/family/code',2,{})).code,400);
 const code=(await call('post','/api/tax-harvesting/family/code',2,{consent:true})).body.data.code;
 assert.equal((await call('post','/api/tax-harvesting/family/link',1,{code,distinct_taxpayer:false})).code,400);
 assert.equal((await call('post','/api/tax-harvesting/family/link',1,{code,distinct_taxpayer:true})).code,200);
 assert.equal((await call('post','/api/tax-harvesting/family/link',3,{code,distinct_taxpayer:true})).code,400);
 assert.deepEqual((await call('get','/api/tax-harvesting',1)).body.data.accounts.map(a=>a.user_id),[1,2]);
 assert.deepEqual((await call('get','/api/tax-harvesting',2)).body.data.accounts.map(a=>a.user_id),[2]);
 await client.execute("UPDATE users SET account_status='blocked' WHERE id=2");
 assert.equal((await call('get','/api/tax-harvesting',1)).body.data.accounts.length,1);
 await client.execute("UPDATE users SET account_status='approved' WHERE id=2");
 await call('delete','/api/tax-harvesting/family/:direction/:id',3,{}, {direction:'shared',id:'1'});
 assert.equal((await call('get','/api/tax-harvesting',1)).body.data.accounts.length,2);
 await call('delete','/api/tax-harvesting/family/:direction/:id',2,{}, {direction:'shared',id:'1'});
 assert.equal((await call('get','/api/tax-harvesting',1)).body.data.accounts.length,1);
 const oldCode=(await call('post','/api/tax-harvesting/family/code',2,{consent:true})).body.data.code;
 await client.execute("UPDATE tax_family_codes SET expires_at='2000-01-01'");
 assert.equal((await call('post','/api/tax-harvesting/family/link',1,{code:oldCode,distinct_taxpayer:true})).code,400);
 const config=(await call('get','/api/admin/tax-settings','admin')).body.data;
 const values={...DEFAULTS,ltcg_exemption:5000};
 result=await call('put','/api/admin/tax-settings','admin',{...config,values});assert.equal(result.code,200);
 assert.equal((await call('put','/api/admin/tax-settings','admin',{...config,values})).code,409);
 assert.equal((await call('put','/api/admin/tax-settings','admin',{...result.body.data,values:{...values,stcg_rate:Infinity}})).code,400);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tax_settings_audit').get()).n,1);
 result=await call('get','/api/tax-harvesting',1);assert.equal(result.body.data.accounts[0].recommendations[0].quantity,50);
 }finally{client.close();for(const suffix of ['','-wal','-shm']){try{fs.unlinkSync(filename+suffix);}catch{}}try{fs.rmdirSync(directory);}catch{}}
});
