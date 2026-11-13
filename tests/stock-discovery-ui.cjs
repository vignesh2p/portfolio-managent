const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 const page=await browser.newPage();await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();const file=path.join(__dirname,'..',u.pathname==='/'?'onepiece.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});});
 for(const width of [390,768,1440]){await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/');await page.evaluate(async()=>{
  window.searchCalls=0;api=async url=>{if(url.includes('/search?'))window.searchCalls++;return {success:true,data:url.includes('/search?')?[{symbol:'ABC.NS',name:'ABC Limited',exchange:'NSE'}]:[{ticker:'LOCAL',name:'Local Limited',code:'LOCAL'}]};};userWatchlists=[{id:1,slot:1,name:'Default watchlist'}];await openWatchlistEditor(false);
  document.getElementById('watchlist-search').value='Local';filterWatchlistChoices();
 });
 assert.equal(await page.evaluate(()=>window.searchCalls),0);
 await page.evaluate(()=>{document.getElementById('watchlist-search').value='ABC';filterWatchlistChoices();});
 await page.waitForFunction(()=>document.querySelector('#stock-search-results [role=option]')?.textContent.includes('ABC Limited'));
 await page.evaluate(()=>stockSearchKeydown({key:'ArrowDown',preventDefault(){}}));
 assert.equal(await page.locator('#watchlist-search').getAttribute('aria-activedescendant'),'stock-suggestion-0');
 await page.evaluate(()=>stockSearchKeydown({key:'Enter',preventDefault(){}}));
 assert.equal(await page.locator('#watchlist-choices input:checked').count(),1);assert.equal(await page.locator('#watchlist-choices input:checked').getAttribute('data-discovered'),'true');
 console.log('Search/select flow verified at '+width);
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
