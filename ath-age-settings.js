const DEFAULT_ATH_AGE=365;
const schema=`CREATE TABLE IF NOT EXISTS user_ath_age_settings (user_id INTEGER PRIMARY KEY,ath_age_days INTEGER NOT NULL DEFAULT 365)`;
function validateAthAge(value){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Object.assign(new Error('Enter a non-negative whole number of days.'),{status:400});
 return value;
}
function createAthAgeSettings(db){
 async function get(uid){const row=await db.prepare('SELECT ath_age_days FROM user_ath_age_settings WHERE user_id=?').get(uid);return row?Number(row.ath_age_days):DEFAULT_ATH_AGE;}
 function register(app,auth){
  app.get('/api/ath-age',auth,async(req,res)=>{try{res.set('Cache-Control','no-store').json({success:true,data:{ath_age_days:await get(req.user.id)}});}catch{res.status(503).json({success:false,error:'Unable to load ATH age. Please retry.'});}});
  app.put('/api/ath-age',auth,async(req,res)=>{try{const target=validateAthAge(req.body?.ath_age_days);await db.prepare('INSERT INTO user_ath_age_settings(user_id,ath_age_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET ath_age_days=excluded.ath_age_days').run(req.user.id,target);res.json({success:true,data:{ath_age_days:target}});}catch(error){res.status(error.status||503).json({success:false,error:error.status===400?error.message:'Unable to save ATH age. Please retry.'});}});
 }
 return {get,register};
}
module.exports={schema,DEFAULT_ATH_AGE,validateAthAge,createAthAgeSettings};
