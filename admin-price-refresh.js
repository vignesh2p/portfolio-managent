(() => {
  const button=document.getElementById('refresh-prices-btn');
  const status=document.getElementById('price-refresh-status');
  const details=document.getElementById('price-refresh-errors');
  const errors=document.getElementById('price-refresh-error-list');
  let running=false;
  button.addEventListener('click',async()=>{
    if(running)return;
    running=true;button.disabled=true;button.textContent='Refreshing prices…';
    details.hidden=true;errors.replaceChildren();
    let after='',updated=0,failed=0,processed=0;
    status.textContent='Fetching the latest prices for the OnePiece universe. Keep this page open.';
    try{
      do{
        const result=await fetchJson('/api/admin/prices/refresh',{method:'POST',body:JSON.stringify({after})});
        if(!result.success)throw new Error(result.error||'Unable to refresh prices.');
        updated+=result.successful;failed+=result.failed;processed+=result.total;
        for(const item of result.errors||[]){
          const li=document.createElement('li');li.textContent=item.ticker+': '+item.error;errors.appendChild(li);
        }
        details.hidden=failed===0;
        status.textContent=processed+' stocks processed: '+updated+' updated, '+failed+' failed.';
        after=result.next;
      }while(after!==null);
      status.textContent=processed===0?'The OnePiece stock universe is empty.':'Refresh complete: '+updated+' updated, '+failed+' failed.'+(failed?' Failed stocks retain their last saved prices.':'');
      // Refresh the visible table without replacing the refresh result above it.
      if(typeof refreshCurrentTable==='function')await refreshCurrentTable();
    }catch(error){
      status.textContent='Refresh stopped: '+error.message+' '+updated+' updated, '+failed+' failed so far. You can retry; saved updates are retained.';
    }finally{
      running=false;button.disabled=false;button.textContent='Refresh all prices now';
    }
  });
})();
