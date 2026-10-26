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
  await page.locator('#t-stock-name').fill('ABC');
  await page.waitForFunction(()=>document.querySelector('#t-stock-options option')?.value.includes('ABC.NS'));
  await page.locator('#t-stock-name').fill('ABC Limited — ABC.NS');
  assert.equal(await page.locator('#t-yahoo-code').inputValue(),'ABC.NS');
  await page.locator('#t-ticker').fill('MY-ABC');await page.locator('#t-shares').fill('5');await page.locator('#t-price').fill('80');
  await page.evaluate(()=>addTrade());
  const payload=await page.evaluate(()=>JSON.parse(requests.find(r=>r.url==='/api/trades'&&r.options).options.body));
  assert.equal(payload.ticker,'MY-ABC');assert.equal(payload.yahoo_finance_code,'ABC.NS');
  await page.evaluate(async()=>{
   api=async url=>{requests.push({url});return {success:true,data:url.includes('/search?')?[{symbol:'ABC.NS',name:'ABC Yahoo',exchange:'NSE'}]:[{ticker:'LOCAL',name:'ABC Local',code:'L',stock_code:'NSE:LOCAL'}]};};
   userWatchlists=[{id:1,slot:1,name:'Default'}];await openWatchlistEditor(false);document.getElementById('watchlist-search').value='ABC';filterWatchlistChoices();
  });
  await page.waitForFunction(()=>document.getElementById('stock-search-results').textContent.includes('ABC Yahoo'));
  assert.ok(await page.locator('#stock-search-results').textContent().then(s=>s.includes('ABC Local')));
  console.log('Yahoo search, editable ticker, and local + Yahoo watchlist results verified at '+width);
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});

