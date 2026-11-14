const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 const page=await browser.newPage();
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();const file=path.join(__dirname,'..',u.pathname==='/'?'onepiece.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});});
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/');
  await page.evaluate(()=>{
   window.requests=[];api=async(url,options)=>{requests.push({url,options});if(url.includes('/search?'))return {success:true,data:[{symbol:'ABC.NS',name:'ABC Limited',exchange:'NSE'}]};if(url==='/api/trades'&&options)return {success:true};return {success:true,data:[]};};
   document.querySelectorAll('.page').forEach(el=>el.style.display='none');document.getElementById('tab-trades').style.display='block';document.getElementById('app-screen').style.display='block';
  });
  await page.locator('#t-stock-name').pressSequentially('ABC');
  await page.waitForFunction(()=>document.querySelector('#t-stock-options [role=option]')?.textContent.includes('ABC.NS'));
  assert.equal(await page.locator('#t-stock-options [role=option]').isVisible(),true);
  await page.locator('#t-stock-name').press('Backspace');
  await page.waitForFunction(()=>requests.some(r=>r.url==='/api/stocks/search?q=AB'));
  await page.waitForFunction(()=>document.querySelector('#t-stock-options [role=option]'));
  await page.locator('#t-stock-name').fill('');
  assert.equal(await page.locator('#t-stock-options [role=option]').count(),0);
  assert.equal(await page.locator('#trade-search-status').textContent(),'');
  await page.locator('#t-stock-name').pressSequentially('ABC');
  await page.waitForFunction(()=>document.querySelector('#t-stock-options [role=option]'));
  await page.locator('#t-stock-name').press('ArrowDown');
  await page.locator('#t-stock-name').press('Enter');
  assert.equal(await page.locator('#trade-search-status').textContent(),'');
  assert.equal(await page.locator('#t-stock-name').getAttribute('aria-expanded'),'false');
  assert.equal(await page.locator('#t-yahoo-code').inputValue(),'ABC.NS');
  assert.equal(await page.locator('#t-ticker').isVisible(),false);
  assert.equal(await page.locator('#t-yahoo-code').isVisible(),false);
  await page.locator('#t-stock-name').fill('Unselected');
  assert.equal(await page.locator('#t-ticker').inputValue(),'');
  assert.equal(await page.locator('#t-yahoo-code').inputValue(),'');
  await page.evaluate(()=>{window.alerts=[];window.alert=message=>alerts.push(message);});
  await page.evaluate(()=>addTrade());
  assert.equal(await page.evaluate(()=>alerts[0]),'Select a stock from the search results.');
  assert.equal(await page.evaluate(()=>requests.some(r=>r.url==='/api/trades'&&r.options)),false);
  await page.locator('#t-stock-name').fill('ABC Limited — ABC.NS');
  await page.locator('#t-shares').fill('5');await page.locator('#t-price').fill('80');
  await page.evaluate(()=>addTrade());
  const payload=await page.evaluate(()=>JSON.parse(requests.find(r=>r.url==='/api/trades'&&r.options).options.body));
  assert.equal(payload.ticker,'NSE:ABC');assert.equal(payload.yahoo_finance_code,'ABC.NS');
  await page.evaluate(()=>{window.pendingSearches={};api=url=>new Promise(resolve=>{pendingSearches[url]=resolve;});});
  await page.locator('#t-stock-name').fill('Old');
  await page.waitForFunction(()=>pendingSearches['/api/stocks/search?q=Old']);
  await page.locator('#t-stock-name').fill('New');
  await page.waitForFunction(()=>pendingSearches['/api/stocks/search?q=New']);
  await page.evaluate(()=>pendingSearches['/api/stocks/search?q=New']({success:true,data:[{symbol:'NEW.BO',name:'New stock'}]}));
  await page.waitForFunction(()=>document.getElementById('t-stock-options').textContent.includes('NEW.BO'));
  await page.evaluate(()=>pendingSearches['/api/stocks/search?q=Old']({success:true,data:[{symbol:'OLD.NS',name:'Old stock'}]}));
  assert.equal(await page.locator('#t-stock-options').textContent(),'New stock — NEW.BO');
  await page.locator('#t-stock-options [role=option]').click();
  assert.equal(await page.locator('#t-ticker').inputValue(),'BSE:NEW');
  assert.equal(await page.locator('#trade-search-status').textContent(),'');
  await page.locator('#t-stock-name').fill('Pending');
  await page.waitForFunction(()=>pendingSearches['/api/stocks/search?q=Pending']);
  await page.locator('#t-stock-name').fill('');
  await page.evaluate(()=>pendingSearches['/api/stocks/search?q=Pending']({success:true,data:[{symbol:'LATE.NS',name:'Late stock'}]}));
  assert.equal(await page.locator('#t-stock-options [role=option]').count(),0);
  assert.equal(await page.locator('#t-yahoo-code').inputValue(),'');
  await page.evaluate(async()=>{
   api=async url=>{requests.push({url});return {success:true,data:url.includes('/search?')?[{symbol:'ABC.NS',name:'ABC Yahoo',exchange:'NSE'}]:[{ticker:'LOCAL',name:'ABC Local',code:'L',stock_code:'NSE:LOCAL'}]};};
   userWatchlists=[{id:1,slot:1,name:'Default'}];await openWatchlistEditor(false);document.getElementById('watchlist-search').value='ABC';filterWatchlistChoices();
  });
  await page.waitForFunction(()=>document.getElementById('stock-search-results').textContent.includes('ABC Yahoo'));
  assert.ok(await page.locator('#stock-search-results').textContent().then(s=>!s.includes('ABC Local')));
  console.log('Yahoo search, automatic codes, stale selection prevention, and Yahoo-only watchlist results verified at '+width);
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});

