const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 const page=await browser.newPage();await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();const file=path.join(__dirname,'..',u.pathname==='/admin'?'admin.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});});
 for(const width of [390,768,1440]){await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/admin');await page.evaluate(async()=>{
  window.writes=[];fetchJson=async(url,options)=>{if(options){writes.push({url,body:JSON.parse(options.body)});return {success:true,data:{}};}return {success:true,data:url.includes('/search?')?[{symbol:'ABC.NS',name:'ABC Limited',exchange:'NSE'}]:[]};};await loadUniverseStockConfig();
  const input=document.getElementById('admin-stock-search');input.value='ABC';input.dispatchEvent(new Event('input'));
 });
 await page.waitForFunction(()=>document.querySelector('#admin-stock-suggestions [role=option]'));
 await page.evaluate(()=>{const input=document.getElementById('admin-stock-search');input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});
 assert.equal(await page.locator('#add-code').inputValue(),'ABC');assert.equal(await page.locator('#add-stock-code').inputValue(),'NSE:ABC');assert.equal(await page.locator('#add-yahoo-code').inputValue(),'ABC.NS');assert.equal(await page.evaluate(()=>writes.length),0);
 await page.evaluate(()=>{document.getElementById('add-code').value='MYCODE';document.getElementById('add-stock-code').value='NSE:CUSTOM';document.getElementById('universe-add').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await page.waitForFunction(()=>writes.length===1);assert.equal(await page.evaluate(()=>writes[0].body.code),'MYCODE');assert.equal(await page.evaluate(()=>writes[0].body.stock_code),'NSE:CUSTOM');console.log('Admin autocomplete prefill and manual submit verified at '+width);
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
