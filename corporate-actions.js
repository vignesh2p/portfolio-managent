'use strict';
const crypto=require('node:crypto');
const schema=[
 `CREATE TABLE IF NOT EXISTS corporate_action_rollout(id INTEGER PRIMARY KEY CHECK(id=1),baseline TEXT NOT NULL)`,
 `INSERT OR IGNORE INTO corporate_action_rollout(id,baseline) VALUES(1,date('now','+5 hours','+30 minutes'))`,
 `CREATE TABLE IF NOT EXISTS corporate_actions(id INTEGER PRIMARY KEY AUTOINCREMENT,ticker TEXT NOT NULL,kind TEXT NOT NULL,ex_date TEXT NOT NULL,numerator REAL NOT NULL,denominator REAL NOT NULL,description TEXT NOT NULL DEFAULT '',source TEXT NOT NULL,created_by TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(ticker,ex_date,kind))`,
 `CREATE TABLE IF NOT EXISTS corporate_action_decisions(user_id INTEGER NOT NULL,action_id INTEGER NOT NULL,holding_ticker TEXT NOT NULL,status TEXT NOT NULL,details TEXT NOT NULL,decided_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(user_id,action_id,holding_ticker))`,
 `CREATE TABLE IF NOT EXISTS corporate_action_notifications(user_id INTEGER NOT NULL,action_id INTEGER NOT NULL,holding_ticker TEXT NOT NULL,PRIMARY KEY(user_id,action_id,holding_ticker))`,
 `CREATE TABLE IF NOT EXISTS corporate_action_fetch(ticker TEXT PRIMARY KEY,from_date TEXT NOT NULL,fetched_at INTEGER NOT NULL)`
];
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const day=value=>String(value||'').slice(0,10);
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function validate(input){
 const ticker=String(input.ticker||'').trim().toUpperCase(),kind=input.kind,ex_date=input.ex_date;
 if(!/^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(ticker))fail(400,'Enter the stock’s Yahoo Finance code.');
 if(!['split','reverse_split','bonus','demerger'].includes(kind))fail(400,'Invalid action type.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(ex_date||'')||!Number.isFinite(Date.parse(ex_date))||new Date(ex_date).toISOString().slice(0,10)!==ex_date)fail(400,'Enter a valid ex-date.');
 const numerator=Number(input.numerator),denominator=Number(input.denominator);
 if(!Number.isSafeInteger(numerator)||!Number.isSafeInteger(denominator)||numerator<=0||denominator<=0||numerator>1000000||denominator>1000000)fail(400,'Ratio values must be positive whole numbers, at most 1,000,000.');
 if(kind==='split'&&numerator<=denominator||kind==='reverse_split'&&numerator>=denominator)fail(400,'Split ratios mean new shares : old shares. Check the ratio direction.');
 const description=String(input.description||'').trim();if(description.length>2000)fail(400,'Description is too long.');
 return {ticker,kind,ex_date,numerator,denominator,description};
}
function preview(action,trades,holding,now=today()){
 const before=trades.filter(t=>day(t.traded_at)<action.ex_date);
 const eligible=before.reduce((n,t)=>n+(t.type==='BUY'?1:-1)*Number(t.shares),0);
 const factor=action.numerator/action.denominator;
 const additional=action.kind==='bonus'?eligible*factor:eligible*(factor-1);
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({action,trades,holding})).digest('hex');
 let blocked=null;
 if(action.ex_date>now)blocked='Available on the ex-date. Eligibility is provisional until then.';
 else if(eligible<=0)blocked='No eligible shares held before the ex-date.';
 else if(action.kind==='demerger')blocked='Demerger allocation requires manual trades and cost-basis allocation. Enter these first, then mark as handled.';
 else if(Math.abs((action.kind==='bonus'?additional:eligible*factor)-Math.round(action.kind==='bonus'?additional:eligible*factor))>1e-7)blocked='Fractional entitlement: reconcile shares and cash-in-lieu manually, then mark as handled.';
 return {eligible_shares:eligible,additional_shares:additional,resulting_shares:Number(holding.shares)+additional,price:action.kind==='bonus'?0:null,fingerprint,blocked};
}
function databaseFor(tx){return {prepare:sql=>({all:async(...args)=>(await tx.execute({sql,args})).rows.map(r=>({...r})),get:async(...args)=>(await tx.execute({sql,args})).rows[0],run:async(...args)=>tx.execute({sql,args})})};}
function createService({db,transaction,yf,universe,matchStock,rebuild,now=today}){
 async function positions(database,uid){
  const [holdings,trades,stocks]=await Promise.all([database.prepare('SELECT * FROM portfolio WHERE user_id=? AND shares>0').all(uid),database.prepare('SELECT * FROM trade_history WHERE user_id=? ORDER BY traded_at,id').all(uid),universe()]);
  // Keep unresolved notifications visible after a user sells the holding.
  const tracked=await database.prepare('SELECT DISTINCT n.holding_ticker,a.ticker AS code FROM corporate_action_notifications n JOIN corporate_actions a ON a.id=n.action_id WHERE n.user_id=? AND NOT EXISTS(SELECT 1 FROM corporate_action_decisions d WHERE d.user_id=n.user_id AND d.action_id=n.action_id AND d.holding_ticker=n.holding_ticker)').all(uid);
  for(const item of tracked){if(!holdings.some(h=>h.ticker===item.holding_ticker)){const trade=trades.find(t=>t.ticker===item.holding_ticker);if(trade)holdings.push({ticker:item.holding_ticker,shares:0,avg_price:0,yahoo_finance_code:item.code,stock_name:trade.stock_name||'',ok_code:trade.ok_code||''});}}
  return holdings.map(h=>{const ts=trades.filter(t=>t.ticker===h.ticker),first=ts.filter(t=>t.type==='BUY').map(t=>day(t.traded_at)).sort()[0];return {holding:h,trades:ts,first,code:String(h.yahoo_finance_code||matchStock(h,stocks)?.yahoo_finance_code||h.ticker).toUpperCase()};}).filter(p=>p.first);
 }
 async function sync(uid){
  const warnings=[];
  for(const p of await positions(db,uid)){
   try{
    const cached=await db.prepare('SELECT * FROM corporate_action_fetch WHERE ticker=?').get(p.code);
    if(cached&&cached.from_date<=p.first&&Date.now()-Number(cached.fetched_at)<6*3600000)continue;
    const from=cached&&cached.from_date<p.first?cached.from_date:p.first;
    const result=await yf.chart(p.code,{period1:from,interval:'1mo',events:'split'});
    const splits=Object.values(result.events?.splits||{});
    for(const s of splits){
     const date=new Date(s.date).toISOString().slice(0,10),n=Number(s.numerator),d=Number(s.denominator);
     if(!Number.isFinite(n)||!Number.isFinite(d)||n<=0||d<=0||n===d)continue;
     // Provider events can represent bonuses as splits. Admin entries take precedence.
     const manual=await db.prepare("SELECT id FROM corporate_actions WHERE ticker=? AND ex_date=? AND source='Admin'").get(p.code,date);
     if(!manual)await db.prepare("INSERT OR IGNORE INTO corporate_actions(ticker,kind,ex_date,numerator,denominator,description,source) SELECT ?,?,?,?,?,?,'Yahoo Finance' WHERE NOT EXISTS(SELECT 1 FROM corporate_actions WHERE ticker=? AND ex_date=? AND source='Admin')").run(p.code,n>d?'split':'reverse_split',date,n,d,'Provider-reported share ratio. Verify whether this is a split or bonus before applying.',p.code,date);
    }
    await db.prepare('INSERT INTO corporate_action_fetch(ticker,from_date,fetched_at) VALUES(?,?,?) ON CONFLICT(ticker) DO UPDATE SET from_date=excluded.from_date,fetched_at=excluded.fetched_at').run(p.code,from,Date.now());
   }catch{warnings.push(p.code+': corporate action feed unavailable; showing saved and admin-entered actions.');}
  }
  return warnings;
 }
 async function list(uid,database=db){
  const baseline=(await database.prepare('SELECT baseline FROM corporate_action_rollout WHERE id=1').get()).baseline;
  const notifications=await database.prepare('SELECT action_id,holding_ticker FROM corporate_action_notifications WHERE user_id=?').all(uid);
  const output=[];
  for(const p of await positions(database,uid)){
   const actions=await database.prepare('SELECT * FROM corporate_actions WHERE ticker=? AND ex_date>=? ORDER BY ex_date,id').all(p.code,p.first);
   const decisions=await database.prepare('SELECT * FROM corporate_action_decisions WHERE user_id=? AND holding_ticker=?').all(uid,p.holding.ticker);
   for(const action of actions){
    const decision=decisions.find(d=>Number(d.action_id)===Number(action.id));
    const plan=preview(action,p.trades,p.holding,now());
    const tracked=notifications.some(n=>Number(n.action_id)===Number(action.id)&&n.holding_ticker===p.holding.ticker);
    const status=decision?.status||(action.ex_date<=baseline?'read':plan.eligible_shares>0||tracked?'pending':'ineligible');
    if(status==='pending'&&!tracked)await database.prepare('INSERT OR IGNORE INTO corporate_action_notifications(user_id,action_id,holding_ticker) VALUES(?,?,?)').run(uid,action.id,p.holding.ticker);
    output.push({...action,holding_ticker:p.holding.ticker,from_date:p.first,status,plan,decided_at:decision?.decided_at||null});
   }
  }
  return {baseline,actions:output,pending:output.filter(a=>a.status==='pending').length};
 }
 async function decide(uid,id,input){
  if(!['apply','ignore','handled'].includes(input.decision))fail(400,'Choose Apply or Ignore.');
  return transaction(async tx=>{
   const database=databaseFor(tx),data=await list(uid,database);
   const a=data.actions.find(a=>Number(a.id)===Number(id)&&a.holding_ticker===input.holding_ticker);
   if(!a)fail(404,'Action not found in your portfolio.');
   if(a.status!=='pending')fail(409,'This action is already handled or is not eligible. Refresh the page.');
   const p=(await positions(database,uid)).find(p=>p.holding.ticker===a.holding_ticker);
   if(input.fingerprint!==a.plan.fingerprint)fail(409,'Trades or action terms changed. Review a fresh preview.');
   if(input.decision==='handled'&&a.ex_date>now())fail(409,'Wait until the ex-date before marking an action handled.');
   if(input.decision==='apply'){
    if(a.plan.blocked)fail(409,a.plan.blocked);
    const earlier=data.actions.find(x=>x.holding_ticker===a.holding_ticker&&x.status==='pending'&&x.ex_date<a.ex_date);
    if(earlier)fail(409,'Apply or ignore earlier actions for this stock first.');
    if(a.source==='Yahoo Finance'&&input.verified!==true)fail(400,'Confirm the action type and ratio against the company announcement.');
    if(a.kind==='bonus'){
     await database.prepare("INSERT INTO trade_history(user_id,exchange,ticker,type,shares,price,amount,notes,traded_at,yahoo_finance_code,stock_name,ok_code) VALUES(?,?,?,'BUY',?,0,0,?,?,?,?,?)").run(uid,p.trades[0]?.exchange||'',p.holding.ticker,a.plan.additional_shares,`Bonus · corporate action #${a.id} · ${a.numerator}:${a.denominator}`,a.ex_date,p.code,p.holding.stock_name||'',p.holding.ok_code||'');
    }else{
     const factor=a.numerator/a.denominator;
     for(const t of p.trades.filter(t=>day(t.traded_at)<a.ex_date)){
      await database.prepare('UPDATE trade_history SET shares=?,price=?,notes=? WHERE id=? AND user_id=?').run(Number(t.shares)*factor,Number(t.price)/factor,[t.notes,a.kind==='reverse_split'?'Reverse Split':'Split',`corporate action #${a.id} · ${a.numerator}:${a.denominator}`].filter(Boolean).join(' · '),t.id,uid);
     }
    }
    const changed=await database.prepare('SELECT * FROM trade_history WHERE user_id=? AND ticker=? ORDER BY traded_at,id').all(uid,p.holding.ticker);
    let balance=0;
    for(const trade of changed){balance+=(trade.type==='BUY'?1:-1)*Number(trade.shares);if(!Number.isFinite(balance)||balance< -0.00001)fail(409,'This adjustment conflicts with later sales. Reconcile the trade history before applying.');}
    await rebuild(uid,p.holding.ticker,database);
    await database.prepare('UPDATE portfolio SET yahoo_finance_code=?,stock_name=?,ok_code=? WHERE user_id=? AND ticker=?').run(p.code,p.holding.stock_name||'',p.holding.ok_code||'',uid,p.holding.ticker);
   }
   const status=input.decision==='ignore'?'ignored':'applied';
   await database.prepare('INSERT INTO corporate_action_decisions(user_id,action_id,holding_ticker,status,details) VALUES(?,?,?,?,?)').run(uid,a.id,a.holding_ticker,status,JSON.stringify({decision:input.decision,preview:a.plan,before:p.trades}));
   return {status};
  });
 }
 async function add(input,actor){
  const a=validate(input);
  return transaction(async tx=>{
   const database=databaseFor(tx);
   const existing=await database.prepare('SELECT * FROM corporate_actions WHERE ticker=? AND ex_date=?').all(a.ticker,a.ex_date);
   for(const row of existing){
    if(row.source==='Admin'&&row.kind!==a.kind)continue;
    const used=await database.prepare('SELECT action_id FROM corporate_action_decisions WHERE action_id=? LIMIT 1').get(row.id);
    if(used)fail(409,'This action has already been handled by a user and cannot be replaced.');
    await database.prepare('DELETE FROM corporate_action_notifications WHERE action_id=?').run(row.id);
    await database.prepare('DELETE FROM corporate_actions WHERE id=?').run(row.id);
   }
   await database.prepare("INSERT INTO corporate_actions(ticker,kind,ex_date,numerator,denominator,description,source,created_by) VALUES(?,?,?,?,?,?,'Admin',?)").run(a.ticker,a.kind,a.ex_date,a.numerator,a.denominator,a.description,actor);
   return a;
  });
 }
 return {list,sync,decide,add};
}
function register(app,options){
 const service=createService(options),{auth,adminAuth,db}=options;
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{res.json({success:true,...await fn(req)});}catch(e){res.status(e.status||500).json({success:false,error:e.status?e.message:'Corporate actions could not be loaded or saved. Please retry.'});}};
 app.get('/api/corporate-actions',auth,wrap(async req=>({data:await service.list(req.user.id)})));
 app.post('/api/corporate-actions/sync',auth,wrap(async req=>({warnings:await service.sync(req.user.id),data:await service.list(req.user.id)})));
 app.post('/api/corporate-actions/:id/decision',auth,wrap(async req=>({data:await service.decide(req.user.id,req.params.id,req.body)})));
 app.get('/api/admin/corporate-actions',adminAuth,wrap(async()=>({data:await db.prepare('SELECT * FROM corporate_actions ORDER BY ex_date DESC,id DESC').all()})));
 app.post('/api/admin/corporate-actions',adminAuth,wrap(async req=>({data:await service.add(req.body,req.user.email)})));
 return service;
}
module.exports={schema,validate,preview,createService,register};
