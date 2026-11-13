'use strict';
const crypto=require('node:crypto');
const engine=require('./tax-harvesting');
const schema=[
 `CREATE TABLE IF NOT EXISTS tax_settings(financial_year INTEGER PRIMARY KEY,settings_json TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS tax_settings_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,financial_year INTEGER NOT NULL,settings_json TEXT NOT NULL,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS tax_family_codes(code_hash TEXT PRIMARY KEY,subject_id INTEGER NOT NULL,expires_at TEXT NOT NULL,redeemed_by INTEGER)`,
 `CREATE TABLE IF NOT EXISTS tax_family_links(viewer_id INTEGER NOT NULL,subject_id INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(viewer_id,subject_id))`
];
function register(app,{db,auth,adminAuth,universe,matchStock,transaction}) {
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{await fn(req,res);}catch(e){res.status(e.status||500).json({success:false,error:e.status?e.message:'Unable to load or save tax harvesting data. Please retry.'});}};
 const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
 const currentYear=()=>engine.financialYear().year;
 async function settings(year) {const row=await db.prepare('SELECT * FROM tax_settings WHERE financial_year=?').get(year);return {values:row?engine.validateSettings(JSON.parse(row.settings_json)):{...engine.DEFAULTS},updated_at:row?.updated_at||null,financial_year:year};}
 app.get('/api/admin/tax-settings',adminAuth,wrap(async(req,res)=>{res.json({success:true,data:await settings(currentYear())});}));
 app.put('/api/admin/tax-settings',adminAuth,wrap(async(req,res)=>{
   if(req.body.financial_year!==currentYear())fail(409,'Financial year changed. Reload settings.');
   const values=engine.validateSettings(req.body.values||{}),stamp=new Date().toISOString(),year=currentYear();
   await transaction(async tx=>{
     const rows=await tx.execute({sql:'SELECT updated_at FROM tax_settings WHERE financial_year=?',args:[year]});
     if((rows.rows[0]?.updated_at||null)!==(req.body.updated_at||null))fail(409,'Settings changed by another admin. Reload before saving.');
     const args=[year,JSON.stringify(values),stamp,req.user.email];
     await tx.execute({sql:'INSERT INTO tax_settings(financial_year,settings_json,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(financial_year) DO UPDATE SET settings_json=excluded.settings_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by',args});
     await tx.execute({sql:'INSERT INTO tax_settings_audit(financial_year,settings_json,updated_at,updated_by) VALUES(?,?,?,?)',args});
   });
   res.json({success:true,data:await settings(year)});
 }));
 app.get('/api/tax-harvesting/family',auth,wrap(async(req,res)=>{
   const viewing=await db.prepare('SELECT u.id,u.name,u.email FROM tax_family_links l JOIN users u ON u.id=l.subject_id WHERE l.viewer_id=?').all(req.user.id);
   const shared_with=await db.prepare('SELECT u.id,u.name,u.email FROM tax_family_links l JOIN users u ON u.id=l.viewer_id WHERE l.subject_id=?').all(req.user.id);
   res.json({success:true,data:{viewing,shared_with}});
 }));
 app.post('/api/tax-harvesting/family/code',auth,wrap(async(req,res)=>{
   if(req.body.consent!==true)fail(400,'Confirm sharing consent.');
   const code=crypto.randomBytes(18).toString('hex'),hash=crypto.createHash('sha256').update(code).digest('hex'),expires=new Date(Date.now()+600000).toISOString();
   await transaction(async tx=>{
     await tx.execute({sql:'DELETE FROM tax_family_codes WHERE subject_id=? OR expires_at<?',args:[req.user.id,new Date().toISOString()]});
     await tx.execute({sql:'INSERT INTO tax_family_codes(code_hash,subject_id,expires_at) VALUES(?,?,?)',args:[hash,req.user.id,expires]});
   });
   res.json({success:true,data:{code,expires_at:expires}});
 }));
 app.post('/api/tax-harvesting/family/link',auth,wrap(async(req,res)=>{
   if(req.body.distinct_taxpayer!==true)fail(400,'Each linked account must represent a different taxpayer. Consolidate same-person trades into one account.');
   if(typeof req.body.code!=='string'||! /^[a-f0-9]{36}$/.test(req.body.code))fail(400,'Invalid or expired sharing code.');
   const hash=crypto.createHash('sha256').update(req.body.code).digest('hex');
   await transaction(async tx=>{
     const result=await tx.execute({sql:"SELECT c.subject_id FROM tax_family_codes c JOIN users u ON u.id=c.subject_id WHERE c.code_hash=? AND c.redeemed_by IS NULL AND c.expires_at>? AND u.account_status='approved' AND u.deleted_at IS NULL",args:[hash,new Date().toISOString()]});
     const subject=Number(result.rows[0]?.subject_id);if(!subject||subject===req.user.id)fail(400,'Invalid, expired or own-account sharing code.');
     await tx.execute({sql:'INSERT OR IGNORE INTO tax_family_links(viewer_id,subject_id,created_at) VALUES(?,?,?)',args:[req.user.id,subject,new Date().toISOString()]});
     await tx.execute({sql:'UPDATE tax_family_codes SET redeemed_by=? WHERE code_hash=?',args:[req.user.id,hash]});
   });
   res.json({success:true});
 }));
 app.delete('/api/tax-harvesting/family/:direction/:id',auth,wrap(async(req,res)=>{
   const id=Number(req.params.id),direction=req.params.direction;
   if(!Number.isSafeInteger(id)||id<=0||!['viewing','shared'].includes(direction))fail(400,'Invalid family link.');
   await db.prepare('DELETE FROM tax_family_links WHERE viewer_id=? AND subject_id=?').run(direction==='viewing'?req.user.id:id,direction==='viewing'?id:req.user.id);
   // Revoking access also invalidates outstanding sharing codes.
   await db.prepare('DELETE FROM tax_family_codes WHERE subject_id=?').run(req.user.id);
   res.json({success:true});
 }));
 app.get('/api/tax-harvesting',auth,wrap(async(req,res)=>{
   const config=await settings(currentYear()),stocks=await universe();
   const users=await db.prepare("SELECT id,name,email FROM users WHERE account_status='approved' AND deleted_at IS NULL AND (id=? OR id IN (SELECT subject_id FROM tax_family_links WHERE viewer_id=?)) ORDER BY id").all(req.user.id,req.user.id);
   const accounts=[],tradesByUser=new Map();
   for(const user of users){
     const [holdings,trades]=await Promise.all([
       db.prepare('SELECT * FROM portfolio WHERE user_id=? AND shares>0').all(user.id),
       db.prepare('SELECT * FROM trade_history WHERE user_id=? ORDER BY traded_at,id').all(user.id)
     ]);
     const identity=row=>{const stock=matchStock(row,stocks);return stock?.isin||stock?.ticker||row.yahoo_finance_code||row.ticker;};
     tradesByUser.set(user.id,trades.map(t=>({...t,identity:identity(t)})));
     accounts.push(engine.analyzeAccount({user,trades:trades.map(t=>({...t,stock_name:t.stock_name||matchStock(t,stocks)?.name||''})),settings:config.values,holdings:holdings.map(h=>{const s=matchStock(h,stocks);return {...h,stock_name:h.stock_name||s?.name||'',identity:identity(h),current_price:s?.cmp,price_as_of:s?.price_as_of,quote_fetched_at:s?.quote_fetched_at};})}));
   }
   res.json({success:true,data:{as_of:new Date().toISOString(),settings:config,accounts:engine.familyReview(accounts,tradesByUser,config.values),scope:'Saved delivery-equity trades only. One app account per taxpayer. Consolidate all broker accounts for that person. Estimates exclude cess, surcharge, transaction costs, carried-forward losses, other income and special tax adjustments. Verify STT eligibility and corporate actions before acting.'}});
 }));
}
module.exports={schema,register};
