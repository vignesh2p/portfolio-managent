const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let pending,mode='ready',requests=0,individual=0;
  const data={holdings:[{ticker:'TEST',shares:10,avg_price:100,trades:[],tradeCount:0}],prices:{TEST:{price:120,name:'Test Stock',prevClose:110,changePct:9.09,quote_fetched_at:'2026-11-14T08:00:00Z'}},xirr_eligible:true,xirr_pct:20};
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/portfolio'){
     requests++;
     if(mode==='ready')await new Promise(resolve=>{pending=resolve;});
     if(mode==='network')return route.abort();
     json=mode==='error'?{success:false,error:'Quotes unavailable'}:{success:true,data:mode==='empty'?{holdings:[],prices:{}}:mode==='missing'?{...data,prices:{}}:data};
    }
    if(u.pathname.startsWith('/api/price/'))individual++;
    if(u.pathname==='/api/user-settings')json={success:true,data:{target_growth_pct:30,ath_age_days:365,replacement_ath_age_days:100,max_budget:50000,levels:[]}};
    if(u.pathname==='/api/sip-config')json={success:true,data:{max_budget:50000,levels:[]}};
    if(u.pathname==='/api/portfolio-history')json={success:true,data:[{snapshot_date:'2026-11-14',portfolio_value:1200,cost_value:1000,profit_value:200,day_change:100,day_change_pct:9.09,missing_prices:0,stale_prices:0}]};
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');
  await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  await page.waitForFunction(()=>document.querySelector('#portfolio-holdings').getAttribute('aria-busy')==='true');
  assert.equal(await page.locator('#portfolio-holdings .spinner').count(),1);
  assert.equal(await page.locator('#port-summary').innerText(),'');
  assert.equal(requests,1);pending();
  await page.waitForFunction(()=>document.querySelector('#portfolio-holdings').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#portfolio-holdings .spinner').count(),0);
  assert.match(await page.locator('#sv-value').innerText(),/1,200/);
  assert.match(await page.locator('#sv-pnl').innerText(),/200.*20.00%/);
  assert.equal(individual,0);
  await page.getByRole('button',{name:'Hide amounts',exact:true}).click();
  assert.match(await page.locator('#sv-value').innerText(),/••••/);
  assert.doesNotMatch(await page.locator('#sv-value').innerText(),/1,200|100/);
  assert.match(await page.locator('#sv-pnl').innerText(),/••••.*20.00%/);
  assert.match(await page.locator('#ph-cmp-TEST').innerText(),/120/);
  assert.equal(await page.locator('#set-budget').getAttribute('type'),'password');
  assert.equal(await page.locator('#set-budget').inputValue(),'50000');
  // Refreshes and new views stay private; original values restore after changes.
  mode='immediate';await page.evaluate(()=>loadPortfolio());
  assert.match(await page.locator('#sv-cost').innerText(),/••••/);
  await page.locator('#portfolio-tab-history').click();
  await page.waitForSelector('.history-chart');
  assert.equal(await page.locator('.history-chart svg').isVisible(),false);
  assert.match(await page.locator('.history-legend').innerText(),/••••/);
  assert.doesNotMatch(await page.locator('.history-chart title').allTextContents().then(t=>t.join(' ')),/₹/);
  // Prices and quantities in dynamically rendered Beta remain visible.
  await page.evaluate(()=>renderOpportunityBeta({levels:[{fall:-10,allocation:10}],rows:[{ticker:'TEST',name:'Test',price:120,ath:150,days_since:10,max_budget:50000,levels:[{active:true,fall:-10,allocation:10,allocated_amount:5000,cumulative_allocation:5000,suggested_investment:5000,suggested_quantity:41,total_invested:1000,triggerPrice:135}]}]}));
  assert.match(await page.locator('#beta-table').textContent(),/₹120.*₹150/);
  assert.match(await page.locator('#beta-table').textContent(),/41 Shares/);
  assert.doesNotMatch(await page.locator('#beta-table').textContent(),/50,000|5,000|1,000/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-artifacts',`portfolio-private-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'Show amounts',exact:true}).click();
  assert.match(await page.locator('#sv-cost').textContent(),/1,000/);
  assert.match(await page.locator('#beta-table').textContent(),/50,000/);
  assert.equal(await page.locator('.history-chart svg').isVisible(),true);
  assert.equal(await page.locator('#set-budget').getAttribute('type'),'number');
  await page.getByRole('button',{name:'Hide amounts',exact:true}).click();
  await page.reload();await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  await page.waitForSelector('#sv-value');assert.match(await page.locator('#sv-value').innerText(),/••••/);
  await page.getByRole('button',{name:'Show amounts',exact:true}).click();
  mode='missing';await page.evaluate(()=>loadPortfolio());
  assert.equal(await page.locator('#sv-value').innerText(),'Unavailable');
  assert.equal(await page.locator('#sv-pnl').innerText(),'Unavailable');
  assert.match(await page.locator('#price-status').innerText(),/1 unavailable/);
  mode='error';await page.evaluate(()=>loadPortfolio());assert.match(await page.locator('#port-table').innerText(),/Quotes unavailable/);
  assert.equal(await page.locator('#portfolio-holdings .spinner').count(),0);
  mode='network';await page.evaluate(()=>loadPortfolio());assert.match(await page.locator('#port-table').innerText(),/Retry/i);
  mode='empty';await page.evaluate(()=>loadPortfolio());assert.match(await page.locator('#port-table').innerText(),/No current holdings/);
  assert.equal(await page.locator('#sv-cost').innerText(),'₹0');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Portfolio batch loading and privacy checks passed at mobile and desktop widths.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
