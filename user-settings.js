const {validateTarget}=require('./growth-target');
const {validateAthAge}=require('./ath-age-settings');
const {validateReplacementAthAge}=require('./replacement-ath-age-settings');
const {validateSIPConfig}=require('./sip-config-validation');

function validateUserSettings(body){
 return {
  target_growth_pct:validateTarget(body?.target_growth_pct),
  ath_age_days:validateAthAge(body?.ath_age_days),
  replacement_ath_age_days:validateReplacementAthAge(body?.replacement_ath_age_days),
  ...validateSIPConfig(body)
 };
}
async function saveUserSettings(tx,uid,data){
 await tx.execute({sql:'INSERT INTO user_growth_targets(user_id,target_growth_pct) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET target_growth_pct=excluded.target_growth_pct',args:[uid,data.target_growth_pct]});
 await tx.execute({sql:'INSERT INTO user_ath_age_settings(user_id,ath_age_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET ath_age_days=excluded.ath_age_days',args:[uid,data.ath_age_days]});
 await tx.execute({sql:'INSERT INTO user_replacement_ath_age_settings(user_id,replacement_ath_age_days) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET replacement_ath_age_days=excluded.replacement_ath_age_days',args:[uid,data.replacement_ath_age_days]});
 await tx.execute({sql:'INSERT INTO sip_config(user_id,max_budget,levels) VALUES (?,?,?)',args:[uid,data.max_budget,JSON.stringify(data.levels)]});
 return data;
}
function register(app,{auth,read,transaction}){
 app.get('/api/user-settings',auth,async(req,res)=>{
  try{res.set('Cache-Control','no-store').json({success:true,data:await read(req.user.id)});}
  catch{res.status(503).json({success:false,error:'Unable to load settings. Please retry.'});}
 });
 app.put('/api/user-settings',auth,async(req,res)=>{
  let data;
  try{data=validateUserSettings(req.body);}catch(error){return res.status(400).json({success:false,error:error.message});}
  try{await transaction(tx=>saveUserSettings(tx,req.user.id,data));res.json({success:true,data});}
  catch{res.status(503).json({success:false,error:'Unable to save settings. No changes were saved. Please retry.'});}
 });
}
module.exports={register,validateUserSettings,saveUserSettings};
