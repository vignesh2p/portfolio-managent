'use strict';
// Shared enhancement for native tables and legacy tabular layouts. Row nodes and
// controls are retained so existing handlers and edited values survive sorting.
(() => {
 const states=new WeakMap(),known=new Set(),collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const read=node=>window.readPrivateDisplayText?window.readPrivateDisplayText(node):node.textContent;
 const modes={text:[['contains','Contains'],['notContains','Does not contain'],['starts','Starts with'],['ends','Ends with'],['eq','Equals'],['ne','Not equal']],number:[['eq','Equals'],['ne','Not equal'],['lt','Less than'],['lte','Less than or equal'],['gt','Greater than'],['gte','Greater than or equal']],date:[['eq','On'],['ne','Not on'],['lt','Before'],['lte','On or before'],['gt','After'],['gte','On or after']]};
 let sequence=0,scheduled=false;
 function textOf(cell){
  if(!cell)return '';
  if(cell.dataset.gridValue!==undefined)return cell.dataset.gridValue;
  const inputs=[...cell.querySelectorAll('input:not([type=checkbox]):not([type=radio]),select,textarea')];
  if(inputs.length)return inputs.map(el=>el.type==='password'&&!el.hasAttribute('data-private-input')?'':el.value).join(' ');
  return read(cell).replace(/\s+/g,' ').trim();
 }
 function number(value){
  let v=String(value).trim().replace(/−/g,'-').replace(/,/g,'').replace(/₹\s*/g,'').replace(/%\s*(p\.a\.)?$/,'').trim();
  if(/^\(.*\)$/.test(v))v='-'+v.slice(1,-1);
  const bytes=v.match(/^([+-]?\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i);if(bytes)return Number(bytes[1])*1000**['B','KB','MB','GB','TB'].indexOf(bytes[2].toUpperCase());
  const time=v.match(/^(?:(\d+)h\s*)?(\d+)m$/);if(time)return Number(time[1]||0)*60+Number(time[2]);
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v)?Number(v):null;
 }
 function valueOf(cell,type){const text=textOf(cell);if(!text||/^(—|-|unavailable|n\/a|after 1 year)$/i.test(text))return null;if(type==='number')return number(text);if(type==='date'){const match=text.match(/^\d{4}-\d{2}-\d{2}/);return match?Date.parse(match[0]+'T00:00:00Z'):null;}return text;}
 function matches(value,rule,type){
  if(rule.mode==='missing')return value===null;if(rule.mode==='present')return value!==null;if(value===null)return false;
  const a=type==='text'?String(value).toLowerCase():value,b=type==='text'?rule.value.toLowerCase():type==='date'?Date.parse(rule.value+'T00:00:00Z'):Number(rule.value);
  switch(rule.mode){case 'contains':return String(a).includes(String(b));case 'notContains':return !String(a).includes(String(b));case 'starts':return String(a).startsWith(String(b));case 'ends':return String(a).endsWith(String(b));case 'eq':return a===b;case 'ne':return a!==b;case 'lt':return a<b;case 'lte':return a<=b;case 'gt':return a>b;case 'gte':return a>=b;default:return true;}
 }
 function legacy(){
  for(const [wrapper,header,rowClass] of [['.trades-table-wrap','.trades-head','.trades-row'],['.preview-table-wrap','.preview-head','.preview-row'],['.cf-table','.cf-head','.cf-row'],['.strategy-table','.table-head','.table-row']]){
   for(const host of document.querySelectorAll(wrapper)){
    const head=host.querySelector(':scope > '+header);if(!head)continue;
    const table=document.createElement('table'),thead=table.createTHead(),hr=thead.insertRow(),body=table.createTBody();
    for(const child of [...head.children]){const th=document.createElement('th');th.scope='col';th.append(...child.childNodes);hr.append(th);}head.remove();
    for(const old of [...host.querySelectorAll(':scope > '+rowClass)]){old.querySelector('.row-accent')?.remove();const row=body.insertRow();for(const attr of old.attributes)row.setAttribute(attr.name,attr.value);for(const child of [...old.children]){const cell=row.insertCell();for(const attr of child.attributes)cell.setAttribute(attr.name,attr.value);cell.append(...child.childNodes);}old.remove();}
    host.prepend(table);
   }
  }
 }
 function dataRows(table){return [...table.tBodies].flatMap(body=>[...body.rows]).filter(row=>!row.hasAttribute('data-app-empty')&&row.cells.length===table.tHead.rows[0].cells.length);}
 function signature(state){return JSON.stringify(dataRows(state.table).map(row=>[row.hidden,...[...row.cells].map(textOf)]));}
 function infer(state,rows){
  state.columns.forEach((col,i)=>{
   if(col.explicit){col.type=col.explicit;return;}
   const sample=rows.map(row=>textOf(row.cells[i])).filter(t=>t&&!/^(—|-|unavailable|n\/a|after 1 year)$/i.test(t));
   if(/name|code|ticker|symbol|email|status|source|type|action|ratio|line item|stock|user|^id$|#|^table$/i.test(col.label))col.type='text';
   else if(sample.length&&sample.every(t=>/^\d{4}-\d{2}-\d{2}/.test(t)))col.type='date';
   else col.type=sample.length&&sample.every(t=>number(t)!==null)?'number':'text';
  });
 }
 function enhance(table){
  if(states.has(table)||table.classList.contains('holdings-grid')||!table.tHead?.rows.length)return;
  const headers=[...table.tHead.rows[0].cells];if(!headers.length)return;
  const state={id:'app-grid-'+(++sequence),table,columns:headers.map(th=>({label:read(th).replace(/\s+/g,' ').trim(),type:'text',explicit:th.dataset.gridType,hint:th.dataset.gridHint||''})),query:'',filters:{},sort:null,direction:'asc',page:1,size:25};
  if(table.classList.contains('qr-table'))state.size=1000000;
  const section=document.createElement('section');section.className='app-grid portfolio-grid';table.before(section);state.section=section;
  section.innerHTML=`<div class="grid-toolbar"><button type="button" class="app-grid-clear">Clear filters</button><label class="grid-search">Search table<input type="search" class="app-grid-search" placeholder="Search loaded rows"></label></div><div class="app-grid-scroll" tabindex="0" role="region" aria-label="Data table. Scroll horizontally for more columns."></div><div class="grid-footer"><span class="app-grid-count" role="status"></span><div class="grid-paging"><label>Rows per page <select class="app-grid-size" data-autocomplete-ready="true"><option>10</option><option selected>25</option><option>50</option><option value="1000000">All</option></select></label><button type="button" class="app-grid-prev" aria-label="Previous page">‹</button><span class="app-grid-page"></span><button type="button" class="app-grid-next" aria-label="Next page">›</button></div></div>`;
  section.querySelector('.app-grid-size').value=String(state.size);
  section.querySelector('.app-grid-scroll').append(table);table.classList.add('app-grid-table');table.style.setProperty('--grid-columns',headers.length);
  if(!table.caption){const caption=table.createCaption();caption.className='grid-sr';caption.textContent=(table.closest('[aria-label]')?.getAttribute('aria-label')||'Application data')+' — sortable, filterable rows';}
  headers.forEach((th,i)=>{
   th.scope='col';th.setAttribute('aria-label',state.columns[i].label);const initial=th.getAttribute('aria-sort');if(initial&&initial!=='none'){state.sort=i;state.direction=initial==='descending'?'desc':'asc';}th.removeAttribute('aria-sort');
   const col=state.columns[i];if(!col.label||/^(actions?|review|history|status \/ lot details)$/i.test(col.label))return;
   const label=document.createElement('span');label.append(...th.childNodes);
   const group=document.createElement('div');group.className='grid-heading';
   const sort=document.createElement('button');sort.type='button';sort.className='app-grid-sort';sort.append(label);sort.insertAdjacentHTML('beforeend','<span class="grid-sort-icon" aria-hidden="true"></span>');sort.onclick=()=>{state.direction=state.sort===i&&state.direction==='asc'?'desc':'asc';state.sort=i;state.page=1;update(state);};
   const filter=document.createElement('button');filter.type='button';filter.className='grid-filter';filter.setAttribute('aria-label','Filter '+col.label);filter.setAttribute('aria-haspopup','dialog');filter.innerHTML='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 4h18l-7 8v7l-4 2v-9Z"/></svg>';filter.onclick=()=>openFilter(state,i,filter);col.filterButton=filter;group.append(sort,filter);th.append(group);
  });
  section.querySelector('.app-grid-search').oninput=e=>{state.query=e.target.value;state.page=1;update(state);};
  section.querySelector('.app-grid-clear').onclick=()=>{state.query='';state.filters={};state.page=1;section.querySelector('.app-grid-search').value='';update(state);};
  section.querySelector('.app-grid-size').onchange=e=>{state.size=Number(e.target.value);state.page=1;update(state);};
  section.querySelector('.app-grid-prev').onclick=()=>{state.page--;update(state);};section.querySelector('.app-grid-next').onclick=()=>{state.page++;update(state);};
  table.addEventListener('input',()=>{state.signature=null;schedule();});table.addEventListener('change',()=>{state.signature=null;schedule();});
  table.addEventListener('invalid',()=>{state.query='';state.filters={};state.size=1000000;section.querySelector('.app-grid-search').value='';section.querySelector('.app-grid-size').value='1000000';update(state);},true);
  states.set(table,state);known.add(state);update(state);
 }
 function update(state){
  observer.disconnect();
  const {table,section}=state,rows=dataRows(table),originalRows=[...rows],active=document.activeElement;infer(state,rows);
  const values=new Map(rows.map(row=>[row,state.columns.map((col,i)=>valueOf(row.cells[i],col.type))]));
  if(state.sort!==null){const i=state.sort;rows.sort((a,b)=>{const x=values.get(a)[i],y=values.get(b)[i];if(x===null)return y===null?0:1;if(y===null)return -1;return (typeof x==='number'&&typeof y==='number'?x-y:collator.compare(String(x),String(y)))*(state.direction==='desc'?-1:1);});if(table.classList.contains('qr-table')){const roots=rows.filter(row=>!row.dataset.parent),ordered=[];for(const root of roots){ordered.push(root);const group=root.querySelector('[data-group]')?.dataset.group;if(group)ordered.push(...originalRows.filter(row=>row.dataset.parent===group));}rows.splice(0,rows.length,...ordered);}
   for(const row of rows){const body=row.parentElement;if(body.moveBefore)body.moveBefore(row,null);else body.append(row);}
   if(active?.isConnected&&document.activeElement!==active)active.focus({preventScroll:true});}
  let matched=rows.filter(row=>!row.hidden&&[...row.cells].map(textOf).join(' ').toLowerCase().includes(state.query.trim().toLowerCase())&&Object.entries(state.filters).every(([i,filter])=>{const checks=filter.rules.map(rule=>matches(values.get(row)[i],rule,state.columns[i].type));return filter.operator==='any'?checks.some(Boolean):checks.every(Boolean);}));
  if(table.classList.contains('qr-table')){const selected=new Set(matched);for(const row of matched){if(row.dataset.parent){const parent=rows.find(r=>r.querySelector('[data-group]')?.dataset.group===row.dataset.parent);if(parent)selected.add(parent);}}matched=rows.filter(row=>selected.has(row));}
  const pages=Math.max(1,Math.ceil(matched.length/state.size));state.page=Math.max(1,Math.min(state.page,pages));const visible=new Set(matched.slice((state.page-1)*state.size,state.page*state.size));for(const row of rows)row.toggleAttribute('data-grid-hidden',!visible.has(row));
  let empty=table.querySelector('[data-app-empty]');if(matched.length||!rows.length){empty?.remove();}else if(!empty){empty=document.createElement('tfoot');table.append(empty);if(empty){empty.setAttribute('data-app-empty','');const cell=empty.insertRow().insertCell();cell.colSpan=state.columns.length;cell.textContent='No matching rows. Clear filters to see all loaded rows.';}}
  [...table.tHead.rows[0].cells].forEach((th,i)=>{if(i===state.sort)th.setAttribute('aria-sort',state.direction==='asc'?'ascending':'descending');else th.removeAttribute('aria-sort');const button=state.columns[i].filterButton;if(button){button.classList.toggle('active',!!state.filters[i]);button.setAttribute('aria-label','Filter '+state.columns[i].label+(state.filters[i]?' (active)':''));}});
  section.querySelector('.app-grid-count').textContent=`${matched.length?(state.page-1)*state.size+1:0}–${Math.min(state.page*state.size,matched.length)} of ${matched.length} matching rows (${rows.length} loaded)${state.sort!==null?' · '+state.columns[state.sort].label+', '+(state.direction==='asc'?'ascending':'descending'):''}`;
  section.querySelector('.app-grid-page').textContent=state.page+' / '+pages;section.querySelector('.app-grid-prev').disabled=state.page===1;section.querySelector('.app-grid-next').disabled=state.page===pages;
  state.signature=signature(state);observe();
 }
 function openFilter(state,index,trigger){
  const col=state.columns[index],saved=state.filters[index]||{operator:'all',rules:[{mode:col.type==='text'?'contains':'eq',value:''}]},dialog=document.createElement('dialog');dialog.className='grid-filter-dialog app-grid-dialog';dialog.setAttribute('aria-label','Filter '+col.label);
  dialog.innerHTML=`<form><div class="grid-dialog-heading"><h3>Filter ${esc(col.label)}</h3><button type="button" data-close aria-label="Close filter">×</button></div>${col.hint?`<p class="grid-note">${esc(col.hint)}</p>`:''}<label>Match rules<select data-operator data-autocomplete-ready="true"><option value="all">Match all</option><option value="any">Match any</option></select></label><div data-rules></div><button type="button" data-add>+ Add rule</button><div class="grid-dialog-actions"><button type="button" data-clear>Clear</button><button type="submit" class="filter-apply">Apply</button></div></form>`;
  document.body.append(dialog);dialog.querySelector('[data-operator]').value=saved.operator;
  function add(rule={mode:col.type==='text'?'contains':'eq',value:''}){const row=document.createElement('div');row.className='grid-rule';row.innerHTML=`<label>Condition<select data-mode data-autocomplete-ready="true">${[...modes[col.type],['missing','Unavailable'],['present','Available']].map(([v,t])=>`<option value="${v}">${t}</option>`).join('')}</select></label><label>Value<input data-value type="${col.type==='number'?'number':col.type==='date'?'date':'text'}" step="any" ${/invest|amount|cost value|portfolio value|profit value|market value|balance|budget|payload/i.test(col.label)?'data-private-input':''}></label><button type="button" data-remove aria-label="Remove rule">Remove</button>`;const input=row.querySelector('[data-value]'),select=row.querySelector('[data-mode]');input.value=rule.value;select.value=rule.mode;const sync=()=>{input.disabled=['missing','present'].includes(select.value);};select.onchange=sync;sync();row.querySelector('[data-remove]').onclick=()=>row.remove();dialog.querySelector('[data-rules]').append(row);}
  saved.rules.forEach(add);dialog.querySelector('[data-add]').onclick=()=>add();dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{dialog.remove();trigger.focus();});
  dialog.querySelector('[data-clear]').onclick=()=>{delete state.filters[index];state.page=1;update(state);dialog.close();};
  dialog.querySelector('form').onsubmit=e=>{e.preventDefault();const rules=[...dialog.querySelectorAll('.grid-rule')].map(row=>({mode:row.querySelector('[data-mode]').value,value:row.querySelector('[data-value]').value.trim()})).filter(r=>r.value!==''||['missing','present'].includes(r.mode));if(rules.length)state.filters[index]={operator:dialog.querySelector('[data-operator]').value,rules};else delete state.filters[index];state.page=1;update(state);dialog.close();};dialog.showModal();
 }
 function scan(){scheduled=false;observer.disconnect();legacy();document.querySelectorAll('table').forEach(enhance);for(const state of known){if(!state.table.isConnected){known.delete(state);continue;}if(signature(state)!==state.signature)update(state);}observe();}
 function schedule(){if(!scheduled){scheduled=true;queueMicrotask(scan);}}
 const observer=new MutationObserver(schedule);
 function observe(){observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','value','data-grid-value']});}
 window.AppTableGrid={refresh:schedule};scan();
})();
