const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let mode='ready';
  const rows=[{snapshot_date:'2026-11-03',portfolio_value:11000,cost_value:10000,profit_value:1000,day_change:100,day_change_pct:1,missing_prices:0,stale_prices:0},{snapshot_date:'2026-11-04',portfolio_value:9500,cost_value:10000,profit_value:-500,day_change:-1500,day_change_pct:-13.64,missing_prices:0,stale_prices:1},{snapshot_date:'2026-11-05',portfolio_value:12500,cost_value:11000,profit_value:1500,missing_prices:0,stale_prices:0}];
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/portfolio')json={success:true,data:{holdings:[],xirr_eligible:false}};
    if(u.pathname==='/api/sip-config')json={success:true,data:{max_budget:50000,levels:[]}};
    if(u.pathname==='/api/portfolio-history')json=mode==='error'?{success:false,error:'History unavailable'}:{success:true,data:mode==='empty'?[]:rows};
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');
  await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  await page.locator('#portfolio-tab-history').click();
  await page.waitForSelector('#portfolio-history svg');
  assert.equal(await page.locator('#portfolio-history svg').count(),1);
  assert.equal(await page.locator('.history-area').count(),3);
  assert.match(await page.locator('.history-legend').innerText(),/Cost value:.*11,000/);
  assert.equal(await page.locator('path[stroke="#fbbf24"][stroke-dasharray="3 4"]').count(),1);
  assert.equal(await page.locator('circle title').filter({hasText:'Cost value:'}).count(),3);
  assert.match(await page.locator('.history-details').innerText(),/Daily profit\/loss/);
  assert.equal(await page.locator('.history-details tbody tr').count(),3);
  assert.match(await page.locator('.history-details').innerText(),/older prices/);
  assert.equal(await page.locator('.history-pnl.up').count(),1);assert.equal(await page.locator('.history-pnl.down').count(),1);assert.match(await page.locator('.history-details').innerText(),/Unavailable/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});
  await page.screenshot({path:path.join(root,'test-artifacts',`portfolio-history-${width}.png`),fullPage:true});
  await page.locator('#portfolio-tab-history').focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#portfolio-tab-holdings').getAttribute('aria-selected'),'true');
  await page.keyboard.press('End');assert.equal(await page.locator('#portfolio-tab-history').getAttribute('aria-selected'),'true');
  await page.evaluate(()=>{
   const target=document.getElementById('sv-value');target.textContent='₹1,100';
   renderPortfolioDayChange(target,[{ticker:'A',shares:10}],{A:{price:110,prevClose:100}},true);
  });
  assert.match(await page.locator('.portfolio-day-change').innerText(),/↑.*10.00%/);assert.equal(await page.locator('.portfolio-day-change.up').count(),1);
  await page.evaluate(()=>{const target=document.getElementById('sv-value');target.textContent='₹900';renderPortfolioDayChange(target,[{ticker:'A',shares:10}],{A:{price:90,prevClose:100}},true);});
  assert.match(await page.locator('.portfolio-day-change').innerText(),/↓.*-10.00%/);assert.equal(await page.locator('.portfolio-day-change.down').count(),1);
  mode='empty';await page.getByRole('button',{name:'Refresh history'}).click();await page.waitForFunction(()=>document.getElementById('portfolio-history-content').textContent.includes('No saved snapshots'));
  mode='error';await page.getByRole('button',{name:'Refresh history'}).click();await page.waitForSelector('#portfolio-history-content [role=alert]');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Portfolio history UI passed: desktop/mobile, charts, keyboard tabs, arrows, empty and error states.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
