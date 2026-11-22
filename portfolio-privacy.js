'use strict';
// Display privacy only: calculations and API data always retain their real values.
(() => {
  const key='pf_hide_amounts', originals=new WeakMap(), inputStates=new WeakMap();
  let hidden=false;
  try { hidden=localStorage.getItem(key)==='true'; } catch {}
  const currency= /[+−-]?₹\s*[+−-]?\s*\d[\d,]*(?:\.\d+)?/g;
  const excluded=element=>element?.closest('script,style,textarea,[data-public-price]');
  // Grid comparisons use the underlying text, even while display amounts are masked.
  window.readPrivateDisplayText=function read(node){
    if(node.nodeType===Node.TEXT_NODE){const saved=originals.get(node)?.text;return saved&&node.nodeValue===saved.masked?saved.original:node.nodeValue;}
    return Array.from(node.childNodes,read).join(' ');
  };

  function maskValue(node,slot,value,write){
    let saved=originals.get(node);
    if(!saved){saved={};originals.set(node,saved);}
    const prior=saved[slot];
    const original=prior&&value===prior.masked?prior.original:value;
    const masked=hidden?original.replace(currency,'••••'):original;
    saved[slot]={original,masked};
    if(value!==masked)write(masked);
  }
  function visit(root){
    if(root.nodeType===Node.TEXT_NODE){
      if(!excluded(root.parentElement))maskValue(root,'text',root.nodeValue,value=>{root.nodeValue=value;});
      return;
    }
    if(root.nodeType!==Node.ELEMENT_NODE||excluded(root))return;
    for(const attr of ['title','aria-label'])if(root.hasAttribute(attr)){
      maskValue(root,attr,root.getAttribute(attr),value=>root.setAttribute(attr,value));
    }
    if(root.matches('input[data-private-input]')){
      if(hidden&&!inputStates.has(root)){
        inputStates.set(root,{type:root.type,readOnly:root.readOnly});
        root.type='password';root.readOnly=true;
      }else if(!hidden&&inputStates.has(root)){
        const state=inputStates.get(root);root.type=state.type;root.readOnly=state.readOnly;inputStates.delete(root);
      }
    }
    for(const child of root.childNodes)visit(child);
  }
  const options={subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','data-public-price']};
  const observer=new MutationObserver(records=>{
    observer.disconnect();
    // Mutations are processed before paint, including views opened after hiding.
    const roots=new Set(records.map(r=>r.target));
    for(const root of roots)if(root.isConnected)visit(root);
    observer.observe(document.body,options);
  });
  function render(){
    observer.disconnect();
    document.documentElement.classList.toggle('amounts-hidden',hidden);
    const button=document.getElementById('privacy-toggle');
    const label=hidden?'Show amounts':'Hide amounts';
    button.setAttribute('aria-label',label);
    button.setAttribute('aria-pressed',String(hidden));
    button.title=label+' throughout the app';
    document.getElementById('privacy-toggle-label').textContent=label;
    visit(document.body);
    observer.observe(document.body,options);
  }
  document.getElementById('privacy-toggle').addEventListener('click',()=>{
    hidden=!hidden;
    try {localStorage.setItem(key,String(hidden));}catch{}
    render();
  });
  window.addEventListener('storage',event=>{
    if(event.key===key){hidden=event.newValue==='true';render();}
  });
  render();
})();
