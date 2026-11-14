const {createHash,timingSafeEqual}=require('node:crypto');
const schema=`CREATE TABLE IF NOT EXISTS portfolio_daily_history (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, snapshot_date TEXT NOT NULL,
 portfolio_value REAL, cost_value REAL NOT NULL, profit_value REAL, day_change REAL, day_change_pct REAL,
 holding_count INTEGER NOT NULL, missing_prices INTEGER NOT NULL, stale_prices INTEGER NOT NULL,
 price_as_of TEXT, recorded_at TEXT NOT NULL, PRIMARY KEY(user_id,snapshot_date))`;
const indiaDate=date=>new Date(date.getTime()+330*60000).toISOString().slice(0,10);
function totals(holdings,quoteFor,now=new Date()){
 let value=0,cost=0,previous=0,missing=0,stale=0,missingPrevious=false;
 const dates=[];
 const owned=holdings.filter(h=>Number(h.shares)>0);
 for(const h of owned){
  const shares=Number(h.shares),quote=quoteFor(h);
  cost+=shares*Number(h.avg_price);
  const price=quote?.price??quote?.cmp;
  if(!Number.isFinite(price)||price<=0){missing++;missingPrevious=true;continue;}
  value+=shares*price;
  const prev=Number.isFinite(quote.prevClose)?quote.prevClose:Number.isFinite(quote.change)?price-quote.change:null;
  if(prev===null||prev<=0)missingPrevious=true;else previous+=shares*prev;
  if(quote.stale||!Number.isFinite(Date.parse(quote.quote_fetched_at))||now-Date.parse(quote.quote_fetched_at)>60*60000)stale++;
  if(quote.price_as_of)dates.push(quote.price_as_of);
 }
 return {portfolio_value:missing?null:value,cost_value:cost,profit_value:missing?null:value-cost,
  day_change:missingPrevious?null:value-previous,day_change_pct:missingPrevious?null:previous>0?(value-previous)/previous*100:0,
  holding_count:owned.length,missing_prices:missing,stale_prices:stale,price_as_of:dates.sort()[0]||null};
}
function fillHistoricalDayChanges(rows,trades){
 return rows.map((row,index)=>{
  if(Number.isFinite(row.day_change))return {...row,day_change_source:'previous_close'};
  const previous=rows[index-1];
  let reason='Previous daily snapshot unavailable';
  if(previous && Date.parse(row.snapshot_date)-Date.parse(previous.snapshot_date)===86400000){
   const traded=trades.some(t=>{
    const stamp=Date.parse(t.traded_at);
    // Invalid dates cannot establish that holdings were unchanged.
    return !Number.isFinite(stamp)||stamp>Date.parse(previous.recorded_at)&&stamp<=Date.parse(row.recorded_at);
   });
   const validTimes=Number.isFinite(Date.parse(previous.recorded_at))&&Number.isFinite(Date.parse(row.recorded_at));
   if(!Number.isFinite(row.portfolio_value)||!Number.isFinite(previous.portfolio_value))reason='A saved valuation has missing prices';
   else if(!validTimes||traded||row.cost_value!==previous.cost_value||row.holding_count!==previous.holding_count)reason='Holdings changed; historical previous-close prices were not saved';
   else {
    const amount=row.portfolio_value-previous.portfolio_value;
    return {...row,day_change:amount,day_change_pct:previous.portfolio_value>0?amount/previous.portfolio_value*100:amount===0?0:null,day_change_source:'saved_snapshots'};
   }
  }
  return {...row,day_change_reason:reason};
 });
}
function createHistory({db,transaction,universe,matchStock,refresh,systemEmail,now=()=>new Date(),secret=()=>process.env.CRON_SECRET}){
 async function capture(date=now()){
  const stocks=await universe(),day=indiaDate(date);
  // Read holdings and insert all user snapshots in one transaction; retries never rewrite a saved day.
  return transaction(async tx=>{
   const users=(await tx.execute({sql:'SELECT id FROM users WHERE email<>?',args:[systemEmail]})).rows;
   const holdings=(await tx.execute('SELECT * FROM portfolio WHERE shares>0')).rows;
   let saved=0,missing=0,stale=0;
   for(const user of users){
    const summary=totals(holdings.filter(h=>h.user_id===user.id),h=>matchStock(h,stocks),date);
    const result=await tx.execute({sql:`INSERT OR IGNORE INTO portfolio_daily_history
     (user_id,snapshot_date,portfolio_value,cost_value,profit_value,holding_count,missing_prices,stale_prices,price_as_of,recorded_at,day_change,day_change_pct)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,args:[user.id,day,summary.portfolio_value,summary.cost_value,summary.profit_value,summary.holding_count,summary.missing_prices,summary.stale_prices,summary.price_as_of,date.toISOString(),summary.day_change,summary.day_change_pct]});
    saved+=result.rowsAffected;missing+=summary.missing_prices;stale+=summary.stale_prices;
   }
   return {date:day,users:users.length,saved,missing_prices:missing,stale_prices:stale};
  });
 }
 async function history(req,res){
  res.set('Cache-Control','no-store');
  try{const data=await db.prepare('SELECT snapshot_date,portfolio_value,cost_value,profit_value,day_change,day_change_pct,holding_count,missing_prices,stale_prices,price_as_of,recorded_at FROM portfolio_daily_history WHERE user_id=? ORDER BY snapshot_date').all(req.user.id);
   const trades=data.some(row=>!Number.isFinite(row.day_change))?await db.prepare('SELECT traded_at FROM trade_history WHERE user_id=?').all(req.user.id):[];
   res.json({success:true,data:fillHistoricalDayChanges(data,trades)});
  }catch(error){res.status(500).json({success:false,error:'Unable to load portfolio history.'});}
 }
 async function cron(req,res){
  res.set('Cache-Control','no-store');
  const expected=secret(),hash=value=>createHash('sha256').update(value).digest();
  if(!expected)return res.status(503).json({success:false,error:'Scheduler authentication is not configured.'});
  if(!timingSafeEqual(hash(req.headers.authorization||''),hash('Bearer '+expected)))return res.status(401).json({success:false,error:'Unauthorized'});
  const schedule={timezone:'Asia/Kolkata',time:'16:00',frequency:'daily'};
  if(req.query.dry_run==='1')return res.json({success:true,dryRun:true,schedule});
  const date=now(),local=new Date(date.getTime()+330*60000);
  if(local.getUTCHours()<16)return res.json({success:true,skipped:true,reason:'Daily snapshots start at 4:00 pm IST',schedule});
  try{
   await refresh();
   const result=await capture(now());
   res.json({success:true,...result,schedule});
  }catch(error){console.error('Portfolio snapshot failed:',error.message);res.status(500).json({success:false,error:'Portfolio snapshot failed. Retry the daily run.'});}
 }
 return {capture,history,cron};
}
module.exports={schema,totals,indiaDate,fillHistoricalDayChanges,createHistory};
