const {xirrEligible}=require('./xirr-eligibility');
function leaderboard(users,holdings,trades,stocks,xirr,matchStock,now=new Date()){
  const rows=users.map(user=>{
    const owned=holdings.filter(h=>h.user_id===user.id&&Number(h.shares)>0);
    let value=0,missing=false;
    for(const h of owned){const stock=matchStock(h,stocks);if(!stock||!Number.isFinite(Number(stock.cmp))||Number(stock.cmp)<=0){missing=true;continue;}value+=Number(h.shares)*Number(stock.cmp);}
    const flows=trades.filter(t=>t.user_id===user.id).map(t=>({amount:(t.type==='BUY'?-1:1)*Math.abs(Number(t.amount)),date:new Date(t.traded_at)}));
    if(value>0)flows.push({amount:value,date:now});
    const valid=flows.every(f=>Number.isFinite(f.amount)&&Number.isFinite(+f.date))&&new Set(flows.map(f=>+f.date)).size>1;
    const eligible=xirrEligible(trades.filter(t=>t.user_id===user.id),true,now);
    const result=eligible&&!missing&&valid?xirr(flows):null;
    return {user_id:user.id,name:user.name||user.email,email:user.email,xirr_pct:Number.isFinite(result)?result:null,current_value:value,status:!eligible?'XIRR available after one year':missing?'Missing stock price':Number.isFinite(result)?'Ranked':'Insufficient cash flows'};
  }).sort((a,b)=>(b.xirr_pct??-Infinity)-(a.xirr_pct??-Infinity)||a.user_id-b.user_id);
  let rank=0,previous;
  return rows.map((row,i)=>{if(row.xirr_pct!==null){if(row.xirr_pct!==previous)rank=i+1;previous=row.xirr_pct;}return {...row,rank:row.xirr_pct===null?null:rank};});
}
function uniqueStocks(holdings,watchlistStocks,universe,matchStock){
  const result=new Map();
  for(const item of [...holdings,...watchlistStocks]){
    const stock=matchStock(item,universe);
    const ticker=String(stock?.ticker||item.ticker||'').trim().toUpperCase();
    if(!ticker)continue;
    const stock_code=String(stock?.stock_code||item.stock_code||ticker).trim().toUpperCase();
    const candidate={name:stock?.name||item.stock_name||item.name||ticker,ticker,stock_code,yahoo_finance_code:stock?.yahoo_finance_code||item.yahoo_finance_code||stock_code,code:stock?.code||item.ok_code||item.code||''};
    if(!result.has(ticker))result.set(ticker,candidate);
  }
  return [...result.values()].sort((a,b)=>a.ticker.localeCompare(b.ticker));
}
module.exports={leaderboard,uniqueStocks};
