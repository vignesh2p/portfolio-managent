// First-party, minute-level engagement sampling. No URLs, input contents or IPs are stored.
(function(){
 let lastInteraction=Date.now(),lastBucket=-1,lastToken=null,pending=false;
 function foreground(){
  if(document.visibilityState!=='visible'||!document.hasFocus())return false;
  // Use visibility timeline entries when supported, with Page Visibility as fallback.
  if(globalThis.PerformanceObserver?.supportedEntryTypes?.includes('visibility-state')){
   const entries=performance.getEntriesByType('visibility-state');
   if(entries.length&&entries[entries.length-1].name!=='visible')return false;
  }
  return true;
 }
 async function tick(){
  if(typeof TOKEN==='undefined'||!TOKEN||!foreground()||Date.now()-lastInteraction>60000||pending)return;
  const bucket=Math.floor(Date.now()/60000),token=TOKEN;
  if(token===lastToken&&bucket===lastBucket)return;
  pending=true;
  try{
   const response=await fetch(BASE+'/api/activity/heartbeat',{method:'POST',headers:{Authorization:'Bearer '+token}});
   if(response.ok){lastBucket=bucket;lastToken=token;}
  }catch{}finally{pending=false;}
 }
 function interact(event){if(event&&!event.isTrusted)return;lastInteraction=Date.now();tick();}
 for(const event of ['pointerdown','keydown','wheel','touchstart'])document.addEventListener(event,interact,{passive:true});
 window.addEventListener('focus',interact);
 document.addEventListener('visibilitychange',()=>{lastInteraction=document.hidden?0:Date.now();if(!document.hidden)tick();});
 setInterval(tick,30000);tick();
})();
