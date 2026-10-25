const {createHash}=require('node:crypto');
const schema=`CREATE TABLE IF NOT EXISTS rebalance_batches(user_id INTEGER NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(user_id,request_id))`;
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
function indiaDate(now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
function daysSince(date,now=new Date()){
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
 const ms=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(ms)||new Date(ms).toISOString().slice(0,10)!==date)return null;
 const days=Math.round((Date.parse(indiaDate(now)+'T00:00:00Z')-ms)/86400000);
 return days>=0?days:null;
}
function sourceRows(holdings,stocks,match,now){
 return holdings.filter(h=>Number(h.shares)>0).map(h=>{const s=match(h,stocks);return {...h,name:s?.name||h.stock_name||h.ticker,code:s?.code||h.ok_code||'',stock_code:s?.stock_code||h.ticker,price:s?.price??null,ath_drop_pct:Number.isFinite(s?.price)&&s.price>0&&Number.isFinite(s?.ath)&&s.ath>0?(s.price/s.ath-1)*100:null,ath_date:s?.ath_date||null,days_since:daysSince(s?.ath_date,now),invested_amount:Number(h.shares)*Number(h.avg_price),market_value:Number.isFinite(s?.price)&&s.price>0?Number(h.shares)*s.price:null,quote_error:s?.quote_error||null};}).filter(h=>h.days_since>365).sort((a,b)=>a.days_since-b.days_since);
}
function candidates(stocks,holdings,levels,allowed,source,match,now){
 const master=match(source,stocks);
 return stocks.filter(s=>s.ticker!==master?.ticker&&s.ticker!==source.ticker&&allowed.has(s.ticker)&&String(s.code||'').trim()&&String(s.stock_code||'').trim()&&Number.isFinite(s.price)&&s.price>0&&s.ath>0).map(s=>{
  const zone=levels.find((l,i)=>s.price<=s.ath*(1+Number(l.fall)/100)&&s.price>(levels[i+1]?s.ath*(1+Number(levels[i+1].fall)/100):0));
  if(!zone||!(Number(zone.allocation)>0))return null;
  const owned=holdings.find(h=>match(h,stocks)?.ticker===s.ticker);
  return {ticker:owned?.ticker||s.ticker,name:s.name,code:s.code,stock_code:s.stock_code,price:s.price,fall:Number(zone.fall),allocation:Number(zone.allocation),drop_pct:(s.price/s.ath-1)*100,days_since:daysSince(s.ath_date,now),quote_error:s.quote_error||null};
 }).filter(row=>row&&row.days_since!==null&&row.days_since<100).sort((a,b)=>b.fall-a.fall||(a.days_since??Infinity)-(b.days_since??Infinity)||a.ticker.localeCompare(b.ticker));
}
function combinations(rows,budget){
 if(!(budget>0))return [];
 const result=[],seen=new Set();
 function add(picks){
  const key=picks.map(p=>p.ticker).sort().join('|');if(seen.has(key))return;seen.add(key);
  const weight=picks.reduce((s,p)=>s+p.allocation,0);
  const buys=picks.map(p=>({...p,shares:Math.floor((budget*p.allocation/weight)/p.price)}));
  if(buys.some(p=>p.shares<1))return;
  const total=buys.reduce((s,p)=>s+p.price*p.shares,0);
  result.push({buys,total,remaining:budget-total});
 }
 const groups=new Map();for(const r of [...rows].sort((a,b)=>b.fall-a.fall||(a.days_since??Infinity)-(b.days_since??Infinity)||a.ticker.localeCompare(b.ticker))){if(!groups.has(r.fall))groups.set(r.fall,[]);groups.get(r.fall).push(r);}
 for(const group of groups.values()){
  group.forEach(p=>add([p]));
  for(let i=0;i<Math.min(3,group.length-1);i++)add([group[i],group[i+1]]);
  for(let i=0;i<Math.min(3,group.length-2);i++)add(group.slice(i,i+3));
 }
 const groupsArray=[...groups.values()];
 for(let i=0;i<Math.min(groupsArray.length,12);i++){
  if(groupsArray.length>1)add([groupsArray[i][0],groupsArray[(i+1)%groupsArray.length][0]]);
  if(groupsArray.length>2)add([groupsArray[i][0],groupsArray[(i+1)%groupsArray.length][0],groupsArray[(i+2)%groupsArray.length][0]]);
 }
 return result.sort((a,b)=>Math.max(...b.buys.map(x=>x.fall))-Math.max(...a.buys.map(x=>x.fall))||Math.min(...a.buys.map(x=>x.days_since??Infinity))-Math.min(...b.buys.map(x=>x.days_since??Infinity))||a.buys.length-b.buys.length);
}
function validate(body){
 if(!body||typeof body.request_id!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.request_id))fail(400,'Invalid confirmation identifier. Reopen the rebalance dialog.');
 if(daysSince(body.date)===null)fail(400,'Choose a valid trade date no later than today.');
 if(!Array.isArray(body.buys)||body.buys.length<1||body.buys.length>10)fail(400,'Choose between 1 and 10 buy trades.');
 const entries=[body.sell,...body.buys];
 for(const t of entries){if(!t||typeof t.ticker!=='string'||!t.ticker||!Number.isFinite(t.shares)||t.shares<=0||t.shares>1e9||Math.abs(t.shares*10000-Math.round(t.shares*10000))>0.0001||!Number.isFinite(t.price)||t.price<=0||t.price>1e9||t.shares*t.price>1e12)fail(400,'Every trade needs a valid stock, positive price and quantity (up to 4 decimal places).');}
 if(new Set(entries.map(t=>t.ticker)).size!==entries.length)fail(400,'Use distinct buy stocks and exclude the stock being sold.');
 const proceeds=body.sell.shares*body.sell.price,cost=body.buys.reduce((s,t)=>s+t.shares*t.price,0);
 if(cost>proceeds+0.005)fail(400,'Buy total exceeds sale proceeds. Reduce buy quantities.');
 return {request_id:body.request_id,date:body.date,sell:{ticker:body.sell.ticker,shares:body.sell.shares,price:body.sell.price},buys:body.buys.map(t=>({ticker:t.ticker,shares:t.shares,price:t.price}))};
}
async function commit(tx,uid,input,context){
 const body=validate(input),hash=createHash('sha256').update(JSON.stringify(body)).digest('hex');
 const run=(sql,args=[])=>tx.execute({sql,args});
 const saved=(await run('SELECT * FROM rebalance_batches WHERE user_id=? AND request_id=?',[uid,body.request_id])).rows[0];
 if(saved){if(saved.payload_hash!==hash)fail(409,'This confirmation was already used for different trades.');return JSON.parse(saved.result_json);}
 const source=context.sources.find(s=>s.ticker===body.sell.ticker);
 if(!source)fail(409,'This holding is no longer eligible for rebalancing. Refresh the page.');
 const permitted=new Map(context.candidates.map(s=>[s.ticker,s]));
 if(body.buys.some(b=>!permitted.has(b.ticker)))fail(409,'An opportunity is no longer in an active SIP zone. Reopen the rebalance dialog.');
 const holding=(await run('SELECT * FROM portfolio WHERE user_id=? AND ticker=?',[uid,body.sell.ticker])).rows[0];
 if(!holding||body.sell.shares>Number(holding.shares))fail(409,'Sell quantity exceeds your current holding. Refresh and try again.');
 const ids=[];
 for(const [i,t] of [body.sell,...body.buys].entries()){
  const latest=(await run('SELECT MAX(substr(traded_at,1,10)) AS date FROM trade_history WHERE user_id=? AND ticker=?',[uid,t.ticker])).rows[0]?.date;
  if(latest&&body.date<latest)fail(400,'Rebalancing date must be on or after the latest trade for every selected stock.');
  const type=i===0?'SELL':'BUY',stock=i===0?source:permitted.get(t.ticker);
  const existing=(await run('SELECT * FROM portfolio WHERE user_id=? AND ticker=?',[uid,t.ticker])).rows[0];
  const exchange=/^(NSE|BSE|BOM):/i.exec(stock.stock_code||t.ticker)?.[1]||'';
  const trade=await run('INSERT INTO trade_history(user_id,ticker,exchange,type,shares,price,amount,notes,traded_at,stock_name,ok_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',[uid,t.ticker,exchange,type,t.shares,t.price,t.shares*t.price,'Rebalance '+body.request_id,body.date+'T23:59:59+05:30',existing?.stock_name||stock.name,existing?.ok_code||stock.code||'']);
  ids.push(Number(trade.lastInsertRowid));
  if(type==='SELL'){
   const left=Number(existing.shares)-t.shares;
   if(left<=0.0001)await run('DELETE FROM portfolio WHERE user_id=? AND ticker=?',[uid,t.ticker]);
   else await run('UPDATE portfolio SET shares=? WHERE user_id=? AND ticker=?',[+left.toFixed(4),uid,t.ticker]);
  }else if(existing){
   const shares=Number(existing.shares)+t.shares,avg=(Number(existing.shares)*Number(existing.avg_price)+t.shares*t.price)/shares;
   await run('UPDATE portfolio SET shares=?,avg_price=? WHERE user_id=? AND ticker=?',[+shares.toFixed(4),+avg.toFixed(4),uid,t.ticker]);
  }else await run('INSERT INTO portfolio(user_id,ticker,shares,avg_price,stock_name,ok_code) VALUES (?,?,?,?,?,?)',[uid,t.ticker,t.shares,t.price,stock.name,stock.code]);
 }
 const result={trade_ids:ids,sell_total:body.sell.shares*body.sell.price,buy_total:body.buys.reduce((s,t)=>s+t.shares*t.price,0)};
 await run('INSERT INTO rebalance_batches(user_id,request_id,payload_hash,result_json) VALUES (?,?,?,?)',[uid,body.request_id,hash,JSON.stringify(result)]);
 return result;
}
module.exports={schema,indiaDate,daysSince,sourceRows,candidates,combinations,commit};
