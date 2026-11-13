const money=value=>Math.round((value+Number.EPSILON)*100)/100;
const numeric=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
// Same chronological average-cost accounting as the portfolio rebuild.
function actualInvested(trades,fallback=0){
 if(!Array.isArray(trades))return null;
 if(!trades.length)return numeric(fallback)&&Number(fallback)>=0?money(Number(fallback)):null;
 const positions=new Map();
 for(const trade of trades){
  if(!['BUY','SELL'].includes(trade.type)||!numeric(trade.shares)||Number(trade.shares)<=0||!numeric(trade.price)||Number(trade.price)<0)return null;
  const key=trade.ticker||'',position=positions.get(key)||{shares:0,cost:0},quantity=Number(trade.shares);
  if(trade.type==='BUY'){position.cost+=quantity*Number(trade.price);position.shares+=quantity;}
  else if(position.shares-quantity<=0.0001){position.shares=0;position.cost=0;}
  else {position.cost*=(position.shares-quantity)/position.shares;position.shares-=quantity;}
  if(!Number.isFinite(position.cost))return null;
  positions.set(key,position);
 }
 return money([...positions.values()].reduce((sum,position)=>sum+position.cost,0));
}
function applyOpportunityBeta(levels,trades,budget,price,ath,fallback=0,cycle=null){
 const invested=actualInvested(trades,fallback),validBudget=numeric(budget)&&Number(budget)>=0;
 const maximum=validBudget?money(Number(budget)):0;
 const base=cycle?Number(cycle.base_invested):0;
 const cycleCap=Math.max(0,maximum-base);
 const cycleInvested=invested===null?null:money(invested-base);
 const validQuote=Number.isFinite(price)&&price>0&&Number.isFinite(ath)&&ath>0;
 let cumulative=0,rawCumulative=0,validLevels=validBudget;
 return levels.map(level=>{
  const previous=cumulative;
  const allocation=level.allocation!==undefined?(numeric(level.allocation)?cycleCap*Number(level.allocation)/100:NaN):(numeric(level.allocated_amount)?Number(level.allocated_amount)*(cycle&&maximum>0?cycleCap/maximum:1):NaN);
  validLevels=validLevels&&Number.isFinite(allocation)&&allocation>=0;
  rawCumulative+=allocation;
  cumulative=validLevels?money(Math.min(cycleCap,rawCumulative)):null;
  const known=validLevels&&invested!==null;
  const carry=known?money(Math.max(0,previous-cycleInvested)):null;
  const suggested=known?money(Math.max(0,Math.min(maximum-invested,cumulative-cycleInvested))):null;
  let quantity=validQuote&&suggested!==null?Math.floor(suggested/price):null;
  if(quantity!==null&&!Number.isSafeInteger(quantity))quantity=null;
  if(quantity!==null&&quantity*price>suggested)quantity=Math.max(0,quantity-1);
  return {...level,allocated_amount:validLevels?money(Math.max(0,cumulative-previous)):null,active:!!level.active&&validQuote,cumulative_allocation:cumulative,previous_cumulative_allocation:previous,
   cycle_base_investment:base,cycle_cap:money(cycleCap),cycle_invested:cycleInvested,
   total_exposure_target:cumulative===null?null:money(Math.min(maximum,base+cumulative)),
   carry_forward_amount:carry,total_invested:invested,
   spending_deduction:known?money(Math.min(cumulative-previous,Math.max(0,cycleInvested-previous))):null,
   over_budget:invested!==null&&validBudget?money(Math.max(0,invested-maximum)):null,
   suggested_investment:suggested,suggested_quantity:quantity,
   investment_error:invested===null?'Investment history unavailable or invalid.':!validLevels?'Allocation configuration is invalid.':null};
 });
}
module.exports={applyOpportunityBeta,actualInvested};
