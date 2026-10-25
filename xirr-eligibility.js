(function(root){
 function xirrEligible(trades,portfolio=false,now=new Date()){
  const day=value=>{const d=new Date(value);return Number.isFinite(+d)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(d):null;};
  const today=day(now);if(!today||!trades?.length)return false;
  let start=null,shares=0;
  const ordered=[...trades].sort((a,b)=>new Date(a.traded_at)-new Date(b.traded_at)||Number(a.id||0)-Number(b.id||0));
  for(const t of ordered){
   const date=day(t.traded_at);if(!date||date>today)return false;
   if(portfolio){if(t.type==='BUY'&&!start)start=date;continue;}
   const qty=Number(t.shares);if(!Number.isFinite(qty)||qty<=0)return false;
   if(t.type==='BUY'){if(shares<=0.0001)start=date;shares+=qty;}
   else if(t.type==='SELL'){shares-=qty;if(shares<=0.0001){shares=0;start=null;}}
  }
  if(!start||(!portfolio&&shares<=0.0001))return false;
  const [year,month,date]=start.split('-').map(Number),next=year+1;
  const lastDay=new Date(Date.UTC(next,month,0)).getUTCDate();
  const anniversary=String(next)+'-'+String(month).padStart(2,'0')+'-'+String(Math.min(date,lastDay)).padStart(2,'0');
  return today>anniversary;
 }
 if(typeof module==='object'&&module.exports)module.exports={xirrEligible};else root.xirrEligible=xirrEligible;
})(typeof globalThis!=='undefined'?globalThis:this);
