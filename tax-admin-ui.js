'use strict';
async function loadTaxAdmin(){
 const response=await fetchJson('/api/admin/tax-settings');if(!response.success)throw Error(response.error);
 if(currentTable!=='Tax settings')return;
 const config=response.data;
 document.getElementById('table-title').textContent='Tax harvesting settings';
 document.getElementById('table-meta').textContent='FY '+config.financial_year+'–'+(config.financial_year+1)+' · Changes are recorded and apply to all taxpayers';
 const fields=[['ltcg_exemption','Annual LTCG exemption (₹)',0,100000000,.01],['ltcg_rate','LTCG rate (%)',0,100,.01],['stcg_rate','STCG rate (%)',0,100,.01],['holding_months','Long-term threshold (calendar months)',1,120,1],['max_quote_age_hours','Maximum quote age (hours)',1,720,1],['family_review_days','Family purchase review window (days)',0,365,1]];
 content.innerHTML=`<div class="tax-admin"><p>Defaults: ₹1,25,000 LTCG exemption, 12.5% LTCG, 20% STCG, and more than 12 months for long term. Rates exclude cess and surcharge. The family window is an operational review setting, not a statutory wash-sale rule.</p><form id="tax-admin-form"><div class="tax-grid">${fields.map(([key,label,min,max,step])=>`<label>${label}<input name="${key}" type="number" min="${min}" max="${max}" step="${step}" required value="${config.values[key]}"></label>`).join('')}</div><small>Updates apply only to this financial year. Each new year starts with the documented defaults until reviewed by an admin.</small><button type="submit" class="tax-primary">Save tax settings</button><p id="tax-admin-status" role="status"></p></form></div>`;
 setBanner('Tax settings loaded.',true);
 document.getElementById('tax-admin-form').onsubmit=async e=>{
   e.preventDefault();const button=e.submitter,status=document.getElementById('tax-admin-status');button.disabled=true;
   try{const values=Object.fromEntries([...new FormData(e.target)].map(([k,v])=>[k,Number(v)]));const result=await fetchJson('/api/admin/tax-settings',{method:'PUT',body:JSON.stringify({...config,values})});if(!result.success)throw Error(result.error);Object.assign(config,result.data);status.textContent='Saved. Recalculate harvesting to apply these settings.';}
   catch(error){status.textContent=error.message;}finally{button.disabled=false;}
 };
}
