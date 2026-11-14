const DEFAULT_TARGET=30;
const schema=`CREATE TABLE IF NOT EXISTS user_growth_targets (user_id INTEGER PRIMARY KEY,target_growth_pct REAL NOT NULL DEFAULT 30)`;
function validateTarget(value){
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1000)throw Object.assign(new Error('Enter a target growth percentage between 0 and 1000.'),{status:400});
 return value;
}
function createGrowthTargets(db){
 async function get(uid){const row=await db.prepare('SELECT target_growth_pct FROM user_growth_targets WHERE user_id=?').get(uid);return row?Number(row.target_growth_pct):DEFAULT_TARGET;}
 function register(app,auth){
  app.get('/api/growth-target',auth,async(req,res)=>{try{res.set('Cache-Control','no-store').json({success:true,data:{target_growth_pct:await get(req.user.id)}});}catch{res.status(503).json({success:false,error:'Unable to load target growth. Please retry.'});}});
  app.put('/api/growth-target',auth,async(req,res)=>{try{const target=validateTarget(req.body?.target_growth_pct);await db.prepare('INSERT INTO user_growth_targets(user_id,target_growth_pct) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET target_growth_pct=excluded.target_growth_pct').run(req.user.id,target);res.json({success:true,data:{target_growth_pct:target}});}catch(error){res.status(error.status||503).json({success:false,error:error.status===400?error.message:'Unable to save target growth. Please retry.'});}});
 }
 return {get,register};
}
module.exports={schema,DEFAULT_TARGET,validateTarget,createGrowthTargets};
