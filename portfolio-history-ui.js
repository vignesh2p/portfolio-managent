function portfolioDayChange(holdings,prices){
 let value=0,previous=0;
 for(const h of holdings.filter(h=>Number(h.shares)>0)){
  const q=prices[h.ticker];
  if(!q||!Number.isFinite(q.price)||q.price<=0)return null;
  const prev=Number.isFinite(q.prevClose)?q.prevClose:Number.isFinite(q.change)?q.price-q.change:null;
  if(prev===null||prev<=0)return null;
  value+=q.price*Number(h.shares);previous+=prev*Number(h.shares);
 }
 return {amount:value-previous,pct:previous>0?(value-previous)/previous*100:0};
}
function renderPortfolioDayChange(target,holdings,prices,loaded){
 const span=document.createElement('span');span.className='portfolio-day-change';
 const change=loaded?portfolioDayChange(holdings,prices):null;
 if(!loaded)span.textContent='(day change loading…)';
 else if(!change)span.textContent='(day change unavailable)';
 else {
  const direction=change.amount>0?'up':change.amount<0?'down':'flat';
  span.classList.add(direction);
  span.textContent=`(${direction==='up'?'↑ ':direction==='down'?'↓ ':''}${change.amount>0?'+':''}${fmtD(change.amount)} / ${change.pct>0?'+':''}${change.pct.toFixed(2)}%)`;
  span.title='Day change against previous market close, using current holdings and saved prices';
 }
 target.appendChild(span);
}
let portfolioHistoryRows=[],portfolioHistoryRequest=0;
async function loadPortfolioHistory(){
 const request=++portfolioHistoryRequest,target=document.getElementById('portfolio-history-content');
 target.textContent='Loading daily history…';
 try{
  const result=await api('/api/portfolio-history');
  if(request!==portfolioHistoryRequest)return;
  if(!result.success)throw new Error(result.error||'Unable to load portfolio history.');
  portfolioHistoryRows=result.data;renderPortfolioHistory();
 }catch(error){if(request===portfolioHistoryRequest){target.replaceChildren();const p=document.createElement('p');p.className='error-box';p.setAttribute('role','alert');p.textContent=error.message;target.appendChild(p);}}
}
function historyChart(rows){
 const series=[{key:'portfolio_value',label:'Portfolio value',color:'#00ffb4',dash:'',symbol:'━'},{key:'cost_value',label:'Cost value',color:'#fbbf24',dash:'3 4',symbol:'┈'},{key:'profit_value',label:'Profit value',color:'#7dd3fc',dash:'7 4',symbol:'┄'}];
 const values=rows.flatMap(r=>series.map(s=>r[s.key])).filter(Number.isFinite);
 if(!values.length)return '<section class="history-chart"><h3>Portfolio value, cost & profit</h3><p>No complete valuations for this period.</p></section>';
 const low=Math.min(0,...values),high=Math.max(0,...values),spread=high-low||1,top=high+spread*.08,bottom=low-spread*.08;
 const start=Date.parse(rows[0].snapshot_date),end=Date.parse(rows[rows.length-1].snapshot_date);
 const x=row=>end===start?405:80+(Date.parse(row.snapshot_date)-start)/(end-start)*650;
 const y=value=>240-(value-bottom)/(top-bottom)*210;
 const layers=series.map(({key,label,color,dash})=>{
  const segments=[];let points=[];const dots=[];
  for(const row of rows){
   if(!Number.isFinite(row[key])){if(points.length)segments.push(points);points=[];continue;}
   const px=x(row),py=y(row[key]);points.push([px,py]);
   dots.push(`<circle cx="${px}" cy="${py}" r="3" fill="${color}"><title>${escapeHtml(row.snapshot_date+' · '+label+': '+fmtD(row[key]))}</title></circle>`);
  }
  if(points.length)segments.push(points);
  return segments.map(segment=>{
   const line=segment.map(([px,py],i)=>(i?'L':'M')+px+','+py).join(' ');
   const area=line+' L'+segment[segment.length-1][0]+','+y(0)+' L'+segment[0][0]+','+y(0)+' Z';
   return `<path class="history-area" d="${area}" fill="${color}" fill-opacity=".18"/><path d="${line}" fill="none" stroke="${color}" stroke-width="3" ${dash?`stroke-dasharray="${dash}"`:''}/>`;
  }).join('')+dots.join('');
 }).join('');
 const grid=Array.from({length:4},(_,i)=>{const value=bottom+(top-bottom)*i/3,py=y(value);return `<line x1="80" x2="730" y1="${py}" y2="${py}" stroke="currentColor" opacity=".15"/><text x="70" y="${py+4}" text-anchor="end">${escapeHtml(new Intl.NumberFormat('en-IN',{notation:'compact',maximumFractionDigits:1}).format(value))}</text>`;}).join('');
 const latest=rows[rows.length-1];
 const legend=series.map(({key,label,color,symbol})=>`<span style="color:${color}">${symbol} ${label}: <strong>${Number.isFinite(latest[key])?fmtD(latest[key]):'Unavailable'}</strong></span>`).join('');
 return `<section class="history-chart"><h3>Portfolio value, cost & profit</h3><div class="history-legend">${legend}</div><svg viewBox="0 0 760 285" role="img" aria-label="Portfolio value, cost value and unrealized profit area chart in rupees, on the same scale. Exact values in the daily table below.">${grid}<line x1="80" x2="730" y1="${y(0)}" y2="${y(0)}" stroke="currentColor" opacity=".5"/>${layers}<text x="80" y="275">${escapeHtml(rows[0].snapshot_date)}</text><text x="730" y="275" text-anchor="end">${escapeHtml(latest.snapshot_date)}</text></svg></section>`;
}
function historyDailyProfit(row){
 if(!Number.isFinite(row.day_change))return `<span>Unavailable</span><br><small>${escapeHtml(row.day_change_reason||'Previous-close prices were not saved')}</small>`;
 const sign=row.day_change>0?'+':'',direction=row.day_change>0?'up':row.day_change<0?'down':'flat';
 return `<span class="history-pnl ${direction}">${sign}${fmtD(row.day_change)}${Number.isFinite(row.day_change_pct)?' / '+(row.day_change_pct>0?'+':'')+row.day_change_pct.toFixed(2)+'%':''}</span>${row.day_change_source==='saved_snapshots'?'<br><small>From daily snapshots</small>':''}`;
}
function renderPortfolioHistory(){
 const target=document.getElementById('portfolio-history-content');
 const days=Number(document.getElementById('portfolio-history-range').value);
 const cutoff=days?Date.now()-days*86400000:-Infinity;
 const rows=portfolioHistoryRows.filter(r=>Date.parse(r.snapshot_date+'T16:00:00+05:30')>=cutoff);
 if(!rows.length){target.innerHTML='<div class="no-trigger-box">No saved snapshots for this period. Daily history begins with the first scheduled snapshot at 4:00 pm IST.</div>';return;}
 const money=value=>Number.isFinite(value)?fmtD(value):'Unavailable';
 target.innerHTML=`<div class="history-charts">${historyChart(rows)}</div>
 <p class="page-sub">Profit is market value minus the cost of current holdings; it excludes realised gains. Missing prices create gaps. Older prices are marked below. Purchases and sales can change these values. Daily profit/loss measures the snapshot holdings against the previous market close; it excludes realised gains and intraday trade timing. Older daily changes use consecutive saved valuations only when no intervening trades or holding-cost/count changes are recorded; these are labelled From daily snapshots. Otherwise the reason is shown.</p>
 <details class="history-details" open><summary>Daily profit/loss & values (${rows.length} snapshots)</summary><div class="history-table-wrap" tabindex="0" role="region" aria-label="Daily portfolio values"><table><caption>Saved daily portfolio valuations in INR</caption><thead><tr><th scope="col">Date (IST)</th><th scope="col">Portfolio value</th><th scope="col">Cost value</th><th scope="col">Profit value</th><th scope="col">Daily profit/loss (₹ / %)</th><th scope="col">Prices</th></tr></thead><tbody>${[...rows].reverse().map(row=>`<tr><th scope="row">${escapeHtml(row.snapshot_date)}</th><td>${money(row.portfolio_value)}</td><td>${money(row.cost_value)}</td><td>${money(row.profit_value)}</td><td>${historyDailyProfit(row)}</td><td>${row.missing_prices?`${Number(row.missing_prices)} missing`:row.stale_prices?`${Number(row.stale_prices)} older prices`:'Complete'}</td></tr>`).join('')}</tbody></table></div></details>`;
}
