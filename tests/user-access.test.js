const {test}=require('node:test'),assert=require('node:assert/strict');
const {migrateUserAccess,createUserAuth,changeUserAccess,UNAVAILABLE,PENDING_APPROVAL,accountAccessMessage}=require('../user-access');
test('migration approves existing users once; lifecycle blocks old tokens and soft delete retains data',async()=>{
 const {createClient}=require('@libsql/client'),fs=require('fs'),path=require('path');
 const file=path.join(require('os').tmpdir(),'access-'+require('crypto').randomUUID()+'.db');
 const client=createClient({url:require('url').pathToFileURL(file).href});
 try{
 await client.executeMultiple("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO users VALUES(1,'old'),(99,'system');CREATE TABLE trade_history(user_id INTEGER);INSERT INTO trade_history VALUES(1);");
 await migrateUserAccess(sql=>client.execute(sql));
 const db={prepare:sql=>({get:async(...args)=>(await client.execute({sql,args})).rows[0],run:async(...args)=>{const r=await client.execute({sql,args});return {changes:r.rowsAffected};}})};
 assert.equal((await client.execute('SELECT account_status FROM users WHERE id=1')).rows[0].account_status,'approved');
 await client.execute("INSERT INTO users(id,email,account_status) VALUES(2,'new','pending')");
 let claims={id:1},allowed=false,status,body;
 const auth=createUserAuth({db,jwt:{verify:()=>claims},secret:'test'});
 const call=async()=>{allowed=false;status=200;await auth({headers:{authorization:'Bearer test'}},{status:n=>{status=n;return {json:v=>body=v};}},()=>allowed=true);};
 await call();assert.equal(allowed,true);
 claims={id:2};await call();assert.equal(status,403);assert.equal(body.error,PENDING_APPROVAL);
 await changeUserAccess(db,2,'approve','system');claims={id:2,version:1};await call();assert.equal(allowed,true);
 await changeUserAccess(db,2,'block','system');await call();assert.equal(allowed,false);assert.equal(body.error,UNAVAILABLE);
 await migrateUserAccess(sql=>client.execute(sql));assert.equal((await client.execute('SELECT account_status FROM users WHERE id=2')).rows[0].account_status,'blocked');
 await changeUserAccess(db,2,'approve','system');await call();assert.equal(allowed,false,'old token stays invalid after reapproval');
 claims={id:2,version:3};await call();assert.equal(allowed,true);
 await changeUserAccess(db,1,'delete','system');claims={id:1};await call();assert.equal(body.error,UNAVAILABLE);
 assert.equal((await client.execute('SELECT * FROM trade_history')).rows.length,1);assert.ok((await client.execute('SELECT deleted_at FROM users WHERE id=1')).rows[0].deleted_at);
 await assert.rejects(changeUserAccess(db,1,'approve','system'),/deleted/);
 await assert.rejects(changeUserAccess(db,99,'block','system'),/not found/);
 }finally{client.close();try{fs.rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
});
test('signup has no session; pending login shows approval message; blocked and deleted logins stay generic',async()=>{
 const fs=require('fs'),vm=require('vm');
 const source=fs.readFileSync(require('path').join(__dirname,'../server.js'),'utf8');
 const code=source.slice(source.indexOf('app.post("/api/auth/signup"'),source.indexOf('app.post("/api/auth/admin-login"'));
 const handlers={};let user,insertSql,refreshes=0;
 vm.runInNewContext(code,{app:{post:(path,fn)=>handlers[path]=fn},UNAVAILABLE,accountAccessMessage,bcrypt:{hash:async()=> 'hash',compare:async()=>true},signUserToken:()=> 'token',refreshPricesForSession:async()=>refreshes++,db:{prepare:sql=>({get:async()=>user,run:async()=>{insertSql=sql;return {lastInsertRowid:3};}})}});
 async function call(path){let status=200,body;const res={status:n=>{status=n;return res;},json:v=>body=v};await handlers[path]({body:{email:'new@example.com',password:'secret1',name:'New'}},res);return {status,body};}
 const signup=await call('/api/auth/signup');assert.equal(signup.status,201);assert.equal(signup.body.approval_required,true);assert.equal(signup.body.token,undefined);assert.match(insertSql,/'pending'/);assert.equal(refreshes,0);
 for(const state of ['pending','blocked','deleted']){user={id:3,account_status:state,password:'hash'};const login=await call('/api/auth/login');assert.equal(login.status,403);assert.equal(login.body.error,state==='pending'?'Waiting for admin Approval':'Tech error please reach admin.');assert.equal(login.body.token,undefined);}
 user={id:3,account_status:'approved',password:'hash'};assert.equal((await call('/api/auth/login')).body.token,'token');assert.equal(refreshes,1);
 assert.match(source,/app\.put\('\/api\/admin\/users\/:id\/access',adminAuth/);
 assert.ok(source.includes("if(table==='users'){await changeUserAccess(db,id,'delete'"));
});
