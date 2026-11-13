const {actualInvested,applyOpportunityBeta}=require('./opportunity-beta');
const {tradingDate}=require('./yahoo-prices');
const schema=`CREATE TABLE IF NOT EXISTS opportunity_beta_cycles (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,ticker TEXT NOT NULL,
 ath REAL NOT NULL,ath_date TEXT,reset_at TEXT NOT NULL,kind TEXT NOT NULL,
 base_invested REAL NOT NULL,max_budget REAL NOT NULL,cycle_cap REAL NOT NULL,
 closed_at TEXT,snapshot_json TEXT NOT NULL DEFAULT '{}')`;
const indexSchema='CREATE UNIQUE INDEX IF NOT EXISTS beta_one_open_cycle ON opportunity_beta_cycles(user_id,ticker) WHERE closed_at IS NULL';
function validDate(value){
 return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
}
function tradeDate(value){
 if(typeof value!=='string'||!validDate(value.slice(0,10)))return null;
 // Date-only and offset-free imported timestamps represent the Indian trade day.
 if(value.length===10||!/(Z|[+-]\d{2}:?\d{2})$/i.test(value))return value.slice(0,10);
 return tradingDate(value);
}
function historicalCycleStart(athDate,trades,fallback,observedAt){
 if(!validDate(athDate)||athDate>tradingDate(observedAt)||!Array.isArray(trades))return null;
 if(!trades.length&&Number(fallback)!==0)return null;
 const dates=trades.map(trade=>tradeDate(trade.traded_at));
 if(dates.some(date=>!date))return null;
 const base=actualInvested(trades.filter((trade,index)=>dates[index]<athDate));
 if(base===null)return null;
 return {base,resetAt:athDate+'T00:00:00+05:30'};
}
function createBetaCycles({db,transaction,now=()=>new Date().toISOString()}){
 async function observe(input){
  const {userId,ticker,ath,athDate,budget,levels,trades,price,fallback=0}=input;
  const invested=actualInvested(trades,fallback);
  if(!Number.isFinite(ath)||ath<=0||!Number.isFinite(budget)||budget<0||invested===null)return null;
  return transaction(async tx=>{
   const run=(sql,args=[])=>tx.execute({sql,args});
   let current=(await run('SELECT * FROM opportunity_beta_cycles WHERE user_id=? AND ticker=? AND closed_at IS NULL',[userId,ticker])).rows[0];
   const timestamp=now();
   const historical=input.allowHistorical===false?null:historicalCycleStart(athDate,trades,fallback,timestamp);
   const sameAth=current&&Math.abs(ath-Number(current.ath))<=1e-8;
   // Preserve the earlier tracking snapshot instead of overwriting it when its
   // observation-date baseline is replaced with a Yahoo-dated reconstruction.
   const backfill=historical&&sameAth&&current.kind!=='yahoo_history';
   if(!current||backfill||(input.allowReset!==false&&ath>Number(current.ath)+1e-8)){
    const kind=historical?'yahoo_history':current?'reset':'baseline',base=historical?historical.base:current?invested:0;
    const resetAt=historical?historical.resetAt:timestamp;
    if(current)await run('UPDATE opportunity_beta_cycles SET closed_at=? WHERE id=? AND closed_at IS NULL',[timestamp,current.id]);
    const cap=Math.max(0,budget-base);
    const inserted=await run('INSERT INTO opportunity_beta_cycles(user_id,ticker,ath,ath_date,reset_at,kind,base_invested,max_budget,cycle_cap) VALUES (?,?,?,?,?,?,?,?,?)',[userId,ticker,ath,athDate||null,resetAt,kind,base,budget,cap]);
    current={id:Number(inserted.lastInsertRowid),user_id:userId,ticker,ath,ath_date:athDate||null,reset_at:resetAt,kind,base_invested:base,max_budget:budget,cycle_cap:cap,closed_at:null};
   }
   const cycleAth=Number(current.ath);
   const preview=levels.map((level,i)=>({...level,active:price>0&&price<=cycleAth*(1+Number(level.fall)/100)&&price>(levels[i+1]?cycleAth*(1+Number(levels[i+1].fall)/100):0)}));
   const previousSnapshot=JSON.parse(current.snapshot_json||'{}');
   const snapshot={as_of:timestamp,recorded_at:previousSnapshot.recorded_at||timestamp,price,ath:cycleAth,max_budget:budget,actual_invested:invested,levels:applyOpportunityBeta(preview,trades,budget,price,cycleAth,fallback,current)};
   await run('UPDATE opportunity_beta_cycles SET snapshot_json=? WHERE id=?',[JSON.stringify(snapshot),current.id]);
   const history=(await run('SELECT * FROM opportunity_beta_cycles WHERE user_id=? AND ticker=? AND closed_at IS NOT NULL ORDER BY id DESC',[userId,ticker])).rows.map(row=>({...row,snapshot:JSON.parse(row.snapshot_json)}));
   return {...current,snapshot,history,date_note:current.kind==='yahoo_history'?'Cycle starts on Yahoo’s ATH trading date. Trades on that date count in the new cycle.':'Observed-date tracking: a verified historical ATH date and complete dated trades are needed to reconstruct the start.'};
  });
 }
 return {observe};
}
module.exports={schema,indexSchema,createBetaCycles,historicalCycleStart};
