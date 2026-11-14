'use strict';

const DEFAULTS = Object.freeze({ltcg_exemption:125000,ltcg_rate:12.5,stcg_rate:20,holding_months:12,max_quote_age_hours:96,family_review_days:30});
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
function validateSettings(input) {
  const out={};
  for(const [key,min,max,integer] of [['ltcg_exemption',0,1e8],['ltcg_rate',0,100],['stcg_rate',0,100],['holding_months',1,120,true],['max_quote_age_hours',1,720,true],['family_review_days',0,365,true]]) {
    const n=input[key];
    if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw Object.assign(Error('Invalid '+key),{status:400});
    out[key]=n;
  }
  return out;
}
function indiaDate(date=new Date()) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
function dateOnly(value) {
  if(typeof value!=='string')throw Error('Missing trade date');
  const date=value.slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Invalid trade date');
  // Stored UTC timestamps are converted to the Indian trading date.
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value)?indiaDate(new Date(value)):date;
}
function financialYear(today=indiaDate()) { const year=Number(today.slice(0,4))-(today.slice(5,7)<'04'?1:0);return {year,start:year+'-04-01',end:(year+1)+'-03-31',label:year+'–'+String(year+1).slice(2)}; }
function longTermFrom(date,months) {
  const d=new Date(date+'T00:00:00Z'),day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
  const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last)+1);
  return d.toISOString().slice(0,10);
}
function bucket(state,amount,long) {state[long?(amount>=0?'ltcg':'ltcl'):(amount>=0?'stcg':'stcl')]+=Math.abs(amount);}
function groupRecommendations(recommendations) {
  const groups=[];
  for(const action of recommendations) {
    // Merge only adjacent actions so the original FIFO execution order is retained.
    const previous=groups[groups.length-1];
    if(previous && previous.ticker===action.ticker && previous.category===action.category) {
      previous.quantity+=action.quantity;
      for(const key of ['estimated_proceeds','estimated_pnl','estimated_tax_saving','exemption_used'])previous[key]=round(previous[key]+action[key]);
      previous.buy_date_end=action.buy_date;
      previous.lot_count++;
    }else groups.push({...action,sequence:groups.length+1,buy_date_end:action.buy_date,lot_count:1});
  }
  return groups;
}
function tax(state,settings=DEFAULTS) {
  const st=Math.max(0,state.stcg-state.stcl),remainingSTCL=Math.max(0,state.stcl-state.stcg);
  const lt=Math.max(0,state.ltcg-state.ltcl-remainingSTCL);
  return {tax:round(st*settings.stcg_rate/100+Math.max(0,lt-settings.ltcg_exemption)*settings.ltcg_rate/100),taxable_stcg:round(st),taxable_ltcg:round(Math.max(0,lt-settings.ltcg_exemption)),net_ltcg:round(lt),exemption_remaining:round(Math.max(0,settings.ltcg_exemption-lt)),unused_stcl:round(Math.max(0,remainingSTCL-Math.max(0,state.ltcg-state.ltcl))),unused_ltcl:round(Math.max(0,state.ltcl-state.ltcg))};
}
function analyzeAccount({user,holdings,trades,settings=DEFAULTS,now=new Date()}) {
  const today=indiaDate(now),fy=financialYear(today),issues=[],queues=new Map(),realized={ltcg:0,ltcl:0,stcg:0,stcl:0},realizations=[];
  let complete=true;
  const ordered=[];
  for(const trade of trades) {
    try {
      const date=dateOnly(trade.traded_at),quantity=Number(trade.shares),price=Number(trade.price);
      if(!trade.ticker||!['BUY','SELL'].includes(trade.type)||trade.price==null||typeof trade.price==='boolean'||String(trade.price).trim()===''||!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(price)||price<0||(trade.type==='SELL'&&price===0))throw Error('Invalid trade values');
      if(date>today)throw Error('Future-dated trade');
      ordered.push({...trade,date,quantity,price});
    }catch(e){complete=false;issues.push('Trade '+trade.id+': '+e.message);}
  }
  ordered.sort((a,b)=>a.date.localeCompare(b.date)||String(a.traded_at).localeCompare(String(b.traded_at))||Number(a.id)-Number(b.id));
  for(const trade of ordered) {
    const key=trade.ticker; if(!queues.has(key))queues.set(key,[]);const lots=queues.get(key);
    if(trade.type==='BUY'){lots.push({quantity:trade.quantity,price:trade.price,date:trade.date,trade_id:trade.id});continue;}
    let left=trade.quantity;
    while(left>1e-8&&lots.length) {
      const lot=lots[0],quantity=Math.min(left,lot.quantity),pnl=quantity*(trade.price-lot.price),long=trade.date>=longTermFrom(lot.date,settings.holding_months);
      if(trade.date>=fy.start){
        if(lot.date<'2018-02-01'){complete=false;issues.push(key+': realized sale has a pre-February 2018 acquisition; grandfathered cost review required.');}
        bucket(realized,pnl,long);realizations.push({ticker:key,stock_name:trade.stock_name||'',quantity,buy_date:lot.date,sell_date:trade.date,pnl:round(pnl),term:long?'LT':'ST'});
      }
      lot.quantity-=quantity;left-=quantity;if(lot.quantity<1e-8)lots.shift();
    }
    if(left>1e-8){complete=false;issues.push(key+': sell exceeds known FIFO purchases by '+left+' shares. Add missing acquisition trades.');}
  }
  const positions=[];
  const held=new Map(holdings.filter(h=>Number(h.shares)>0).map(h=>[h.ticker,h]));
  for(const ticker of new Set([...queues.keys(),...held.keys()])) {
    const lots=queues.get(ticker)||[],h=held.get(ticker),quantity=lots.reduce((s,l)=>s+l.quantity,0),expected=Number(h?.shares||0);
    if(Math.abs(quantity-expected)>1e-6){complete=false;issues.push(ticker+': holdings and FIFO trades do not reconcile ('+expected+' held / '+quantity+' traced).');}
    if(!expected)continue;
    const price=Number(h.current_price),stamp=Date.parse(h.price_as_of||h.quote_fetched_at||''),fresh=Number.isFinite(stamp)&&+now-stamp>=-300000&&+now-stamp<=settings.max_quote_age_hours*3600000;
    let reason='';
    if(!Number.isFinite(price)||price<=0)reason='Current price unavailable';else if(!fresh)reason='Price is stale or has no timestamp';
    if(lots.some(l=>l.date<'2018-02-01')){complete=false;issues.push(ticker+': pre-February 2018 acquisition needs grandfathered cost review.');}
    if(!Number.isInteger(expected)||lots.some(l=>!Number.isInteger(l.quantity))){reason='Fractional quantity needs corporate-action review';}
    if(reason)issues.push(ticker+': '+reason+'.');
    const cost=lots.reduce((s,l)=>s+l.quantity*l.price,0);
    positions.push({ticker,stock_name:h.stock_name||h.name||'',identity:h.identity||ticker,quantity:expected,average_buy_price:quantity?round(cost/quantity):null,current_price:Number.isFinite(price)&&price>0?price:null,price_as_of:h.price_as_of||h.quote_fetched_at||null,unrealized_pnl:quantity===expected&&price>0?round(expected*price-cost):null,blocked:reason,lots:lots.map(l=>({...l,term:today>=longTermFrom(l.date,settings.holding_months)?'LT':'ST',long_term_from:longTermFrom(l.date,settings.holding_months),unrealized_pnl:price>0?round(l.quantity*(price-l.price)):null}))});
  }
  const before=tax(realized,settings),projected={...realized},recommendations=[];
  const work=positions.map(p=>({...p,lots:p.lots.map(l=>({...l}))}));
  // Never cherry-pick a later tax lot: each sale consumes an available FIFO prefix.
  if(complete)for(const category of ['LTCL Loss Harvest','STCL Loss Harvest','LTCG Gain Harvest']) {
    for(const position of work.sort((a,b)=>a.ticker.localeCompare(b.ticker))) {
      if(position.blocked)continue;
      while(position.lots.length) {
        const lot=position.lots[0],unit=position.current_price-lot.price,long=lot.term==='LT';
        const kind=unit<0?(long?'LTCL Loss Harvest':'STCL Loss Harvest'):(long&&unit>0?'LTCG Gain Harvest':'');
        if(kind!==category)break;
        const current=tax(projected,settings);
        const target=unit>0?current.exemption_remaining:long?current.taxable_ltcg:current.taxable_stcg+current.taxable_ltcg;
        // Whole shares only, with no loss sale beyond the currently useful tax offset.
        const quantity=Math.min(lot.quantity,Math.floor((target+1e-8)/Math.abs(unit)));
        if(quantity<1)break;
        const pnl=quantity*unit,candidate={...projected};bucket(candidate,pnl,long);const after=tax(candidate,settings);
        if(unit<0&&after.tax>=current.tax)break;
        Object.assign(projected,candidate);
        recommendations.push({sequence:recommendations.length+1,ticker:position.ticker,stock_name:position.stock_name,identity:position.identity,category,quantity,buy_date:lot.date,price:position.current_price,estimated_proceeds:round(quantity*position.current_price),estimated_pnl:round(pnl),estimated_tax_saving:round(current.tax-after.tax),exemption_used:unit>0?round(pnl):0,when:'Review now; execute on an exchange trading day by '+fy.end,buy_guidance:unit>0?'If retaining exposure, consider repurchasing '+position.ticker+' only after delivery sale settlement; reassess price and costs.':'Reinvest only if consistent with your allocation; consider a diversified equity fund after reviewing suitability and family overlap.',family_flags:[]});
        lot.quantity-=quantity;if(lot.quantity<1e-8)position.lots.shift();else break;
      }
    }
  }
  return {user_id:user.id,name:user.name||user.email,financial_year:fy,complete,issues:[...new Set(issues)],realized:Object.fromEntries(Object.entries(realized).map(([k,v])=>[k,round(v)])),realizations,positions,before:complete?before:null,after:complete?tax(projected,settings):null,recommendations:groupRecommendations(recommendations),unrealized_pnl:positions.every(p=>p.unrealized_pnl!==null)?round(positions.reduce((s,p)=>s+p.unrealized_pnl,0)):null};
}
function familyReview(accounts,tradesByUser,settings,today=indiaDate()) {
  const since=new Date(Date.parse(today)-settings.family_review_days*86400000).toISOString().slice(0,10);
  for(const account of accounts)for(const action of account.recommendations)for(const other of accounts) {
    if(other.user_id===account.user_id)continue;
    if(other.positions.some(p=>p.identity===action.identity))action.family_flags.push(other.name+' holds this security');
    if((tradesByUser.get(other.user_id)||[]).some(t=>{try{return t.type==='BUY'&&(t.identity||t.ticker)===action.identity&&dateOnly(t.traded_at)>=since&&dateOnly(t.traded_at)<=today;}catch{return false;}}))action.family_flags.push(other.name+' bought within the '+settings.family_review_days+'-day review window');
    if(!other.complete)action.family_flags.push(other.name+': incomplete records; family review is partial');
  }
  return accounts;
}
module.exports={DEFAULTS,validateSettings,indiaDate,financialYear,longTermFrom,tax,analyzeAccount,familyReview};
