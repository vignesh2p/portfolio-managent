let activityData=null,activityWeek=null,activityUser='',activityLoadVersion=0;
function activityTime(minutes){const n=Number(minutes)||0;return n<60?n+' min':Math.floor(n/60)+'h '+n%60+'m';}
function activityStamp(value){return value?new Date(value).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}):'Never';}
async function loadAdminActivity(weeks=12){
 const version=++activityLoadVersion;
 document.getElementById('table-title').textContent='User activity';
 document.getElementById('table-meta').textContent='Weekly usage and retained history · India time';
 const result=await fetchJson('/api/admin/activity?weeks='+weeks);
 if(version!==activityLoadVersion||currentTable!=='User activity')return;
 if(!result.success)throw Error(result.error||'Unable to load activity');
 activityData=result.data;activityWeek=activityData.current_week;
 if(!activityData.users.some(u=>String(u.id)===activityUser))activityUser='';
 content.innerHTML=`<div class="activity-controls"><label>History range<select class="form-input" id="activity-range">${[4,12,26,52].map(n=>`<option value="${n}" ${n===weeks?'selected':''}>${n} weeks</option>`).join('')}</select></label><label>User history<select class="form-input" id="activity-user"><option value="">All users</option>${activityData.users.map(u=>`<option value="${u.id}" ${String(u.id)===activityUser?'selected':''}>${escapeHtml(u.name||u.email)} — ${escapeHtml(u.email)}</option>`).join('')}</select></label></div><p class="subtle">Tracking started ${activityStamp(activityData.tracking_since)} IST. Weeks run Monday–Sunday. Active minutes are estimates: a minute counts when the app is focused, visible and recently interacted with. Background/idle tabs are excluded; multiple tabs do not multiply time. Earlier activity is unavailable.</p><div id="activity-charts"></div><h3 id="activity-week-title"></h3><label class="activity-search">Find user<input id="activity-search" class="form-input" type="search" placeholder="Name or email"></label><div id="activity-users"></div>`;
 document.getElementById('activity-range').addEventListener('change',event=>loadAdminActivity(Number(event.target.value)).catch(e=>setError(e.message)));
 document.getElementById('activity-user').addEventListener('change',event=>{activityUser=event.target.value;renderActivityDetails();});
 document.getElementById('activity-search').addEventListener('input',renderActivityTable);
 renderActivityDetails();setBanner('User activity loaded.',true);
}
function activityChart(title,rows,field,format){
 const max=Math.max(1,...rows.map(r=>Number(r[field])));
 return `<section class="activity-chart"><h3>${escapeHtml(title)}</h3><div class="activity-chart-scroll" tabindex="0" role="region" aria-label="${escapeHtml(title)} by week"><div class="activity-bars">${rows.map(row=>`<button type="button" class="activity-bar ${row.week===activityWeek?'is-selected':''}" data-activity-week="${row.week}" aria-pressed="${row.week===activityWeek}" aria-label="Week ${row.week}: ${escapeHtml(format(row[field]))}. Show this week."><span class="activity-bar-value">${escapeHtml(format(row[field]))}</span><span class="activity-bar-track"><span style="height:${row[field]>0?Math.max(2,row[field]/max*100):0}%"></span></span><span>${row.week.slice(5)}</span></button>`).join('')}</div></div></section>`;
}
function renderActivityDetails(){
 const user=activityData.users.find(u=>String(u.id)===activityUser);
 const charts=document.getElementById('activity-charts');
 charts.innerHTML=activityChart('Weekly active users',activityData.weeks,'active_users',n=>String(n))+
 activityChart(user?'Weekly active time · '+(user.name||user.email):'Weekly active time · all users',user?user.weeks:activityData.weeks,'active_minutes',activityTime);
 charts.querySelectorAll('[data-activity-week]').forEach(button=>button.addEventListener('click',()=>{activityWeek=button.dataset.activityWeek;renderActivityDetails();const replacement=charts.querySelector(`[data-activity-week="${activityWeek}"]`);replacement?.focus();}));
 renderActivityTable();
}
function renderActivityTable(){
 document.getElementById('activity-week-title').textContent='Week starting '+activityWeek+' · per-user activity';
 const query=document.getElementById('activity-search').value.trim().toLowerCase();
 const rows=activityData.users.filter(u=>(!activityUser||String(u.id)===activityUser)&&[u.name,u.email].join(' ').toLowerCase().includes(query));
 document.getElementById('activity-users').innerHTML=`<div class="sheet-table-wrap" tabindex="0" role="region" aria-label="User activity history"><table><thead><tr>${['User','This week: active days','This week: active time','All-time active weeks','All-time active days','All-time active time','First active (IST)','Last active (IST)','History'].map(t=>`<th scope="col">${t}</th>`).join('')}</tr></thead><tbody>${rows.map(u=>{const week=u.weeks.find(w=>w.week===activityWeek)||{active_minutes:0,active_days:0};return `<tr><td>${escapeHtml(u.name||u.email)}<br><small>${escapeHtml(u.email)} · ${escapeHtml(u.account_status||'')}</small></td><td>${week.active_days}</td><td>${activityTime(week.active_minutes)}</td><td>${u.active_weeks}</td><td>${u.active_days}</td><td>${activityTime(u.active_minutes)}</td><td>${activityStamp(u.first_seen)}</td><td>${activityStamp(u.last_seen)}</td><td><button type="button" class="btn btn-secondary" data-activity-user="${u.id}">View history</button></td></tr>`;}).join('')}</tbody></table></div>${rows.length?'':'<p class="empty-state">No users match this filter.</p>'}`;
 document.querySelectorAll('[data-activity-user]').forEach(button=>button.addEventListener('click',()=>{activityUser=button.dataset.activityUser;document.getElementById('activity-user').value=activityUser;renderActivityDetails();document.getElementById('activity-charts').scrollIntoView({block:'start'});}));
}
