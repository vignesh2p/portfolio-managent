(() => {
  const menu = document.getElementById('app-navigation');
  const toggle = document.getElementById('navigation-toggle');
  function closeMenu(returnFocus = false) {
    menu?.classList.remove('is-open');
    toggle?.setAttribute('aria-expanded', 'false');
    if (returnFocus) toggle?.focus();
  }
  toggle?.addEventListener('click', () => {
    const open = menu.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  menu?.addEventListener('click', event => {
    if (event.target.closest('.side-tab')) {
      closeMenu();
      document.querySelector('.page.active .page-title')?.focus();
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu?.classList.contains('is-open')) closeMenu(true);
  });
  document.addEventListener('click', event => {
    if (menu?.classList.contains('is-open') && !menu.contains(event.target) && !toggle.contains(event.target)) closeMenu();
  });
  matchMedia('(min-width:921px)').addEventListener('change', () => closeMenu());

  const frozenTables=new WeakSet();
  function enhanceTables() {
    document.querySelectorAll('#watchlist-table .sheet-table').forEach(table=>{
      if(frozenTables.has(table))return;frozenTables.add(table);
      const first=table.querySelector('th');if(!first)return;
      const update=()=>table.style.setProperty('--frozen-index-width',first.getBoundingClientRect().width+'px');
      const resize=new ResizeObserver(()=>{if(!table.isConnected){resize.disconnect();return;}update();});resize.observe(first);update();
    });
    for (const [rowSelector, labels] of [
      ['.port-row', ['Symbol','Shares','CMP / Change','Value','P&L','XIRR']],
      ['.trades-row', ['Ticker','Type','Shares','Price','Amount','Date','Delete']]
    ]) {
      document.querySelectorAll(rowSelector).forEach(row => {
        Array.from(row.children).forEach((cell, index) => {
          if (labels[index]) cell.dataset.label = labels[index];
        });
        if (row.matches('.port-row') && !row.hasAttribute('tabindex')) {
          row.tabIndex = 0;
          row.setAttribute('role', 'button');
          row.setAttribute('aria-label', `View trade breakdown for ${row.querySelector('.ph-ticker')?.textContent || 'stock'}`);
          row.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
          });
        }
      });
    }
    document.querySelectorAll('.page-title').forEach(title => title.tabIndex = -1);
    document.querySelectorAll('.sheet-table-wrap,.preview-table-wrap,.strategy-table,.cf-table,#settings-stocks-table,.table-box').forEach(wrapper => {
      if (wrapper.dataset.responsiveReady) return;
      wrapper.dataset.responsiveReady = 'true';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      const title = wrapper.closest('.page')?.querySelector('.page-title')?.textContent || 'Data';
      wrapper.setAttribute('aria-label', `${title} table. Scroll horizontally to see all columns.`);
      const hint = document.createElement('p');
      hint.className = 'scroll-hint';
      hint.textContent = 'Swipe or scroll sideways to see all columns.';
      wrapper.before(hint);
      wrapper.querySelectorAll('thead th').forEach(th => th.scope = 'col');
    });
  }
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; enhanceTables(); });
  });
  observer.observe(document.body, { childList:true, subtree:true });
  enhanceTables();
})();

// Shared Material-style combobox: real option selection with focus kept in the input.
(() => {
  let nextId=0,opened=null;
  const widgets=new Set();
  function attach(input,source,options,pick,invalidate,restore){
    const panel=document.createElement('div');panel.className='autocomplete-panel';
    panel.id=input.id+'-panel';panel.hidden=true;panel.setAttribute('role','listbox');
    panel.setAttribute('aria-label',input.getAttribute('aria-label')||'Suggestions');
    document.body.append(panel);
    input.classList.add('autocomplete-choice');input.autocomplete='off';input.spellcheck=false;
    input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');
    input.setAttribute('aria-controls',panel.id);input.setAttribute('aria-expanded','false');
    input.setAttribute('autocorrect','off');input.setAttribute('autocapitalize','off');
    let filtered=[],active=-1,choosing=false;
    function close(){panel.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');if(opened===widget)opened=null;}
    function position(){
      if(panel.hidden)return;
      const r=input.getBoundingClientRect(),viewport=window.visualViewport;
      const top=viewport?.offsetTop||0,left=viewport?.offsetLeft||0,w=viewport?.width||innerWidth,h=viewport?.height||innerHeight;
      if(r.bottom<top||r.top>top+h){close();return;}
      const width=Math.min(r.width,w-16),below=top+h-r.bottom-8,above=r.top-top-8;
      const upward=below<160&&above>below;
      const available=Math.max(60,Math.min(288,upward?above:below));
      panel.style.width=width+'px';panel.style.maxHeight=available+'px';
      panel.style.left=Math.max(left+8,Math.min(r.left,left+w-width-8))+'px';
      panel.style.top=(upward?r.top-Math.min(panel.scrollHeight,available)-4:r.bottom+4)+'px';
    }
    function highlight(index){
      active=index;
      panel.querySelectorAll('[role=option]').forEach((el,i)=>el.classList.toggle('is-active',i===index));
      const option=panel.querySelectorAll('[role=option]')[index];
      if(option){input.setAttribute('aria-activedescendant',option.id);option.scrollIntoView({block:'nearest'});}
      else input.removeAttribute('aria-activedescendant');
    }
    function choose(option){choosing=true;pick(option);choosing=false;input.setCustomValidity('');close();}
    function show(query=''){
      if(input.disabled||!input.isConnected)return;
      if(opened&&opened!==widget)opened.close();opened=widget;
      filtered=options().filter(o=>o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
      panel.replaceChildren();
      filtered.forEach((option,i)=>{
        const row=document.createElement('div');row.className='autocomplete-option';row.id=panel.id+'-'+i;
        row.setAttribute('role','option');row.setAttribute('aria-selected',String(option.label===input.value));row.textContent=option.label;
        row.addEventListener('pointerdown',event=>{if(event.pointerType!=='touch')event.preventDefault();});
        row.addEventListener('click',()=>{choose(option);input.focus({preventScroll:true});close();});
        row.addEventListener('pointermove',()=>highlight(i));panel.append(row);
      });
      if(!filtered.length){const empty=document.createElement('div');empty.className='autocomplete-empty';empty.textContent='No matching options';panel.append(empty);}
      panel.hidden=false;input.setAttribute('aria-expanded','true');position();highlight(filtered.length?0:-1);
    }
    const widget={input,source,panel,close,position,observer:null,interacting:false};widgets.add(widget);
    panel.addEventListener('pointerdown',()=>{widget.interacting=true;});
    input.addEventListener('focus',()=>{input.select();show();});
    input.addEventListener('click',()=>{if(panel.hidden)show();});
    input.addEventListener('input',event=>{if(choosing||event.isComposing)return;invalidate();show(input.value);});
    input.addEventListener('compositionend',()=>{invalidate();show(input.value);});
    input.addEventListener('keydown',event=>{
      if(event.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();if(panel.hidden){show();if(event.key==='ArrowUp')highlight(filtered.length-1);}
        else if(filtered.length)highlight((active+(event.key==='ArrowDown'?1:-1)+filtered.length)%filtered.length);
      }else if(event.key==='Enter'&&!panel.hidden){event.preventDefault();if(active>=0)choose(filtered[active]);}
      else if(event.key==='Escape'){event.preventDefault();restore();close();}
      else if(event.key==='Tab'){restore();close();}
    });
    input.addEventListener('blur',()=>setTimeout(()=>{if(!widget.interacting&&!panel.contains(document.activeElement)){restore();close();}},150));
    return widget;
  }
  function enhanceSelect(select){
    if(select.dataset.autocompleteReady||select.multiple)return;
    select.dataset.autocompleteReady='true';
    const input=document.createElement('input'),key=select.id||'choice-'+(++nextId);
    input.id=key+'-search';input.type='text';input.className=select.className;input.style.cssText=select.style.cssText;
    input.placeholder='Type to search…';input.required=select.required;select.required=false;
    if(select.hasAttribute('form'))input.setAttribute('form',select.getAttribute('form'));
    const labels=Array.from(select.labels||[]);labels.forEach(label=>label.htmlFor=input.id);
    input.setAttribute('aria-label',select.getAttribute('aria-label')||labels.map(l=>l.textContent.trim()).join(' ')||select.previousElementSibling?.textContent.trim()||'Choose an option');
    if(select.hasAttribute('aria-describedby'))input.setAttribute('aria-describedby',select.getAttribute('aria-describedby'));
    select.hidden=true;select.style.setProperty('display','none','important');select.after(input);
    let committed=select.value;
    function sync(){committed=select.value;const option=select.selectedOptions[0];input.value=option&&(!input.required||option.value)?option.textContent.trim():'';input.disabled=select.disabled;input.setCustomValidity('');}
    const options=()=>Array.from(select.options).filter(o=>!o.disabled&&(!input.required||o.value)).map(o=>({value:o.value,label:o.textContent.trim()}));
    const setNative=value=>Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,value);
    const widget=attach(input,select,options,option=>{const changed=committed!==option.value;setNative(option.value);sync();if(changed)select.dispatchEvent(new Event('change',{bubbles:true}));},()=>{setNative('');input.setCustomValidity('Choose an option from the suggestions.');},()=>{setNative(committed);sync();});
    for(const property of ['value','selectedIndex']){const d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,property);Object.defineProperty(select,property,{configurable:true,get(){return d.get.call(this);},set(v){d.set.call(this,v);sync();}});}
    select.addEventListener('change',sync);select.form?.addEventListener('reset',()=>setTimeout(sync,0));
    widget.observer=new MutationObserver(()=>{sync();widget.close();});widget.observer.observe(select,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['disabled','selected','label','value']});sync();
  }
  function enhanceDatalist(input){
    if(input.dataset.autocompleteReady)return;
    const list=document.getElementById(input.getAttribute('list'));if(!list)return;
    input.dataset.autocompleteReady='true';input.removeAttribute('list');if(!input.id)input.id='stock-choice-'+(++nextId);
    if(!input.getAttribute('aria-label'))input.setAttribute('aria-label',input.previousElementSibling?.textContent.trim()||input.placeholder||'Stock');
    let saved=input.value;
    attach(input,input,()=>Array.from(list.options).map(o=>({value:o.value,label:o.value})),option=>{input.value=option.value;saved=option.value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},()=>{},()=>{if(!Array.from(list.options).some(o=>o.value===input.value)){input.value=saved;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}else saved=input.value;});
  }
  function scan(){
    widgets.forEach(w=>{if(!w.source.isConnected){w.close();w.panel.remove();w.observer?.disconnect();widgets.delete(w);}});
    document.querySelectorAll('select').forEach(enhanceSelect);document.querySelectorAll('input[list]').forEach(enhanceDatalist);
  }
  document.addEventListener('pointerdown',event=>{if(opened&&event.target!==opened.input&&!opened.panel.contains(event.target))opened.close();});
  document.addEventListener('pointerup',()=>{if(opened)opened.interacting=false;});
  document.addEventListener('pointercancel',()=>{if(opened)opened.interacting=false;});
  document.addEventListener('scroll',()=>opened?.position(),true);window.addEventListener('resize',()=>opened?.position());
  window.visualViewport?.addEventListener('resize',()=>opened?.position());
  new MutationObserver(scan).observe(document.body,{childList:true,subtree:true});scan();
})();

