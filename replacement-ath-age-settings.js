const DEFAULT_REPLACEMENT_ATH_AGE=100;
const schema=`CREATE TABLE IF NOT EXISTS user_replacement_ath_age_settings (user_id INTEGER PRIMARY KEY,replacement_ath_age_days INTEGER NOT NULL DEFAULT 100)`;
function validateReplacementAthAge(value){
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw Object.assign(new Error('Enter a positive whole number of days.'),{status:400});
 return value;
}
function createReplacementAthAgeSettings(db){
 async function get(uid){const row=await db.prepare('SELECT replacement_ath_age_days FROM user_replacement_ath_age_settings WHERE user_id=?').get(uid);return row?Number(row.replacement_ath_age_days):DEFAULT_REPLACEMENT_ATH_AGE;}
 function register(app,auth){
  app.get('/api/replacement-ath-age',auth,async(req,res)=>{try{res.set('Cache-Control','no-store').json({success:true,data:{replacement_ath_age_days:await get(req.user.id)}});}catch{res.status(503).json({success:false,error:'Unable to load replacement ATH age. Please retry.'});}});
  app.put('/api/replacement-ath-age',auth,async(req,res)=>{try{const target=validateReplacementAthAge(req.body?.replacement_ath_age_days);await db.prepare('INSERT INTO user_replacement_ath_age_settings(user_id,replacement_ath_age_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET replacement_ath_age_days=excluded.replacement_ath_age_days').run(req.user.id,target);res.json({success:true,data:{replacement_ath_age_days:target}});}catch(error){res.status(error.status||503).json({success:false,error:error.status===400?error.message:'Unable to save replacement ATH age. Please retry.'});}});
 }
 return {get,register};
}
module.exports={schema,DEFAULT_REPLACEMENT_ATH_AGE,validateReplacementAthAge,createReplacementAthAgeSettings};
