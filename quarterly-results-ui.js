(()=>{
 let generation=0,stocks=[],searchVersion=0,searchTimer,options=[],activeOption=-1,sequence=0,source='portfolio',watchlists=[],activeTab='calendar',calendarMonth='',selectedDate=null,listLoading=false,listError=null;
 const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const finite=n=>typeof n==='number'&&Number.isFinite(n);
 const amount=(n,digits=2)=>finite(n)?n.toLocaleString('en-IN',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
 const date=s=>s?new Date(s+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'Unavailable';
 const scale=stock=>stock.unit==='crores'?1e7:stock.unit==='millions'?1e6:1;
 const unitLabel=stock=>stock.unit==='crores'?'₹ Crores':stock.unit==='millions'?'$ Millions':`${stock.data.currency} · Raw numbers`;
 const safeLink=url=>{try{const u=new URL(url);return u.protocol==='https:'?esc(u.href):'';}catch{return '';}};
 function shell(){
  el('quarterly-results-root').innerHTML=`<div class="qr-heading"><div><div class="qr-eyebrow">Fundamentals / Earnings intelligence</div><h1>Stock Results Analysis</h1><p class="qr-subtitle">Your stocks, quarter by quarter. Eight consecutive quarters and a trailing twelve-month view.</p></div><span class="qr-pill">QUARTERLY RESULTS</span></div>
   <div class="qr-tabs" role="tablist" aria-label="Results views"><button type="button" role="tab" id="qr-tab-calendar" aria-controls="qr-panel-calendar" data-tab="calendar">Result Calendar</button><button type="button" role="tab" id="qr-tab-results" aria-controls="qr-panel-results" data-tab="results">Portfolio Results</button></div>
   <section id="qr-panel-calendar" role="tabpanel" aria-labelledby="qr-tab-calendar"><div class="qr-calendar"><div class="qr-calendar-heading"><h2 id="qr-month-title"></h2><div class="qr-calendar-actions"><button type="button" class="qr-button" id="qr-month-prev" aria-label="Previous month">‹</button><button type="button" class="qr-button" id="qr-month-today">Today</button><button type="button" class="qr-button" id="qr-month-latest">Latest results</button><button type="button" class="qr-button" id="qr-month-next" aria-label="Next month">›</button></div></div><div id="qr-calendar-days" class="qr-calendar-grid" role="group" aria-labelledby="qr-month-title"></div><p id="qr-calendar-note" class="qr-note"></p></div><h2 id="qr-day-title" class="qr-day-title"></h2><p id="qr-day-status" class="qr-note" role="status"></p><div id="qr-day-results"></div></section>
   <section id="qr-panel-results" role="tabpanel" aria-labelledby="qr-tab-results"><div class="qr-toolbar"><form id="qr-search-form" class="qr-search-form"><div class="qr-search-wrap"><label for="qr-search">Find a company · NSE, BSE or US</label><input id="qr-search" type="search" placeholder="Search a company or symbol, e.g. RELIANCE.NS" autocomplete="off" autocapitalize="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="qr-suggestions" aria-expanded="false" maxlength="80"><div id="qr-suggestions" class="qr-suggestions" role="listbox" aria-label="Stock suggestions"></div></div><button class="qr-button" type="submit">View results ↗</button></form>
   <div class="qr-picks" aria-label="Quick stock picks">${['RELIANCE.NS','TCS.NS','INFY.NS','HDFCBANK.NS','TATAMOTORS.NS','NVDA','AAPL'].map(t=>`<button class="qr-button" data-pick="${t}" type="button">${t}</button>`).join('')}</div><p class="qr-note" id="qr-search-status" role="status" aria-live="polite"></p></div>
   <div class="qr-list-heading"><div class="qr-source"><label for="qr-source">Show results for</label><select id="qr-source" name="results-source" data-autocomplete-ready="true"><option value="portfolio">Portfolio</option>${watchlists.map(list=>`<option value="${esc(list.id)}">Watchlist · ${esc(list.name)}</option>`).join('')}</select><span id="qr-count"></span></div><span>Latest available result period first <button class="qr-button" id="qr-refresh" type="button">Refresh</button></span></div><p id="qr-load-status" class="qr-note" role="status" aria-live="polite">Loading portfolio stocks…</p><div id="qr-portfolio"></div>
   <div id="qr-explore-heading" class="qr-list-heading" hidden><h2>Explore results</h2><span>Stocks viewed outside the selected list</span></div><div id="qr-explore"></div></section>`;
  // The list filter applies to both views and stays visible when switching tabs.
  const root=el('quarterly-results-root'),panel=el('qr-panel-calendar');
  root.insertBefore(el('qr-source').closest('.qr-list-heading'),panel);
  root.insertBefore(el('qr-load-status'),panel);
  root.querySelectorAll('[data-tab]').forEach(button=>{
   button.addEventListener('click',()=>setTab(button.dataset.tab));
   button.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const target=event.key==='Home'?'calendar':event.key==='End'?'results':activeTab==='calendar'?'results':'calendar';setTab(target);el('qr-tab-'+target).focus();});
  });
  el('qr-month-prev').onclick=()=>moveMonth(-1);
  el('qr-month-next').onclick=()=>moveMonth(1);
  el('qr-month-today').onclick=()=>{selectedDate=localToday();calendarMonth=selectedDate.slice(0,7);renderCalendar();};
  el('qr-month-latest').onclick=()=>{const latest=resultDates().at(-1);if(latest){selectedDate=latest;calendarMonth=latest.slice(0,7);renderCalendar();}};
  el('qr-calendar-days').onclick=event=>{const button=event.target.closest('[data-date]');if(button){selectedDate=button.dataset.date;renderCalendar();el('qr-calendar-days').querySelector(`[data-date="${selectedDate}"]`)?.focus();}};
  setTab(activeTab);
  el('qr-search-form').addEventListener('submit',e=>{e.preventDefault();const ticker=el('qr-search').value.trim().toUpperCase();if(/^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(ticker))pick(ticker);else el('qr-search-status').textContent='Select a suggestion or enter a Yahoo ticker.';});
  el('qr-search').addEventListener('input',search);
  el('qr-search').addEventListener('keydown',event=>{
   if(event.key==='Escape'){closeSuggestions();return;}
   if(['ArrowDown','ArrowUp'].includes(event.key)&&options.length){event.preventDefault();activeOption=(activeOption+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;highlight();}
   if(event.key==='Enter'&&activeOption>=0){event.preventDefault();pick(options[activeOption].ticker);}
  });
  el('qr-source').value=source;
  el('qr-source').addEventListener('change',()=>loadList(el('qr-source').value));
  el('qr-refresh').addEventListener('click',()=>loadList(source));
  el('quarterly-results-root').onclick=e=>{
   const button=e.target.closest('[data-pick]');if(button)pick(button.dataset.pick);
   if(!e.target.closest('.qr-search-wrap'))closeSuggestions();
  };
 }
 function localToday(){const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;}
 function resultDates(){return [...new Set(stocks.filter(s=>s.portfolio&&s.data?.latest_result_date).map(s=>s.data.latest_result_date))].sort();}
 function setTab(tab){
  activeTab=tab;
  for(const name of ['calendar','results']){const active=name===tab;el('qr-tab-'+name).setAttribute('aria-selected',String(active));el('qr-tab-'+name).tabIndex=active?0:-1;el('qr-panel-'+name).hidden=!active;}
  stocks.filter(s=>s.portfolio).forEach(s=>{s.node.hidden=false;el('qr-portfolio').append(s.node);});
  sortStocks();
 }
 function moveMonth(offset){const [year,month]=calendarMonth.split('-').map(Number);calendarMonth=new Date(Date.UTC(year,month-1+offset,1)).toISOString().slice(0,7);selectedDate=null;renderCalendar();}
 function renderCalendar(){
  if(!el('qr-calendar-days'))return;
  const today=localToday();if(!calendarMonth)calendarMonth=today.slice(0,7);
  const [year,month]=calendarMonth.split('-').map(Number),first=new Date(Date.UTC(year,month-1,1)),days=new Date(Date.UTC(year,month,0)).getUTCDate();
  const counts=new Map();for(const stock of stocks.filter(s=>s.portfolio)){const day=stock.data?.latest_result_date;if(day)counts.set(day,(counts.get(day)||0)+1);}
  el('qr-month-title').textContent=first.toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
  el('qr-calendar-days').innerHTML=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day=>`<span class="qr-weekday">${day}</span>`).join('')+'<span aria-hidden="true"></span>'.repeat((first.getUTCDay()+6)%7)+Array.from({length:days},(_,i)=>{
   const day=`${calendarMonth}-${String(i+1).padStart(2,'0')}`,count=counts.get(day)||0;
   return `<button type="button" class="qr-calendar-day ${count?'qr-has-results':''}" data-date="${day}" aria-pressed="${day===selectedDate}" ${day===today?'aria-current="date"':''} aria-label="${date(day)}, ${count} ${count===1?'result':'results'}"><span>${i+1}</span>${count?`<small>${count}<span class="qr-day-word"> ${count===1?'result':'results'}</span></small>`:''}</button>`;
  }).join('');
  el('qr-month-latest').disabled=!counts.size;
  const members=stocks.filter(s=>s.portfolio).sort((a,b)=>(a.name||'').localeCompare(b.name||'')),undated=members.filter(s=>!s.data?.latest_result_date).length;
  el('qr-calendar-note').textContent='Highlighted dates have results. Shows the latest available announcement for each stock, not a complete historical calendar. '+(listLoading?'Loading result dates…':`${undated} of ${members.length} stocks have no available result date.`);
  el('qr-day-title').textContent=selectedDate?'Results · '+date(selectedDate):'Select a date to view results';
  const matches=members.filter(s=>s.data?.latest_result_date===selectedDate);
  el('qr-day-status').textContent=listError?'Unable to load this list. Use Refresh to retry.':listLoading?'Loading results…':!members.length?'No stocks in this '+(source==='portfolio'?'portfolio':'watchlist')+' yet.':!selectedDate?'Choose a highlighted date above.':matches.length?`${matches.length} ${matches.length===1?'stock reported':'stocks reported'} · Open a stock for details.`:'No available results for this date.';
  if(activeTab==='calendar')members.forEach(stock=>{stock.node.hidden=!matches.includes(stock);el('qr-day-results').append(stock.node);});
 }
 function closeSuggestions(){options=[];activeOption=-1;searchVersion++;clearTimeout(searchTimer);el('qr-suggestions')?.replaceChildren();el('qr-search')?.setAttribute('aria-expanded','false');el('qr-search')?.removeAttribute('aria-activedescendant');}
 function highlight(){el('qr-suggestions').querySelectorAll('[role=option]').forEach((item,i)=>item.setAttribute('aria-selected',String(i===activeOption)));if(activeOption>=0){el('qr-search').setAttribute('aria-activedescendant','qr-option-'+activeOption);el('qr-option-'+activeOption).scrollIntoView({block:'nearest'});}}
 function search(){
  closeSuggestions();const query=el('qr-search').value.trim(),version=searchVersion,view=generation;
  if(query.length<2){el('qr-search-status').textContent='Type at least two characters.';return;}
  searchTimer=setTimeout(async()=>{
   el('qr-search-status').textContent='Searching Yahoo Finance…';
   try{const result=await api('/api/results/search?q='+encodeURIComponent(query));if(view!==generation||version!==searchVersion)return;if(!result.success)throw Error(result.error);
    options=result.data;activeOption=-1;
    el('qr-suggestions').innerHTML=options.map((row,i)=>`<div id="qr-option-${i}" role="option" aria-selected="false" data-pick="${esc(row.ticker)}"><b>${esc(row.ticker)}</b><small>${esc(row.exchange)}</small><div>${esc(row.name)}</div></div>`).join('');
    el('qr-search').setAttribute('aria-expanded',String(options.length>0));el('qr-search-status').textContent=options.length?`${options.length} matches. Use arrow keys and Enter to select.`:'No matches. You can still enter an exact Yahoo ticker.';
   }catch(error){if(view===generation&&version===searchVersion)el('qr-search-status').textContent=error.message||'Search unavailable.';}
  },300);
 }
 function addStock(info,portfolio){
  const stock={...info,portfolio,id:'qr-stock-'+(++sequence),openGroups:new Set(),yoy:false,qoq:false,data:null,error:null};
  stock.node=document.createElement('details');stock.node.className='qr-stock';stock.node.id=stock.id;
  stock.node.innerHTML='<summary></summary><div class="qr-body"><p class="qr-note">Loading quarterly financials…</p></div>';
  stocks.push(stock);(portfolio?el('qr-portfolio'):el('qr-explore')).append(stock.node);updateSummary(stock);
  return stock;
 }
 function updateSummary(stock){
  const data=stock.data,latest=data?.quarters?.at(-1),pending=!data&&!stock.error;
  const peValue=n=>finite(n)?n.toLocaleString('en-IN',{maximumFractionDigits:2})+'PE':'—';
  const growthValue=type=>{const n=latest?.[type]?.netProfit;return `<strong class="${finite(n)?n>=0?'qr-positive':'qr-negative':'qr-missing'}">${finite(n)?(n>0?'+':'')+amount(n,1)+'%':pending?'Loading…':'—'}</strong>`;};
  stock.node.querySelector('summary').innerHTML=`<span class="qr-stock-title"><strong>${esc(stock.name||stock.ticker)}</strong><small>${esc(stock.ticker||stock.holding_ticker)}${stock.portfolio?(source==='portfolio'?' · PORTFOLIO':' · WATCHLIST'):''}</small><small>${data?.latest_period?'Period ended '+date(data.latest_period):stock.error?'Results unavailable':'Fetching results'}</small></span><span class="qr-summary-metrics"><span class="qr-summary-metric" title="Yahoo earnings announcement date; may differ by up to two days. Future or estimated dates are omitted."><small>Result date</small><strong>${data?.latest_result_date?date(data.latest_result_date):pending?'Loading…':'—'}</strong></span><span class="qr-summary-metric" title="Same current share price divided by TTM diluted EPS before and after the latest quarter. Missing, non-positive earnings or mismatched currencies show —."><small>P/E before → after</small><strong>${pending?'Loading…':peValue(data?.pe_comparison?.before)+' → '+peValue(data?.pe_comparison?.after)}</strong><small>At current price</small></span><span class="qr-summary-metric"><small>YoY growth %</small>${growthValue('yoy')}<small>Net profit</small></span><span class="qr-summary-metric"><small>QoQ growth %</small>${growthValue('qoq')}<small>Net profit</small></span></span>`;
 }
 function sortStocks(){for(const portfolio of [true,false]){const container=portfolio?el('qr-portfolio'):el('qr-explore');stocks.filter(s=>s.portfolio===portfolio).sort((a,b)=>(b.data?.latest_result_date||b.data?.latest_period||'').localeCompare(a.data?.latest_result_date||a.data?.latest_period||'')||(a.name||'').localeCompare(b.name||'')).forEach(s=>container.append(s.node));}if(activeTab==='calendar')renderCalendar();}
 async function fetchStock(stock,view){
  try{
   if(!stock.ticker)throw Error('No Yahoo symbol is mapped to this holding. Use the search above to view its results.');
   const result=await api('/api/stock/'+encodeURIComponent(stock.ticker)+'/quarterly');if(view!==generation)return;
   if(!result.success)throw Error(result.error||'Results unavailable.');stock.data=result.data;stock.name=result.data.name;stock.error=null;
   stock.unit=stock.data.currency==='INR'?'crores':stock.data.currency==='USD'?'millions':'raw';render(stock);
  }catch(error){if(view!==generation)return;stock.error=error.message;stock.node.querySelector('.qr-body').innerHTML=`<p class="qr-alert">${esc(error.message)}</p>${stock.ticker?'<button type="button" class="qr-button qr-retry">Retry results</button>':''}`;stock.node.querySelector('.qr-retry')?.addEventListener('click',async e=>{e.target.disabled=true;await fetchStock(stock,view);if(view===generation)sortStocks();});}
  if(view===generation){updateSummary(stock);if(activeTab==='calendar')renderCalendar();}
 }
 async function pick(ticker){
  setTab('results');
  closeSuggestions();el('qr-search').value=ticker;el('qr-search-status').textContent='';
  let stock=stocks.find(s=>s.ticker===ticker);
  if(!stock){stock=addStock({ticker,name:ticker},false);el('qr-explore-heading').hidden=false;stock.node.open=true;await fetchStock(stock,generation);sortStocks();}
  stock.node.open=true;stock.node.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
 }
 function metric(stock,n,key){return amount(n,2)+(finite(n)&&['opm','taxRate'].includes(key)?'%':'');}
 function formatted(stock,n,key){return metric(stock,finite(n)&&!['opm','taxRate','eps'].includes(key)?n/scale(stock):n,key);}
 function badges(stock,q,key){return ['yoy','qoq'].filter(type=>stock[type]).map(type=>{const n=q[type]?.[key];return `<span class="qr-growth ${finite(n)?n>=0?'qr-positive':'qr-negative':'qr-missing'}">${type==='yoy'?'YoY':'QoQ'} ${finite(n)?(n>0?'+':'')+amount(n,1)+'%':'—'}</span>`;}).join('');}
 function cell(stock,q,key,isTTM=false){const n=q.values[key];return `<td><span class="${finite(n)?n<0?'qr-negative':['opm','taxRate'].includes(key)?'qr-positive':'':'qr-missing'}">${formatted(stock,n,key)}${q.derived?.includes(key)?'<sup title="Derived from annual total minus three quarters">†</sup>':''}</span>${isTTM?'':badges(stock,q,key)}</td>`;}
 function chart(stock,key,label){
  const quarters=stock.data.quarters,values=quarters.map(q=>q.values[key]),valid=values.filter(finite),max=Math.max(0,...valid),min=Math.min(0,...valid),range=max-min||1;
  const y=n=>8+(max-n)/range*62,zero=y(0);
  return `<div class="qr-chart"><h3>${label} <small>· ${esc(unitLabel(stock))}</small></h3><svg viewBox="0 0 280 84" role="img" aria-label="${esc(label)} across eight quarters"><title>${esc(quarters.map((q,i)=>q.label+': '+formatted(stock,values[i],key)).join('; '))}</title><line x1="0" x2="280" y1="${zero}" y2="${zero}" stroke="#35455e"/>${values.map((v,i)=>finite(v)?`<rect x="${i*35+5}" y="${Math.min(y(v),zero)}" width="23" height="${Math.max(Math.abs(y(v)-zero),1)}" rx="2" fill="${v<0?'#c87983':i===7?'#a5b4fc':'#506c9a'}"><title>${esc(quarters[i].label)}: ${formatted(stock,v,key)}</title></rect>`:`<text x="${i*35+16}" y="78" text-anchor="middle" fill="#71839d" font-size="10">—</text>`).join('')}</svg><div class="qr-chart-footer"><span>${esc(quarters[0].label)}</span><span>${esc(quarters[7].label)}</span></div></div>`;
 }
 function table(stock){
  const data=stock.data,cols=[...data.quarters,{values:data.ttm}],row=(key,label,sub,parent)=>`<tr class="${sub?'qr-subrow': ['operatingProfit','netProfit'].includes(key)?'qr-profit':''}" ${sub?`data-parent="${parent}" id="${stock.id}-${key}" ${stock.openGroups.has(parent)?'':'hidden'}`:''}><th scope="row">${label}</th>${cols.map((q,i)=>cell(stock,q,key,i===8)).join('')}</tr>`;
  return `<div class="qr-table-wrap" tabindex="0" role="region" aria-label="${esc(data.ticker)} quarterly results, scroll horizontally"><table class="qr-table"><caption>Quarterly Results · ${esc(unitLabel(stock))} except EPS and percentages · oldest to newest</caption><thead><tr><th scope="col">Financial line item</th>${data.quarters.map(q=>`<th scope="col">${esc(q.label)}</th>`).join('')}<th scope="col">TTM</th></tr></thead><tbody>${data.fields.map(field=>{
   if(field.key==='filing')return `<tr><th scope="row">Raw PDF</th>${data.quarters.map(q=>`<td>${safeLink(q.filing_url)?`<a target="_blank" rel="noopener noreferrer" href="${safeLink(q.filing_url)}">Open filing ↗</a>`:`<a target="_blank" rel="noopener noreferrer" title="Period-matched PDF unavailable. Search the official exchange for ${esc(q.label)}." href="${safeLink(data.filing_search_url)}">Find filing ↗</a>`}</td>`).join('')}<td class="qr-missing">—</td></tr>`;
   const label=field.key==='eps'?`EPS in ${esc(data.currency==='INR'?'Rs':data.currency)}`:esc(field.label);
   return row(field.key,field.children?`<button type="button" class="qr-expand" data-group="${field.key}" aria-expanded="${stock.openGroups.has(field.key)}" aria-controls="${field.children.map(c=>stock.id+'-'+c[0]).join(' ')}">${label}<span aria-hidden="true">${stock.openGroups.has(field.key)?'−':'+'}</span></button>`:label,false)+
    (field.children||[]).map(([key,name])=>row(key,esc(name),true,field.key)).join('');
  }).join('')}</tbody></table></div>`;
 }
 function render(stock){
  const data=stock.data,body=stock.node.querySelector('.qr-body');
  body.innerHTML=`${data.stale?`<p class="qr-alert">${esc(data.warning)}</p>`:''}${data.coverage.missing||data.coverage.derived?`<p class="qr-alert">${data.coverage.reported}/8 quarters reported${data.coverage.derived?' · '+data.coverage.derived+' with annual-derived values':''}${data.coverage.missing?' · '+data.coverage.missing+' unavailable':''}. Unavailable fields stay blank; no estimates are substituted.</p>`:''}
   <div class="qr-controls"><label for="${stock.id}-unit">Display units</label><select id="${stock.id}-unit" data-autocomplete-ready="true" aria-label="Display units"><option value="crores" ${data.currency!=='INR'?'disabled':''}>₹ Crores</option><option value="millions" ${data.currency!=='USD'?'disabled':''}>$ Millions</option><option value="raw">Raw Numbers (${esc(data.currency)})</option></select><button type="button" class="qr-button" data-growth="yoy" aria-pressed="${stock.yoy}">YoY Growth %</button><button type="button" class="qr-button" data-growth="qoq" aria-pressed="${stock.qoq}">QoQ Growth %</button><button class="qr-button qr-export" type="button">Download CSV ↓</button></div>
   <div class="qr-charts">${chart(stock,'sales','Sales')}${chart(stock,'operatingProfit','Operating Profit')}${chart(stock,'netProfit','Net Profit')}</div>${table(stock)}
   <p class="qr-note">Source: Yahoo Finance · ${esc(data.currency)} reporting currency${data.currency_inferred?' (inferred from listing; verify in the filing)':''} · Retrieved ${esc(new Date(data.fetched_at).toLocaleString())}. Unit scaling does not convert currencies.</p>
   <details class="qr-explanation"><summary>Data definitions, coverage & filings</summary><ul>${data.notes.map(note=>`<li>${esc(note)}</li>`).join('')}<li>Growth = change divided by the absolute prior value. Zero or missing comparisons show —. Summary growth compares the latest quarter’s net profit. P/E before → after uses the same current share price divided by four-quarter diluted EPS, excluding then including the latest quarter. It shows the earnings impact, not historical trading P/E. Missing or non-positive EPS, missing prices, or currency mismatches show —. Result dates use past, non-estimated Yahoo earnings dates (which can differ by up to two days); unavailable dates show —. Results are ordered by result date where available, otherwise by period end.</li></ul>${data.filings?.length?'<p>Available corporate filings (filing dates):</p><ul>'+data.filings.map(f=>`<li><a href="${safeLink(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.type)} · ${esc(f.date)} ↗</a></li>`).join('')+'</ul>':''}</details>`;
  const select=el(stock.id+'-unit');select.value=stock.unit;select.addEventListener('change',()=>{stock.unit=select.value;render(stock);el(stock.id+'-unit').focus();});
  body.querySelectorAll('[data-growth]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.growth;stock[key]=!stock[key];render(stock);body.querySelector(`[data-growth="${key}"]`).focus();}));
  body.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{
   const key=button.dataset.group,open=!stock.openGroups.has(key);open?stock.openGroups.add(key):stock.openGroups.delete(key);button.setAttribute('aria-expanded',String(open));button.querySelector('span').textContent=open?'−':'+';
   body.querySelectorAll(`[data-parent="${key}"]`).forEach(row=>{row.classList.remove('qr-enter','qr-exit');if(open){row.hidden=false;row.classList.add('qr-enter');}else{row.classList.add('qr-exit');setTimeout(()=>{if(!stock.openGroups.has(key))row.hidden=true;},matchMedia('(prefers-reduced-motion: reduce)').matches?0:180);}});
  }));
  body.querySelector('.qr-export').addEventListener('click',()=>download(stock));
 }
 function download(stock){
  const data=stock.data,rows=[['Ticker',data.ticker],['Currency',data.currency],['Display unit',unitLabel(stock)],['Financial line item',...data.quarters.map(q=>q.label),'TTM']];
  for(const field of data.fields){for(const [key,label] of [[field.key,field.label],...(field.children||[])]){
   const cells=[...data.quarters.map(q=>q.values),data.ttm].map((values,i)=>key==='filing'?(data.quarters[i]?.filing_url||''):finite(values[key])?values[key]/(['opm','taxRate','eps'].includes(key)?1:scale(stock)):'');rows.push([label,...cells]);
  }}
  rows.push(['Quarter status',...data.quarters.map(q=>q.missing?'Unavailable':q.derived.length?'Includes annual-derived values':'Reported'),'Requires four complete values per field']);
  rows.push(['Annual-derived fields',...data.quarters.map(q=>q.derived.join('; ')),'']);
  const quote=v=>'"'+String(typeof v==='string'&&/^[=+@\-\t\r]/.test(v)?"'"+v:v).replaceAll('"','""')+'"';
  const blob=new Blob(['\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=data.ticker+'-quarterly-results.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 window.loadQuarterlyResults=async function(){
  source='portfolio';watchlists=[];activeTab='calendar';calendarMonth=localToday().slice(0,7);selectedDate=null;
  const loading=loadList(source),view=generation;
  try{const result=await api('/api/watchlists');if(view!==generation)return;if(!result.success)throw Error(result.error);
   watchlists=result.data;
   const select=el('qr-source');for(const list of watchlists){const option=document.createElement('option');option.value=String(list.id);option.textContent='Watchlist · '+list.name;select.append(option);}
  }catch(error){if(view===generation)el('qr-search-status').textContent='Watchlists unavailable. Refresh this view to retry.';}
  await loading;
 };
 async function loadList(selected){
  if(source!==selected){selectedDate=null;}source=selected;listLoading=true;listError=null;
  const focusId=document.activeElement?.id;
  const view=++generation;searchVersion++;clearTimeout(searchTimer);stocks=[];shell();if(['qr-source','qr-refresh'].includes(focusId))el(focusId).focus();el('qr-load-status').textContent='Loading '+(source==='portfolio'?'portfolio':'watchlist')+' stocks…';
  try{const result=await api(source==='portfolio'?'/api/results/portfolio':'/api/watchlists/'+encodeURIComponent(source)+'/stocks');if(view!==generation)return;if(!result.success)throw Error(result.error);
   el('qr-count').textContent='('+result.data.length+')';
   if(!result.data.length){el('qr-portfolio').innerHTML='<div class="qr-empty">No stocks in this '+(source==='portfolio'?'portfolio':'watchlist')+' yet.<br>Search above or choose a quick pick to explore quarterly results.</div>';el('qr-load-status').textContent='';listLoading=false;renderCalendar();return;}
   const seen=new Set();
   const queue=result.data.map(info=>{
    if(source==='portfolio')return info;
    const code=String(info.stock_code||info.code||info.ticker||'').toUpperCase();
    const ticker=String(info.yahoo_finance_code||(/\.(NS|BO)$/.test(info.ticker)?info.ticker:/^NSE:/.test(code)?code.slice(4)+'.NS':/^(BSE|BOM):/.test(code)?code.slice(4)+'.BO':'')).trim().toUpperCase();
    return {...info,holding_ticker:info.ticker,ticker:ticker||null};
   }).filter(info=>{const key=info.ticker||info.holding_ticker;if(seen.has(key))return false;seen.add(key);return true;}).map(info=>addStock(info,true));
   el('qr-count').textContent='('+queue.length+')';let completed=0,index=0;
   await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{while(index<queue.length&&view===generation){const stock=queue[index++];await fetchStock(stock,view);if(view!==generation)return;completed++;el('qr-load-status').textContent=`Loaded ${completed} of ${queue.length} stocks…`;}}));
   if(view!==generation)return;listLoading=false;sortStocks();renderCalendar();el('qr-load-status').textContent=`${completed} stocks checked · Sorted by latest available results. Cached results refresh every 6 hours.`;
  }catch(error){if(view===generation){listLoading=false;listError=error;el('qr-load-status').textContent=error.message||'Unable to load results for this list.';renderCalendar();}}
 };
})();
