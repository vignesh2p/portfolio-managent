const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 const page=await browser.newPage();
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();const file=path.join(__dirname,'..',u.pathname==='/admin'?'admin.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});});
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/admin');
  await page.evaluate(async()=>{
   window.calls=[];window.stocks=['GOOD','BAD','OUTAGE'].map((code,i)=>({ticker:code,stock_code:'NSE:'+code,code,name:code+' stock',yahoo_finance_code:code+'.NS'}));
   fetchJson=async(url,options)=>{calls.push({url,options});if(url.endsWith('/validate-yahoo'))return {success:true,data:JSON.parse(options.body).codes.map(code=>({code,status:code==='BAD.NS'?'invalid':code==='OUTAGE.NS'?'unavailable':'valid',message:code==='BAD.NS'?'Invalid Yahoo code':'Checked'}))};if(options?.method==='PUT')return {success:true,data:JSON.parse(options.body)};return {success:true,data:stocks};};
   await loadUniverseStockConfig();
  });
  await page.evaluate(()=>document.getElementById('universe-validate-yahoo').click());
  await page.waitForFunction(()=>document.getElementById('universe-message').textContent.includes('Validation complete'));
  assert.equal(await page.locator('#universe-rows tr').first().getAttribute('data-index'),'1');
  assert.equal(await page.locator('.yahoo-code-invalid').count(),1);
  assert.equal(await page.locator('#universe-yahoo_finance_code-1').getAttribute('aria-invalid'),'true');
  assert.equal(await page.locator('#universe-yahoo_finance_code-2').getAttribute('aria-invalid'),'false');
  assert.match(await page.locator('#universe-message').textContent(),/1 valid, 1 invalid, 1 could not be checked/);
  await page.evaluate(()=>{const input=document.getElementById('universe-yahoo_finance_code-1');input.value='FIXED.NS';input.dispatchEvent(new Event('input'));});
  assert.equal(await page.locator('.yahoo-code-invalid').count(),0);
  await page.evaluate(()=>document.querySelector('#universe-form-1 button').click());
  await page.waitForFunction(()=>document.getElementById('universe-message').textContent.startsWith('Saved'));
  assert.equal(await page.evaluate(()=>JSON.parse(calls.find(c=>c.options?.method==='PUT').options.body).yahoo_finance_code),'FIXED.NS');
  await page.evaluate(()=>{const search=document.getElementById('universe-search');search.value='GOOD';search.dispatchEvent(new Event('input'));document.getElementById('universe-validate-yahoo').click();});
  await page.waitForFunction(()=>document.getElementById('universe-message').textContent.includes('Validation complete'));
  assert.deepEqual(await page.evaluate(()=>JSON.parse(calls.filter(c=>c.url.endsWith('/validate-yahoo')).at(-1).options.body).codes),['GOOD.NS']);
  console.log('Validation, invalid-first sorting, edit/save, and visible-row filtering verified at '+width);
 }
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exit(1)});
