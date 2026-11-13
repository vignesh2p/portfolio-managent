'use strict';
(() => {
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const label={split:'Split',reverse_split:'Reverse split',bonus:'Bonus',demerger:'Demerger'};
 const number=n=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:6});
 let current=null,busy=false;
 function badge(data){const node=document.getElementById('corporate-actions-count');if(node){node.textContent=data.pending||'';node.hidden=!data.pending;node.setAttribute('aria-label',data.pending+' corporate actions need attention');}}
 window.refreshCorporateActionCount=async function(sync=false){
  if(typeof TOKEN==='undefined'||!TOKEN)return;
  const token=TOKEN;
  try{const r=await api('/api/corporate-actions'+(sync?'/sync':''),sync?{method:'POST'}:{});if(TOKEN===token&&r.success)badge(r.data);}catch{/* Next poll retries without interrupting portfolio use. */}
 };
 function render(data,warnings=[]){
  current=data;badge(data);
  const root=document.getElementById('corporate-actions-root');
  root.innerHTML=`<div class="ca-head"><div><h2>Corporate Actions</h2><p>${data.pending} awaiting your decision</p></div><button type="button" id="ca-refresh">Refresh actions</button></div>
   <p>History starts at each stock’s oldest buy date. Actions on or before ${esc(data.baseline)} are marked read, assuming you already entered them. Opening this page does not dismiss notifications.</p>
   <p class="ca-notice">Yahoo supplies reported split history; bonus and demerger coverage requires verified admin entries. Future announcements appear when an admin adds them. Verify provider-reported types against the company announcement.</p>
   ${warnings.map(w=>`<p role="status" class="ca-notice">${esc(w)}</p>`).join('')}
   <label for="ca-filter">Show</label> <select id="ca-filter" data-autocomplete-ready="true"><option value="all">All actions</option><option value="pending">Needs attention</option><option value="read">Read history</option><option value="applied">Applied</option><option value="ignored">Ignored</option></select>
   <p id="ca-status" role="status"></p><div id="ca-list"></div><div id="ca-preview"></div>`;
  root.querySelector('#ca-refresh').onclick=()=>loadCorporateActions(true);
  root.querySelector('#ca-filter').onchange=drawRows;drawRows();
 }
 function drawRows(){
  const filter=document.getElementById('ca-filter').value,rows=current.actions.filter(a=>filter==='all'||a.status===filter);
  document.getElementById('ca-list').innerHTML=rows.length?`<div class="ca-scroll"><table><caption class="ca-caption">Actions for your current portfolio stocks</caption><thead><tr><th>Stock</th><th>Action</th><th>Ex-date</th><th>Ratio</th><th>Status</th><th>Review</th></tr></thead><tbody>${rows.map((a,i)=>`<tr><td>${esc(a.holding_ticker)}<small>From ${esc(a.from_date)}</small></td><td>${esc(label[a.kind])}<small>${esc(a.source)}</small></td><td>${esc(a.ex_date)}</td><td>${a.numerator}:${a.denominator}<small>${a.kind==='bonus'?'Additional : held':'New : old'}</small></td><td>${esc(a.status==='read'?'Read · previously handled':a.status)}</td><td><button type="button" data-index="${i}">${a.status==='pending'?'Review action':'View details'}</button></td></tr>`).join('')}</tbody></table></div>`:'<p>No actions in this view. Missing provider coverage does not mean no corporate actions occurred.</p>';
  document.querySelectorAll('#ca-list tbody tr').forEach(row=>[...row.cells].forEach((cell,i)=>cell.dataset.label=['Stock','Action','Ex-date','Ratio','Status','Review'][i]));
  document.querySelectorAll('#ca-list [data-index]').forEach(b=>b.onclick=()=>showPreview(rows[Number(b.dataset.index)]));
 }
 function showPreview(a){
  const target=document.getElementById('ca-preview'),p=a.plan;
  target.innerHTML=`<section class="ca-review" tabindex="-1" aria-label="Review corporate action"><h3>${esc(a.holding_ticker)} · ${esc(label[a.kind])}</h3>
   <p>Ex-date: <strong>${esc(a.ex_date)}</strong> · Ratio: <strong>${a.numerator}:${a.denominator}</strong></p><p>${esc(a.description)}</p>
   ${a.status==='pending'?`<p>Shares held before ex-date: <strong>${number(p.eligible_shares)}</strong>. Trades on the ex-date are excluded.</p>
   ${a.kind!=='demerger'?`<p>Quantity change: <strong>${number(p.additional_shares)}</strong> · Holding after apply: <strong>${number(p.resulting_shares)}</strong></p><p>${a.kind==='bonus'?'A new BUY trade will be added at price 0 with a Bonus comment. Total invested cost stays unchanged.':'Pre-ex-date BUY and SELL quantities are multiplied by the ratio and their prices divided by it. Original cash amounts and later trades stay unchanged. A Split comment is added.'}</p>`:''}
   ${p.blocked?`<p class="ca-notice">${esc(p.blocked)}</p>`:''}
   <form id="ca-confirm"><label><input type="checkbox" name="verified" required> I checked the action type and ratio against the announcement and have not already entered it.</label><div class="ca-buttons"><button type="submit" ${p.blocked?'disabled':''}>Apply to holding</button><button type="button" id="ca-ignore">Ignore action</button>${a.ex_date<=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())?'<button type="button" id="ca-handled">Already entered manually</button>':''}</div></form>`:'<p>This action is '+esc(a.status)+'. No changes will be made to your holdings.</p>'}
   <p id="ca-decision-status" role="status"></p></section>`;
  target.firstElementChild.focus();
  if(a.status!=='pending')return;
  target.querySelector('form').onsubmit=e=>{e.preventDefault();decide(a,'apply');};
  target.querySelector('#ca-ignore').onclick=()=>{if(confirm('Ignore this action? Your holdings will not change and its notification will be cleared.'))decide(a,'ignore');};
  target.querySelector('#ca-handled')?.addEventListener('click',()=>{if(confirm('Confirm you already entered all required trades and cost-basis changes. This only marks the action handled; it does not modify trades.'))decide(a,'handled');});
 }
 async function decide(a,decision){
  if(busy)return;busy=true;
  const buttons=[...document.querySelectorAll('#ca-preview button')];buttons.forEach(b=>b.disabled=true);
  try{
   const result=await api('/api/corporate-actions/'+a.id+'/decision',{method:'POST',body:JSON.stringify({decision,holding_ticker:a.holding_ticker,fingerprint:a.plan.fingerprint,verified:true})});
   if(!result.success)throw Error(result.error);
   await loadCorporateActions(false);document.getElementById('ca-status').textContent=decision==='ignore'?'Action ignored.':decision==='handled'?'Marked as manually handled.':'Action applied. Your holdings and trades have been updated.';
   if(typeof loadPortfolio==='function')loadPortfolio();
  }catch(e){document.getElementById('ca-decision-status').textContent=e.message;buttons.forEach(b=>b.disabled=false);}
  finally{busy=false;}
 }
 window.loadCorporateActions=async function(sync=true){
  const root=document.getElementById('corporate-actions-root');if(!root)return;
  root.setAttribute('aria-busy','true');
  try{const r=await api('/api/corporate-actions'+(sync?'/sync':''),sync?{method:'POST'}:{});if(!r.success)throw Error(r.error);render(r.data,r.warnings);}
  catch(e){root.innerHTML=`<h2>Corporate Actions</h2><p role="alert">${esc(e.message)}</p><button type="button" id="ca-retry">Retry</button>`;root.querySelector('button').onclick=()=>loadCorporateActions(sync);}
  finally{root.removeAttribute('aria-busy');}
 };
 setInterval(()=>{if(!busy&&typeof TOKEN!=='undefined'&&TOKEN)refreshCorporateActionCount();},60000);
 setInterval(()=>{if(!busy&&typeof TOKEN!=='undefined'&&TOKEN)refreshCorporateActionCount(true);},30*60000);
 window.addEventListener('DOMContentLoaded',()=>refreshCorporateActionCount(true));
 window.addEventListener('focus',()=>refreshCorporateActionCount());
})();
