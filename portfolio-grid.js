'use strict';
const portfolioGridState={sort:'symbol',direction:'asc',query:'',filters:{},page:1,size:10};
const portfolioGridColumns=[['symbol','Stock'],['shares','Shares'],['price','CMP'],['change','Day %'],['cost','Cost value'],['value','Market value'],['pnl','P/L amount'],['pnlPct','P/L %'],['xirr','XIRR %']];
const portfolioFilterModes={text:[['contains','Contains'],['notContains','Does not contain'],['starts','Starts with'],['ends','Ends with'],['eq','Equals'],['ne','Not equal']],number:[['eq','Equals'],['ne','Not equal'],['lt','Less than'],['lte','Less than or equal'],['gt','Greater than'],['gte','Greater than or equal'],['missing','Unavailable'],['present','Available']]};
function portfolioGridValues(h){
 const q=priceMap[h.ticker],number=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
 const shares=number(h.shares),average=number(h.avg_price),price=number(q?.price)>0?number(q.price):null;
 const cost=shares!==null&&average!==null?shares*average:null;
 return {symbol:h.ticker,name:q?.name||h.stock_name||h.name||'',shares,price,cost,change:price===null?null:number(q?.changePct),value:price===null?null:price*shares,pnl:price===null||cost===null?null:price*shares-cost,pnlPct:price!==null&&average>0?(price-average)/average*100:null,xirr:price===null?null:number(calcXIRR(h.trades||[],price))};
}
function portfolioMatchesRule(value,rule,text){
 if(rule.mode==='missing')return value===null;
 if(rule.mode==='present')return value!==null;
 if(value===null)return false;
 const a=text?String(value).toLowerCase():Number(value),b=text?String(rule.value).toLowerCase():Number(rule.value);
 switch(rule.mode){case 'contains':return a.includes(b);case 'notContains':return !a.includes(b);case 'starts':return a.startsWith(b);case 'ends':return a.endsWith(b);case 'eq':return a===b;case 'ne':return a!==b;case 'lt':return a<b;case 'lte':return a<=b;case 'gt':return a>b;case 'gte':return a>=b;default:return true;}
}
function portfolioGridMatches(values,state=portfolioGridState){
 const stock=values.symbol+' '+values.name;
 if(!stock.toLowerCase().includes(state.query.trim().toLowerCase()))return false;
 return Object.entries(state.filters).every(([field,filter])=>{
  const matches=filter.rules.map(rule=>portfolioMatchesRule(field==='symbol'?stock:values[field],rule,field==='symbol'));
  return filter.operator==='any'?matches.some(Boolean):matches.every(Boolean);
 });
}
function renderPortfolioGrid(){
 const escape=escapeHtml,host=document.getElementById('port-table');
 const filterIcon='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 4h18l-7 8v7l-4 2v-9Z"/></svg>';
 const rows=portfolioHoldings.map(h=>{
  const v=portfolioGridValues(h),ticker=escape(h.ticker),pct=n=>n===null?'—':n.toFixed(2)+'%';
  return `<tr id="port-row-${ticker}" data-holding="${ticker}"><th scope="row"><button type="button" class="grid-stock" data-stock="${ticker}" aria-label="View trade breakdown for ${ticker}">${ticker}</button><div class="ph-name" id="ph-name-${ticker}">${escape(v.name||'—')}</div></th><td>${h.shares}</td><td id="ph-cmp-${ticker}">—</td><td>${pct(v.change)}</td><td>${v.cost===null?'—':fmt(v.cost)}</td><td id="ph-value-${ticker}">—</td><td id="ph-pnl-${ticker}">—</td><td>${pct(v.pnlPct)}</td><td id="ph-xirr-${ticker}">—</td></tr>`;
 }).join('');
 host.innerHTML=`<section class="portfolio-grid"><div class="grid-toolbar"><button type="button" class="preview-btn" id="grid-clear">Clear filters</button><label class="grid-search">Search holdings<input id="grid-search" type="search" placeholder="Stock name or symbol" value="${escape(portfolioGridState.query)}"></label></div><p class="grid-note">Filters apply to holdings below. Summary totals include the full portfolio.</p><div class="grid-scroll" tabindex="0" role="region" aria-label="Portfolio holdings. Scroll horizontally for more columns."><table class="holdings-grid"><caption class="grid-sr">Portfolio holdings with sortable columns and advanced filters</caption><thead><tr>${portfolioGridColumns.map(([key,label])=>`<th scope="col" data-column="${key}"><div class="grid-heading"><button type="button" data-sort="${key}">${label}<span class="grid-sort-icon" aria-hidden="true"></span></button><button type="button" class="grid-filter" data-filter="${key}" aria-label="Filter ${label}" aria-haspopup="dialog" aria-controls="grid-filter-dialog">${filterIcon}</button></div></th>`).join('')}</tr></thead><tbody id="port-rows">${rows}</tbody><tbody id="grid-empty" hidden><tr><td colspan="9">No holdings match your filters. Clear filters to see all holdings.</td></tr></tbody></table></div><div class="grid-footer"><span id="grid-count" role="status" aria-live="polite"></span><div class="grid-paging"><label>Rows per page <select id="grid-size" data-autocomplete-ready="true">${[10,25,50,100000].map(n=>`<option value="${n}" ${n===portfolioGridState.size?'selected':''}>${n===100000?'All':n}</option>`).join('')}</select></label><button type="button" id="grid-prev" aria-label="Previous page">‹</button><span id="grid-page"></span><button type="button" id="grid-next" aria-label="Next page">›</button></div></div></section>`;
 host.querySelectorAll('[data-sort]').forEach(button=>button.onclick=()=>{const s=portfolioGridState;s.direction=s.sort===button.dataset.sort&&s.direction==='asc'?'desc':'asc';s.sort=button.dataset.sort;s.page=1;applyPortfolioSort();});
 host.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>openPortfolioFilter(button.dataset.filter,button));
 host.querySelectorAll('[data-stock]').forEach(button=>button.onclick=()=>showXIRR(button.dataset.stock));
 host.querySelector('#grid-search').oninput=e=>{portfolioGridState.query=e.target.value;portfolioGridState.page=1;updatePortfolioGridView();};
 host.querySelector('#grid-clear').onclick=()=>{portfolioGridState.query='';portfolioGridState.filters={};portfolioGridState.page=1;host.querySelector('#grid-search').value='';updatePortfolioGridView();};
 host.querySelector('#grid-size').onchange=e=>{portfolioGridState.size=Number(e.target.value);portfolioGridState.page=1;updatePortfolioGridView();};
 host.querySelector('#grid-prev').onclick=()=>{portfolioGridState.page--;updatePortfolioGridView();};
 host.querySelector('#grid-next').onclick=()=>{portfolioGridState.page++;updatePortfolioGridView();};
 applyPortfolioSort();
}
function updatePortfolioGridView(){
 const host=document.getElementById('port-table');if(!host.querySelector('.holdings-grid'))return;
 const s=portfolioGridState;
 const matching=new Set(portfolioHoldings.filter(h=>portfolioGridMatches(portfolioGridValues(h))).map(h=>h.ticker));
 const pages=Math.max(1,Math.ceil(matching.size/s.size));s.page=Math.max(1,Math.min(s.page,pages));let index=0;
 for(const row of host.querySelectorAll('#port-rows tr')){const match=matching.has(row.dataset.holding);row.hidden=!match||index<(s.page-1)*s.size||index>=s.page*s.size;if(match)index++;}
 for(const th of host.querySelectorAll('th[data-column]')){
  if(th.dataset.column===s.sort)th.setAttribute('aria-sort',s.direction==='asc'?'ascending':'descending');else th.removeAttribute('aria-sort');
  const button=th.querySelector('[data-filter]'),active=!!s.filters[th.dataset.column];button.classList.toggle('active',active);button.setAttribute('aria-label','Filter '+portfolioGridColumns.find(c=>c[0]===th.dataset.column)[1]+(active?' (active)':''));
 }
 host.querySelector('#grid-empty').hidden=matching.size>0;
 host.querySelector('#grid-count').textContent=`${matching.size?((s.page-1)*s.size+1):0}–${Math.min(s.page*s.size,matching.size)} of ${matching.size} matching holdings (${portfolioHoldings.length} total) · Sorted by ${portfolioGridColumns.find(c=>c[0]===s.sort)[1]}, ${s.direction==='asc'?'ascending':'descending'}`;
 host.querySelector('#grid-page').textContent=`${s.page} / ${pages}`;
 host.querySelector('#grid-prev').disabled=s.page===1;host.querySelector('#grid-next').disabled=s.page===pages;
}
function openPortfolioFilter(field,trigger){
 document.getElementById('grid-filter-dialog')?.remove();
 const label=portfolioGridColumns.find(c=>c[0]===field)[1],text=field==='symbol',modes=portfolioFilterModes[text?'text':'number'];
 const saved=portfolioGridState.filters[field]||{operator:'all',rules:[{mode:text?'contains':'eq',value:''}]};
 const dialog=document.createElement('dialog');dialog.id='grid-filter-dialog';dialog.className='grid-filter-dialog';dialog.setAttribute('aria-labelledby','grid-filter-title');
 dialog.innerHTML=`<form><div class="grid-dialog-heading"><h3 id="grid-filter-title">Filter ${label}</h3><button type="button" id="filter-close" aria-label="Close filter">×</button></div><label>Match rules<select id="filter-operator" data-autocomplete-ready="true"><option value="all">Match all</option><option value="any">Match any</option></select></label><div id="filter-rules"></div><button type="button" id="filter-add">+ Add rule</button><div class="grid-dialog-actions"><button type="button" id="filter-clear">Clear</button><button type="submit" class="filter-apply">Apply</button></div></form>`;
 document.body.append(dialog);dialog.querySelector('#filter-operator').value=saved.operator;
 function add(rule={mode:text?'contains':'eq',value:''}){
  const row=document.createElement('div');row.className='grid-rule';
  row.innerHTML=`<label>Condition<select data-mode data-autocomplete-ready="true">${modes.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select></label><label>Value<input data-value type="${text?'text':'number'}" step="any" ${['cost','value','pnl'].includes(field)?'data-private-input':''}></label><button type="button" aria-label="Remove rule">Remove</button>`;
  row.querySelector('[data-mode]').value=rule.mode;row.querySelector('[data-value]').value=rule.value;
  const update=()=>{const input=row.querySelector('[data-value]');input.disabled=['missing','present'].includes(row.querySelector('[data-mode]').value);};
  row.querySelector('[data-mode]').onchange=update;update();row.querySelector('button').onclick=()=>row.remove();dialog.querySelector('#filter-rules').append(row);
 }
 saved.rules.forEach(add);
 dialog.querySelector('#filter-add').onclick=()=>add();
 dialog.querySelector('#filter-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{trigger.focus();dialog.remove();});
 dialog.querySelector('#filter-clear').onclick=()=>{delete portfolioGridState.filters[field];portfolioGridState.page=1;updatePortfolioGridView();dialog.close();};
 dialog.querySelector('form').onsubmit=e=>{
  e.preventDefault();const rules=Array.from(dialog.querySelectorAll('.grid-rule')).map(row=>({mode:row.querySelector('[data-mode]').value,value:row.querySelector('[data-value]').value.trim()})).filter(r=>r.value!==''||['missing','present'].includes(r.mode));
  if(rules.length)portfolioGridState.filters[field]={operator:dialog.querySelector('#filter-operator').value,rules};else delete portfolioGridState.filters[field];
  portfolioGridState.page=1;updatePortfolioGridView();dialog.close();
 };
 dialog.showModal();
}
