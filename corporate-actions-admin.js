'use strict';
async function loadCorporateActionsAdmin(){
 const result=await fetchJson('/api/admin/corporate-actions');if(!result.success)throw Error(result.error);
 if(currentTable!=='Corporate actions')return;
 document.getElementById('table-title').textContent='Corporate actions';
 document.getElementById('table-meta').textContent='Verified actions notify eligible portfolio holders';
 content.innerHTML=`<div class="ca-screen ca-admin"><p>Use the stock’s Yahoo Finance code. Actions after the saved rollout date notify eligible users until they apply or ignore them. Earlier actions are read history. Entries are immutable once a user handles them.</p>
 <form id="ca-admin-form" method="post"><label>Yahoo Finance code (required)<input name="ticker" required maxlength="40" placeholder="RELIANCE.NS" spellcheck="false" autocapitalize="characters"></label>
 <label>Action type<select name="kind" data-autocomplete-ready="true"><option value="split">Split</option><option value="reverse_split">Reverse split</option><option value="bonus">Bonus</option><option value="demerger">Demerger</option></select></label>
 <label>Ex-date (required)<input name="ex_date" type="date" required></label>
 <p id="ca-ratio-help">Split / reverse split: new shares : old shares. Bonus: additional shares : held shares. Example: 1:1 bonus doubles the holding. Demergers require users to enter the new security and cost allocation manually.</p>
 <label>Ratio numerator (required)<input name="numerator" type="number" min="1" max="1000000" step="1" required aria-describedby="ca-ratio-help"></label>
 <label>Ratio denominator (required)<input name="denominator" type="number" min="1" max="1000000" step="1" required aria-describedby="ca-ratio-help"></label>
 <label>Announcement details / source reference<textarea name="description" maxlength="2000" rows="3"></textarea></label><button type="submit">Save corporate action</button><p id="ca-admin-status" role="status"></p></form>
 <h3>Saved actions</h3><div class="ca-scroll"><table><thead><tr><th>Stock</th><th>Type</th><th>Ex-date</th><th>Ratio</th><th>Source</th></tr></thead><tbody>${result.data.map(a=>`<tr><td>${escapeHtml(a.ticker)}</td><td>${escapeHtml(a.kind)}</td><td>${escapeHtml(a.ex_date)}</td><td>${a.numerator}:${a.denominator}</td><td>${escapeHtml(a.source)}</td></tr>`).join('')}</tbody></table></div></div>`;
 setBanner('Corporate actions loaded.',true);
 document.getElementById('ca-admin-form').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter,status=document.getElementById('ca-admin-status');button.disabled=true;
  try{const data=Object.fromEntries(new FormData(event.target));const saved=await fetchJson('/api/admin/corporate-actions',{method:'POST',body:JSON.stringify(data)});if(!saved.success)throw Error(saved.error);await loadCorporateActionsAdmin();document.getElementById('ca-admin-status').textContent='Saved. Eligible users will see this on their next notification refresh.';}
  catch(e){status.textContent=e.message;}finally{button.disabled=false;}
 };
}
