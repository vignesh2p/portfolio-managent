const {test}=require('node:test'),assert=require('node:assert/strict');
const {createClient}=require('@libsql/client');
const settings=require('../user-settings');
const valid=()=>({target_growth_pct:25,ath_age_days:500,replacement_ath_age_days:150,max_budget:75000,levels:[{fall:-10,allocation:40},{fall:-30,allocation:60}]});
test('unified settings rejects every invalid field before starting a write',async()=>{
 let writes=0,handler;settings.register({get(){},put:(p,a,h)=>handler=h},{auth(){},read(){},transaction:async()=>writes++});
 for(const body of [{...valid(),target_growth_pct:-1},{...valid(),ath_age_days:1.5},{...valid(),replacement_ath_age_days:0},{...valid(),max_budget:0},{...valid(),levels:[{fall:-10,allocation:99}]}]){
  let status;await handler({user:{id:1},body},{status(n){status=n;return this;},json(){}});assert.equal(status,400);
 }
 assert.equal(writes,0);
});
test('unified save is atomic and user scoped, including failure on the final write',async()=>{
 const filename=require('path').join(require('os').tmpdir(),'settings-'+require('crypto').randomUUID()+'.db');
 const client=createClient({url:require('url').pathToFileURL(filename).href});
 try{
 for(const mod of ['growth-target','ath-age-settings','replacement-ath-age-settings'])await client.execute(require('../'+mod).schema);
 await client.execute('CREATE TABLE sip_config(id INTEGER PRIMARY KEY,user_id INTEGER,max_budget REAL,levels TEXT)');
 const transaction=async fn=>{const tx=await client.transaction('write');try{const result=await fn(tx);await tx.commit();return result;}catch(e){await tx.rollback();throw e;}finally{tx.close();}};
 await transaction(tx=>settings.saveUserSettings(tx,2,settings.validateUserSettings({...valid(),target_growth_pct:40})));
 const routes={},auth=()=>{};settings.register({get:(p,a,h)=>{assert.equal(a,auth);routes.get=h;},put:(p,a,h)=>{assert.equal(a,auth);routes.put=h;}},{auth,transaction,read:async uid=>({user_id:uid,...valid()})});
 let body,status;const res={set(){return this;},status(n){status=n;return this;},json(j){body=j;}};
 await routes.put({user:{id:1},body:valid()},res);assert.equal(body.success,true);
 assert.equal((await client.execute('SELECT target_growth_pct FROM user_growth_targets WHERE user_id=1')).rows[0].target_growth_pct,25);
 await client.execute("CREATE TRIGGER fail_settings BEFORE INSERT ON sip_config BEGIN SELECT RAISE(ABORT,'simulated storage error'); END;");
 await routes.put({user:{id:1},body:{...valid(),target_growth_pct:99,ath_age_days:999,replacement_ath_age_days:999,max_budget:999}},res);assert.equal(status,503);assert.match(body.error,/No changes were saved/);
 assert.equal((await client.execute('SELECT target_growth_pct FROM user_growth_targets WHERE user_id=1')).rows[0].target_growth_pct,25);
 assert.equal((await client.execute('SELECT ath_age_days FROM user_ath_age_settings WHERE user_id=1')).rows[0].ath_age_days,500);
 assert.equal((await client.execute('SELECT replacement_ath_age_days FROM user_replacement_ath_age_settings WHERE user_id=1')).rows[0].replacement_ath_age_days,150);
 assert.equal((await client.execute('SELECT COUNT(*) n FROM sip_config WHERE user_id=1')).rows[0].n,1);
 assert.equal((await client.execute('SELECT target_growth_pct FROM user_growth_targets WHERE user_id=2')).rows[0].target_growth_pct,40);
 await routes.get({user:{id:1}},res);assert.equal(body.data.user_id,1);
 }finally{client.close();try{require('fs').unlinkSync(filename);}catch{}}
});
