let rebalanceSources=[],rebalanceProposal=null,rebalanceLoadVersion=0,rebalanceScope='portfolio';
async function loadRebalancing(){
 const target=document.getElementById('rebalance-table');target.textContent='Loading rebalancing options…';
 try{
  const j=await api('/api/rebalancing');if(!j.success)throw Error(j.error);rebalanceSources=j.data.sources;
  const targetGrowth=j.data.target_growth_pct??30,athAgeDays=j.data.ath_age_days??365;
  document.getElementById('rebalance-description').textContent=`Holdings whose ATH was more than ${athAgeDays} days ago and whose XIRR is below your ${targetGrowth}% annual target growth. Holdings without an available XIRR are excluded. Explore replacements using current market value, grouped by SIP level and ordered by fewest days since ATH.`;
  if(!rebalanceSources.length){target.innerHTML=`<div class="no-trigger-box">No holdings meet both conditions: ATH more than ${athAgeDays} days ago and XIRR below ${targetGrowth}%.</div>`;return;}
  target.innerHTML=`<div class="sheet-table-wrap" tabindex="0" role="region" aria-label="Rebalancing holdings"><table class="sheet-table"><thead><tr>${['Stock / CODE','ATH date','Days Since','ATH Drop %','XIRR %','Quantity','Invested amount','Current value','Action'].map(s=>`<th scope="col">${s}</th>`).join('')}</tr></thead><tbody>${rebalanceSources.map((s,i)=>`<tr><td>${escapeHtml(s.name)}<br><small>${escapeHtml(s.code)}</small></td><td>${escapeHtml(s.ath_date)}</td><td>${s.days_since}</td><td>${Number.isFinite(s.ath_drop_pct)?s.ath_drop_pct.toFixed(2)+'%':'—'}</td><td>${Number.isFinite(s.xirr_pct)?s.xirr_pct.toFixed(2)+'%':'—'}</td><td>${s.shares}</td><td>${fmtD(s.invested_amount)}</td><td>${s.price>0?fmtD(s.price*s.shares):'Unavailable'}</td><td><button type="button" class="preview-btn" onclick="openRebalance(${i})">Rebalance</button></td></tr>`).join('')}</tbody></table></div>`;
 }catch(e){target.textContent=e.message||'Unable to load rebalancing options.';}
}
async function openRebalance(index){
 const version=++rebalanceLoadVersion;
 const dialog=document.getElementById('rebalance-dialog'),body=document.getElementById('rebalance-body');
 rebalanceProposal=null;rebalanceScope='portfolio';
 body.textContent='Loading Opportunities Beta…';dialog.showModal();
 try{
  const j=await api('/api/rebalancing?ticker='+encodeURIComponent(rebalanceSources[index].ticker));if(!j.success)throw Error(j.error);
  if(!dialog.open||version!==rebalanceLoadVersion)return;
  rebalanceProposal=j.data;
  if(!j.data.source)throw Error('This holding is no longer eligible. Refresh the list.');
  renderRebalanceChoices();
 }catch(e){if(dialog.open&&version===rebalanceLoadVersion)body.textContent=e.message;}
}
function renderRebalanceChoices(){
 const {source}=rebalanceProposal;
 const budget=source.market_value??(source.price>0?source.price*source.shares:null);
 document.getElementById('rebalance-body').innerHTML=`<p><b>${escapeHtml(source.name)}</b> · ${source.days_since} days since ATH</p><p>Estimated sell amount: <b>${budget>0?fmtD(budget):'Unavailable'}</b> (${source.shares} shares × ${source.price>0?fmtD(source.price):'missing Yahoo price'})</p><p class="rebalance-note">Opportunities come from Opportunities Beta, including investment history, carry-forward and ATH cycles. Only stocks with fewer than 100 days since ATH are shown, ordered by the fewest days within each configured SIP level. Quantities and combinations are for viewing only. Quantities are capped by the sale proceeds and each Beta suggested investment. Multi-stock estimates split proceeds in proportion to Beta suggestions within the selected tab.</p>${source.quote_error?`<p role="status">${escapeHtml(source.quote_error)}</p>`:''}
 <div class="rebalance-tabs" role="tablist" aria-label="Rebalance opportunity source">
 <button type="button" role="tab" id="rebalance-tab-portfolio" aria-controls="rebalance-panel-portfolio" data-rebalance-scope="portfolio">Rebalance Inside portfolio</button>
 <button type="button" role="tab" id="rebalance-tab-new" aria-controls="rebalance-panel-new" data-rebalance-scope="new">Rebalance with new opportunities</button>
 </div>
 ${['portfolio','new'].map(scope=>`<div role="tabpanel" id="rebalance-panel-${scope}" aria-labelledby="rebalance-tab-${scope}" tabindex="0">${rebalanceScopeContent(scope,budget)}</div>`).join('')}`;
 const tabs=[...document.querySelectorAll('[data-rebalance-scope]')];
 tabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectRebalanceScope(tab.dataset.rebalanceScope));
  tab.addEventListener('keydown',event=>{
   const target={ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
   if(target===undefined)return;
   event.preventDefault();selectRebalanceScope(tabs[target].dataset.rebalanceScope);tabs[target].focus();
  });
 });
 selectRebalanceScope(rebalanceScope);
}
function selectRebalanceScope(scope){
 rebalanceScope=scope;
 for(const name of ['portfolio','new']){
  const selected=name===scope,tab=document.getElementById('rebalance-tab-'+name);
  tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;
  document.getElementById('rebalance-panel-'+name).hidden=!selected;
 }
}
function rebalanceScopeContent(scope,budget){
 const group=rebalanceProposal.opportunities?.[scope];
 if(!group)return '<p role="status">Reopen this popup to load the latest grouped opportunities.</p>';
 const choices=group.candidates.filter(b=>budget>0&&Math.floor(Math.min(budget,b.suggested_investment??budget)/b.price)>0).sort((a,b)=>b.fall-a.fall||(a.days_since??Infinity)-(b.days_since??Infinity)||a.ticker.localeCompare(b.ticker));
 const groups=new Map();choices.forEach(b=>{if(!groups.has(b.fall))groups.set(b.fall,[]);groups.get(b.fall).push(b);});
 const combinations=group.combinations.filter(plan=>plan.buys.length>=2);
 const description=scope==='portfolio'?'Stocks you currently hold, excluding the holding being rebalanced.':'Stocks you do not currently hold, from your available watchlist opportunities.';
 if(!groups.size)return `<p class="rebalance-note">${description}</p><p class="no-trigger-box">${budget>0?`No affordable ${scope==='portfolio'?'stocks inside your portfolio':'new opportunities'} with fewer than 100 days since ATH are currently have an actionable Opportunities Beta suggestion.`:'A valid Yahoo market price is required to calculate the sale amount.'}</p>`;
 return `<p class="rebalance-note">${description}</p>${[...groups].map(([fall,rows])=>`<section><h3>${fall}% SIP level</h3><div class="sheet-table-wrap" tabindex="0" role="region" aria-label="${fall}% ${scope==='portfolio'?'portfolio':'new'} replacement opportunities"><table class="sheet-table"><thead><tr><th scope="col">Stock / CODE</th><th scope="col" aria-sort="ascending">Days Since ATH</th><th scope="col">Drop %</th><th scope="col">Price</th><th scope="col">Beta suggested investment</th><th scope="col">Quantity within sale value</th></tr></thead><tbody>${rows.map(b=>`<tr><td>${escapeHtml(b.name)}<br><small>${escapeHtml(b.code)}</small>${b.quote_error?`<br><small>${escapeHtml(b.quote_error)}</small>`:''}</td><td>${b.days_since??'—'}</td><td>${Number(b.drop_pct??b.fall).toFixed(2)}%</td><td>${fmtD(b.price)}</td><td>${b.suggested_investment==null?'—':fmtD(b.suggested_investment)}</td><td>${Math.floor(Math.min(budget,b.suggested_investment??budget)/b.price)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}
 <h3>Suggested multi-stock combinations</h3>${combinations.length?`<div class="rebalance-options">${combinations.map(plan=>`<article class="rebalance-option"><h3>${plan.buys.length} stocks · ${[...new Set(plan.buys.map(b=>b.fall+'%'))].join(' + ')}</h3>${plan.buys.map(b=>`<p><b>${escapeHtml(b.name)}</b> · ${b.days_since??'—'} days since ATH<br>${b.shares} × ${fmtD(b.price)} = ${fmtD(b.shares*b.price)}</p>`).join('')}<p>Total: ${fmtD(plan.total)} · Cash left: ${fmtD(plan.remaining)}</p></article>`).join('')}</div>`:'<p class="rebalance-note">No affordable multi-stock combination is available in this tab.</p>'}`;
}

document.getElementById('rebalance-dialog').addEventListener('close',()=>{rebalanceLoadVersion++;});
