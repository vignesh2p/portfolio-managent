const UNAVAILABLE='Tech error please reach admin.';
const PENDING_APPROVAL='Waiting for admin Approval';
function accountAccessMessage(user){return user?.account_status==='pending'&&!user.deleted_at?PENDING_APPROVAL:UNAVAILABLE;}
async function migrateUserAccess(execute){
 const columns=(await execute('PRAGMA table_info(users)')).rows;
 const names=new Set(columns.map(c=>c.name));
 for(const [name,definition] of [['account_status',"TEXT NOT NULL DEFAULT 'approved'"],['deleted_at','TEXT'],['token_version','INTEGER NOT NULL DEFAULT 0']]){
  if(!names.has(name))await execute(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
 }
}
function createUserAuth({db,jwt,secret}){
 return async(req,res,next)=>{
  let claims;
  try{claims=jwt.verify((req.headers.authorization||'').replace(/^Bearer /,''),secret);}catch{return res.status(401).json({success:false,error:'Invalid or expired token'});}
  if(claims.role&&claims.role!=='user')return res.status(401).json({success:false,error:'Invalid or expired token'});
  try{
   const user=await db.prepare('SELECT id,account_status,deleted_at,token_version FROM users WHERE id=?').get(claims.id);
   if(!user||user.account_status!=='approved'||user.deleted_at||Number(claims.version||0)!==Number(user.token_version))return res.status(403).json({success:false,code:'ACCOUNT_UNAVAILABLE',error:accountAccessMessage(user)});
   req.user={...claims,role:'user'};next();
  }catch{res.status(503).json({success:false,error:UNAVAILABLE});}
 };
}
async function changeUserAccess(db,id,action,systemEmail){
 if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Invalid user'),{status:400});
 const status={approve:'approved',block:'blocked',delete:'deleted'}[action];
 if(!status)throw Object.assign(new Error('Invalid action'),{status:400});
 const result=await db.prepare("UPDATE users SET account_status=?,deleted_at=?,token_version=token_version+1 WHERE id=? AND email<>? AND account_status<>'deleted'").run(status,status==='deleted'?new Date().toISOString():null,id,systemEmail);
 if(!result.changes)throw Object.assign(new Error('User not found or already deleted'),{status:404});
 return {id,status};
}
module.exports={UNAVAILABLE,PENDING_APPROVAL,accountAccessMessage,migrateUserAccess,createUserAuth,changeUserAccess};
