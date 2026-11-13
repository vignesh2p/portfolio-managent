const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const bcrypt=require('bcryptjs');
const {schema,createPasswordReset,createEmailSender,register}=require('../password-reset');
async function fixture(fn){
  const file=require('path').join(require('os').tmpdir(),'reset-'+require('crypto').randomUUID()+'.db');
  const client=createClient({url:require('url').pathToFileURL(file).href});
  await client.execute("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT,account_status TEXT,deleted_at TEXT,token_version INTEGER DEFAULT 0)");
  for(const sql of schema)await client.execute(sql);
  await client.execute("INSERT INTO users(id,email,password,account_status) VALUES(1,'user@example.com','old','approved'),(2,'blocked@example.com','old','blocked'),(3,'pending@example.com','old','pending'),(4,'system@example.com','old','approved')");
  let time=1000000;const sent=[];
  // Serialize local transactions just as remote SQLite write transactions serialize.
  let tail=Promise.resolve();
  const transaction=fn=>{const work=tail.then(async()=>{const tx=await client.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}});tail=work.catch(()=>{});return work;};
  const options={transaction,secret:'test-secret',systemEmail:'system@example.com',now:()=>time,sendEmail:async(email,code)=>sent.push({email,code})};
  try{await fn({client,options,sent,advance:ms=>time+=ms,service:createPasswordReset(options)});}finally{client.close();try{require('fs').rmSync(file,{force:true});}catch(e){if(e.code!=='EPERM')throw e;}}
}
test('email code verifies once, password updates once, and sessions are revoked',()=>fixture(async({service,sent,client})=>{
  await service.request('user@example.com','ip');assert.match(sent[0].code,/^\d{6}$/);
  const stored=(await client.execute('SELECT * FROM password_resets')).rows[0];assert.notEqual(stored.code_hash,sent[0].code);
  const verified=await service.verify('user@example.com',sent[0].code);assert.equal(verified.reset_token.length,64);
  assert.equal((await service.verify('user@example.com',sent[0].code)).status,400);
  const results=await Promise.all([service.reset(verified.reset_token,'newPassword1'),service.reset(verified.reset_token,'newPassword1')]);
  assert.equal(results.filter(r=>r.message).length,1);assert.equal(results.filter(r=>r.status===400).length,1);
  const user=(await client.execute('SELECT * FROM users WHERE id=1')).rows[0];assert.equal(user.token_version,1);assert.ok(await bcrypt.compare('newPassword1',user.password));
}));
test('unknown, blocked and system accounts get generic response; cooldown and resend invalidate old codes',()=>fixture(async({service,sent,advance})=>{
  const first=await service.request('user@example.com','ip');
  for(const email of ['missing@example.com','blocked@example.com','system@example.com'])assert.deepEqual(await service.request(email,'ip'),first);
  await service.request('user@example.com','ip');assert.equal(sent.length,1);
  advance(61000);await service.request('user@example.com','ip');assert.equal(sent.length,2);
  if(sent[0].code!==sent[1].code)assert.equal((await service.verify('user@example.com',sent[0].code)).status,400);
  assert.ok((await service.verify('user@example.com',sent[1].code)).reset_token);
}));
test('five wrong attempts lock the code, codes and verified sessions expire',()=>fixture(async({service,sent,advance})=>{
  await service.request('user@example.com','ip');
  const wrong=sent[0].code==='000000'?'000001':'000000';
  for(let i=0;i<5;i++)assert.equal((await service.verify('user@example.com',wrong)).status,400);
  assert.equal((await service.verify('user@example.com',sent[0].code)).status,400);
  advance(61000);await service.request('user@example.com','ip');advance(600001);
  assert.equal((await service.verify('user@example.com',sent[1].code)).status,400);
  await service.request('user@example.com','ip');const v=await service.verify('user@example.com',sent[2].code);advance(600001);
  assert.equal((await service.reset(v.reset_token,'password123')).status,400);
}));
test('pending accounts remain pending; changes to account access revoke reset sessions',()=>fixture(async({service,sent,client})=>{
  await service.request('pending@example.com','ip');let v=await service.verify('pending@example.com',sent[0].code);
  await service.reset(v.reset_token,'password123');assert.equal((await client.execute('SELECT account_status FROM users WHERE id=3')).rows[0].account_status,'pending');
  await service.request('user@example.com','ip');v=await service.verify('user@example.com',sent[1].code);
  await client.execute('UPDATE users SET token_version=token_version+1 WHERE id=1');assert.equal((await service.reset(v.reset_token,'password123')).status,400);
}));
test('request limits persist across service instances',()=>fixture(async({service,options,sent,advance})=>{
  for(let i=0;i<6;i++){await createPasswordReset(options).request('user@example.com','ip');advance(61000);}
  assert.equal(sent.length,5);
  for(let i=0;i<24;i++)await service.request(`unknown${i}@example.com`,'ip');
  assert.equal((await service.request('last@example.com','ip')).status,429);
}));
test('email sender uses configured provider and rejects delivery failures',async()=>{
  let payload;
  const send=createEmailSender({RESEND_API_KEY:'key',PASSWORD_RESET_FROM:'security@example.com'},async(url,options)=>{payload=JSON.parse(options.body);assert.equal(url,'https://api.resend.com/emails');return {ok:true};});
  assert.ok(send.available());await send('user@example.com','012345');assert.match(payload.text,/012345/);assert.deepEqual(payload.to,['user@example.com']);
  assert.equal(createEmailSender({}).available(),false);
  await assert.rejects(createEmailSender({},async()=>({ok:false}))('u@example.com','123456'),/delivery failed/);
});
test('routes reject malformed input and bcrypt truncation without touching database',async()=>{
  const routes={};register({post:(p,fn)=>routes[p]=fn},{secret:'test',transaction:()=>{throw Error('must not query');},sendEmail:async()=>{}});
  for(const [action,body] of [['request',{email:[]}],['verify',{email:'u@example.com',code:123456}],['reset',{reset_token:'a'.repeat(64),password:'😀'.repeat(20)}]]){
    let status,payload;const res={set:()=>res,status:n=>{status=n;return res;},json:v=>payload=v};
    await routes['/api/auth/password-reset/'+action]({body},res);assert.equal(status,400);assert.equal(payload.success,false);
  }
});
