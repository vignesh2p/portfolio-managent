let databaseUsageData=null,databaseUsageVersion=0;
function usageBytes(value){
 if(!Number.isFinite(value))return 'Unavailable';
 const units=['B','KB','MB','GB','TB'];let index=0;
 while(value>=1000&&index<units.length-1){value/=1000;index++;}
 return value.toLocaleString('en-IN',{maximumFractionDigits:2})+' '+units[index];
}
function usageCount(value){return Number.isFinite(value)?value.toLocaleString('en-IN'):'Unavailable';}
function usageTable(title,headers,rows){return `<div class="usage-table" tabindex="0" role="region" aria-label="${escapeHtml(title)}"><table><caption>${escapeHtml(title)}</caption><thead><tr>${headers.map(h=>`<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;}
function usageMetric(label,value,limit,format){
 const percent=Number.isFinite(value)?value/limit*100:null;
 return `<section class="panel"><h3>${escapeHtml(label)}</h3><strong>${format(value)}</strong><p class="subtle">Free allowance: ${format(limit)}</p>${percent===null?'<p class="subtle">Usage not connected</p>':`<meter min="0" max="${limit}" value="${Math.min(value,limit)}" aria-label="${escapeHtml(label)} versus free allowance"></meter><p>${percent.toFixed(2)}% of free allowance · ${format(Math.max(0,limit-value))} before this database alone reaches the limit</p>`}</section>`;
}
async function loadDatabaseUsage(){
 const version=++databaseUsageVersion;
 document.getElementById('table-title').textContent='Database usage';
 document.getElementById('table-meta').textContent='Storage, free-plan reference and user data';
 const result=await fetchJson('/api/admin/database-usage');
 if(version!==databaseUsageVersion||currentTable!=='Database usage')return;
 if(!result.success)throw Error(result.error||'Unable to load database usage');
 const d=databaseUsageData=result.data,p=d.provider,limits=d.free_plan.limits;
 const storage=p.status==='available'&&Number.isFinite(p.storage_bytes)?p.storage_bytes:d.storage_bytes;
 content.innerHTML=`<p class="subtle">Measured ${escapeHtml(new Date(d.as_of).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}))} IST. Reports are cached for 5 minutes to reduce database reads.</p>
 <div class="usage-cards">${usageMetric('Database storage',storage,limits.storage_bytes,usageBytes)}${usageMetric('Rows read this month',p.rows_read,limits.rows_read,usageCount)}${usageMetric('Rows written this month',p.rows_written,limits.rows_written,usageCount)}${usageMetric('Sync traffic this month',p.bytes_synced,limits.bytes_synced,usageBytes)}</div>
 <p class="subtle">Storage source: ${p.status==='available'&&Number.isFinite(p.storage_bytes)?'Turso usage API, including database instances':'database page allocation; not a billing measurement'}. Calendar-month counters use UTC. Free allowances are shared across your Turso organization; other databases and your actual subscription are not included. This is a reference comparison, not your account’s remaining quota. Free database allowance: ${limits.databases}. <a href="https://turso.tech/pricing" target="_blank" rel="noopener noreferrer">Turso pricing</a> · Checked ${escapeHtml(d.free_plan.checked_on)}.</p>
 ${p.status!=='available'?`<p role="status" class="subtle">${p.status==='not_configured'?'Monthly usage is not connected. Configure the server-only TURSO_PLATFORM_API_TOKEN, TURSO_ORGANIZATION and TURSO_DATABASE_NAME to enable it. The database auth token cannot supply billing metrics.':'Turso usage is temporarily unavailable. Stored data measurements below are still available.'}</p>`:''}
 <div class="panel"><h3>Stored data overview</h3><p>${usageCount(d.total_rows)} records across ${d.tables.length} tables · ${usageBytes(d.estimated_bytes)} estimated data payload · ${usageBytes(d.free_bytes)} reusable space within the database file.</p><p class="subtle">Per-user sizes estimate stored field values: UTF-8 text/blob bytes and 8 bytes per numeric field. They exclude row headers, indexes and free pages, so they do not sum to billed storage. User-wise monthly reads/writes are not tracked. Shared caches and system records are shown separately.</p></div>
 <h3>User-wise stored data</h3><label for="database-usage-search">Find user</label><input id="database-usage-search" class="form-input" type="search" placeholder="Name or email"><div id="database-usage-users"></div>
 <h3>Shared and system data</h3><p>Unassigned/shared records: ${usageCount(d.shared.rows)} · ${usageBytes(d.shared.estimated_bytes)} estimated payload.</p>
 ${usageTable('Shared system accounts',['Account','Records','Estimated payload'],d.users.filter(u=>u.system).map(u=>`<tr><th scope="row">${escapeHtml(u.name||'System account')}</th><td>${usageCount(u.rows)}</td><td>${usageBytes(u.estimated_bytes)}</td></tr>`).join(''))}
 <h3>All tables</h3>${usageTable('Database table breakdown',['Table','Records','Estimated payload'],d.tables.map(t=>`<tr><th scope="row">${escapeHtml(t.name)}</th><td>${usageCount(t.rows)}</td><td>${usageBytes(t.estimated_bytes)}</td></tr>`).join(''))}`;
 document.getElementById('database-usage-search').addEventListener('input',renderDatabaseUsageUsers);
 renderDatabaseUsageUsers();setBanner('Database usage loaded.',true);
}
function renderDatabaseUsageUsers(){
 const query=document.getElementById('database-usage-search').value.trim().toLowerCase();
 const users=databaseUsageData.users.filter(u=>!u.system&&[u.name,u.email].join(' ').toLowerCase().includes(query));
 const rows=users.map(u=>`<tr><th scope="row">${escapeHtml(u.name||u.email)}<br><small>${escapeHtml(u.email)}</small></th><td>${escapeHtml(u.account_status||'')}</td><td>${usageCount(u.rows)}</td><td>${usageBytes(u.estimated_bytes)}</td><td><details><summary>View ${u.tables.length} tables</summary><ul>${u.tables.map(t=>`<li>${escapeHtml(t.name)}: ${usageCount(t.rows)} records · ${usageBytes(t.estimated_bytes)}</li>`).join('')}</ul></details></td></tr>`).join('');
 document.getElementById('database-usage-users').innerHTML=users.length?usageTable('User data, largest estimated size first',['User','Status','Records','Estimated payload','Breakdown'],rows):'<p class="empty-state">No users match this filter.</p>';
}
