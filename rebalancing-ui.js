let rebalanceSources=[],rebalanceProposal=null,rebalanceLoadVersion=0;
async function loadRebalancing(){
 const target=document.getElementById('rebalance-table');target.textContent='Loading rebalancing options…';
 try{
  const j=await api('/api/rebalancing');if(!j.success)throw Error(j.error);rebalanceSources=j.data.sources;
  if(!rebalanceSources.length){target.innerHTML='<div class="no-trigger-box">No held stocks have an ATH more than 365 days ago.</div>';return;}
  target.innerHTML=`<div class="sheet-table-wrap" tabindex="0" role="region" aria-label="Rebalancing holdings"><table class="sheet-table"><thead><tr>${['Stock / CODE','ATH date','Days Since','ATH Drop %','Quantity','Invested amount','Current value','Action'].map(s=>`<th scope="col">${s}</th>`).join('')}</tr></thead><tbody>${rebalanceSources.map((s,i)=>`<tr><td>${escapeHtml(s.name)}<br><small>${escapeHtml(s.code)}</small></td><td>${escapeHtml(s.ath_date)}</td><td>${s.days_since}</td><td>${Number.isFinite(s.ath_drop_pct)?s.ath_drop_pct.toFixed(2)+'%':'—'}</td><td>${s.shares}</td><td>${fmtD(s.invested_amount)}</td><td>${s.price>0?fmtD(s.price*s.shares):'Unavailable'}</td><td><button type="button" class="preview-btn" onclick="openRebalance(${i})">Rebalance</button></td></tr>`).join('')}</tbody></table></div>`;
 }catch(e){target.textContent=e.message||'Unable to load rebalancing options.';}
}
async function openRebalance(index){
 const version=++rebalanceLoadVersion;
 const dialog=document.getElementById('rebalance-dialog'),body=document.getElementById('rebalance-body');
 rebalanceProposal=null;
 body.textContent='Loading SIP combinations…';dialog.showModal();
 try{
  const j=await api('/api/rebalancing?ticker='+encodeURIComponent(rebalanceSources[index].ticker));if(!j.success)throw Error(j.error);
  if(!dialog.open||version!==rebalanceLoadVersion)return;
  rebalanceProposal=j.data;
  if(!j.data.source)throw Error('This holding is no longer eligible. Refresh the list.');
  renderRebalanceChoices();
 }catch(e){body.textContent=e.message;}
}
function renderRebalanceChoices(){
 const {source,combinations}=rebalanceProposal;
 const budget=source.market_value??(source.price>0?source.price*source.shares:null);
 const available=rebalanceProposal.candidates||[...new Map(combinations.flatMap(p=>p.buys).map(b=>[b.ticker,b])).values()];
 rebalanceProposal.choices=available.filter(b=>budget>0&&Math.floor(Math.min(budget,b.suggested_amount??Infinity)/b.price)>0).sort((a,b)=>b.fall-a.fall||(a.days_since??Infinity)-(b.days_since??Infinity)||a.ticker.localeCompare(b.ticker));
 const groups=new Map();rebalanceProposal.choices.forEach((b,i)=>{if(!groups.has(b.fall))groups.set(b.fall,[]);groups.get(b.fall).push({...b,index:i});});
 document.getElementById('rebalance-body').innerHTML=`<p><b>${escapeHtml(source.name)}</b> · ${source.days_since} days since ATH</p><p>Estimated sell amount: <b>${budget>0?fmtD(budget):'Unavailable'}</b> (${source.shares} shares × ${source.price>0?fmtD(source.price):'missing Yahoo price'})</p><p class="rebalance-note">Use the current sale value to buy replacement stocks. Only stocks with fewer than 100 days since ATH are shown, ordered by the fewest days within each SIP level. The quantities and combinations below are for viewing only. Estimates include unused allocation through the current zone, subtract prior buys, and are capped by the sale value. Multi-stock estimates use the remaining allocation weights.</p>${source.quote_error?`<p role="status">${escapeHtml(source.quote_error)}</p>`:''}${[...groups].map(([fall,rows])=>`<section><h3>${fall}% SIP level</h3><div class="sheet-table-wrap" tabindex="0" role="region" aria-label="${fall}% replacement opportunities"><table class="sheet-table"><thead><tr><th scope="col">Stock / CODE</th><th scope="col" aria-sort="ascending">Days Since ATH</th><th scope="col">Drop %</th><th scope="col">Price</th><th scope="col">Suggested quantity</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${escapeHtml(b.name)}<br><small>${escapeHtml(b.code)}</small>${b.quote_error?`<br><small>${escapeHtml(b.quote_error)}</small>`:''}</td><td>${b.days_since??'—'}</td><td>${Number(b.drop_pct??b.fall).toFixed(2)}%</td><td>${fmtD(b.price)}</td><td>${Math.floor(Math.min(budget,b.suggested_amount??Infinity)/b.price)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}${groups.size?`<h3>Suggested multi-stock combinations</h3><div class="rebalance-options">${combinations.map((plan,i)=>plan.buys.length<2?'':`<article class="rebalance-option"><h3>${plan.buys.length} stocks · ${[...new Set(plan.buys.map(b=>b.fall+'%'))].join(' + ')}</h3>${plan.buys.map(b=>`<p><b>${escapeHtml(b.name)}</b> · ${b.days_since??'—'} days since ATH<br>${b.shares} × ${fmtD(b.price)} = ${fmtD(b.shares*b.price)}</p>`).join('')}<p>Total: ${fmtD(plan.total)} · Cash left: ${fmtD(plan.remaining)}</p></article>`).join('')}</div>`:`<p class="no-trigger-box">${budget>0?'No affordable opportunities with fewer than 100 days since ATH are currently in an active SIP level.':'A valid Yahoo market price is required to calculate the sale amount.'}</p>`}`;
}
document.getElementById('rebalance-dialog').addEventListener('close',()=>{rebalanceLoadVersion++;});
