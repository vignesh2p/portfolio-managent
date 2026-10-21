const {createHash,timingSafeEqual}=require('node:crypto');
const SCHEDULE={timezone:'Asia/Kolkata',weekdays:'Monday–Friday',start:'09:00',end:'15:30',intervalMinutes:30};
// UTC half-hour slots, converted to IST without depending on the server timezone.
function watchlistSlot(date){
  const local=new Date(date.getTime()+330*60000);
  const weekday=local.getUTCDay();
  const minutes=local.getUTCHours()*60+local.getUTCMinutes();
  if(weekday===0||weekday===6||minutes<540||minutes>930)return null;
  return String(Math.floor(date.getTime()/1800000));
}
function createWatchlistCronHandler({db,sync,secret=()=>process.env.CRON_SECRET,now=()=>new Date()}){
  return async(req,res)=>{
    res.set('Cache-Control','no-store');
    const expected=secret();
    if(!expected)return res.status(503).json({success:false,error:'Scheduler authentication is not configured.'});
    const hash=value=>createHash('sha256').update(value).digest();
    if(!timingSafeEqual(hash(req.headers.authorization||''),hash(`Bearer ${expected}`))){
      return res.status(401).json({success:false,error:'Unauthorized'});
    }
    if(req.query.dry_run==='1')return res.json({success:true,dryRun:true,schedule:SCHEDULE});
    const date=now(),slot=watchlistSlot(date);
    if(!slot)return res.json({success:true,skipped:true,reason:'Outside the weekday trading window',schedule:SCHEDULE});
    let claimed=false;
    try{
      await db.exec(`CREATE TABLE IF NOT EXISTS watchlist_sync_runs (
        slot TEXT PRIMARY KEY,status TEXT NOT NULL,started_at INTEGER NOT NULL,completed_at TEXT,total INTEGER,error TEXT)`);
      // One run per half-hour across serverless instances; a failed or expired run can retry.
      const result=await db.prepare(`INSERT INTO watchlist_sync_runs(slot,status,started_at) VALUES (?,'running',?)
        ON CONFLICT(slot) DO UPDATE SET status='running',started_at=excluded.started_at,error=NULL
        WHERE watchlist_sync_runs.status='failed' OR (watchlist_sync_runs.status='running' AND watchlist_sync_runs.started_at<?)`)
        .run(slot,date.getTime(),date.getTime()-10*60000);
      if(!result.changes)return res.json({success:true,skipped:true,reason:'This interval is already running or complete'});
      claimed=true;
      const summary=await sync();
      const completedAt=now().toISOString();
      await db.prepare("UPDATE watchlist_sync_runs SET status='complete',completed_at=?,total=? WHERE slot=?").run(completedAt,summary.total,slot);
      await db.prepare('DELETE FROM watchlist_sync_runs WHERE started_at<?').run(date.getTime()-30*86400000).catch(()=>{});
      return res.json({success:true,total:summary.total,completedAt});
    }catch(error){
      if(claimed)await db.prepare("UPDATE watchlist_sync_runs SET status='failed',error=? WHERE slot=?").run(String(error.message).slice(0,500),slot).catch(()=>{});
      console.error('Scheduled watchlist sync failed:',error.message);
      return res.status(500).json({success:false,error:'Watchlist sync did not complete successfully. Retry this interval.'});
    }
  };
}
module.exports={SCHEDULE,watchlistSlot,createWatchlistCronHandler};
