const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const holdings=Array.from({length:27},(_,i)=>({ticker:'STOCK'+String(i).padStart(2,'0'),shares:i+1,avg_price:100,trades:[]}));
 const prices=Object.fromEntries(holdings.map((h,i)=>[h.ticker,i===26?null:{price:80+i*5,name:'Company '+i,changePct:i-10,prevClose:100}]));
 await page.route('**/*',route=>{
 const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
 if(u.pathname.startsWith('/api/')){let json={success:true,data:[]};if(u.pathname==='/api/portfolio')json={success:true,data:{holdings,prices,xirr_eligible:false}};if(u.pathname==='/api/sip-config')json={success:true,data:{max_budget:50000,levels:[]}};return route.fulfill({json});}
 const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('https://onepiece.test/');await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});await page.waitForSelector('.holdings-grid');
 const visible=()=>page.locator('#port-rows tr:not([hidden])');
 assert.equal(await visible().count(),10);assert.match(await page.locator('#grid-count').innerText(),/1–10 of 27/);
 await page.locator('#grid-next').click();assert.match(await visible().first().innerText(),/STOCK10/);
 await page.locator('#grid-size').selectOption('25');assert.equal(await visible().count(),25);
 await page.locator('[data-sort="shares"]').click();await page.locator('[data-sort="shares"]').click();assert.match(await visible().first().innerText(),/STOCK26/);assert.equal(await page.locator('th[aria-sort]').count(),1);
 await page.locator('#grid-search').fill('company 12');assert.equal(await visible().count(),1);assert.match(await visible().first().innerText(),/STOCK12/);
 await page.locator('#grid-clear').click();
 // Numeric rule uses real numbers, and adding a second rule creates an inclusive range.
 await page.locator('[data-filter="shares"]').click();await page.locator('[data-mode]').selectOption('gte');await page.locator('[data-value]').fill('5');await page.locator('#filter-add').click();await page.locator('[data-mode]').nth(1).selectOption('lte');await page.locator('[data-value]').nth(1).fill('8');await page.locator('.filter-apply').click();assert.equal(await visible().count(),4);
 // Cancel leaves the committed filter intact and restores focus.
 await page.locator('[data-filter="shares"]').click();await page.locator('[data-value]').first().fill('100');await page.keyboard.press('Escape');assert.equal(await visible().count(),4);assert.equal(await page.locator('[data-filter="shares"]').evaluate(e=>e===document.activeElement),true);
 await page.locator('[data-filter="shares"]').click();await page.locator('#filter-operator').selectOption('any');await page.locator('[data-mode]').first().selectOption('eq');await page.locator('[data-value]').first().fill('1');await page.locator('[data-mode]').nth(1).selectOption('eq');await page.locator('[data-value]').nth(1).fill('27');await page.locator('.filter-apply').click();assert.equal(await visible().count(),2);
 await page.locator('#grid-clear').click();await page.locator('[data-filter="price"]').click();await page.locator('[data-mode]').selectOption('missing');await page.locator('.filter-apply').click();assert.equal(await visible().count(),1);assert.match(await visible().first().innerText(),/STOCK26/);
 await page.locator('#grid-clear').click();await page.locator('#grid-search').fill('no match');assert.equal(await visible().count(),0);assert.equal(await page.locator('#grid-empty').isVisible(),true);
 await page.locator('#grid-clear').click();await page.locator('#grid-size').selectOption('10');await page.getByRole('button',{name:'Hide amounts',exact:true}).click();
 await page.locator('[data-sort="value"]').click();await page.locator('[data-sort="value"]').click();assert.equal(await visible().first().getAttribute('data-holding'),'STOCK25');assert.match(await page.locator('#ph-value-STOCK25').innerText(),/••••/);assert.match(await page.locator('#ph-cmp-STOCK25').innerText(),/205/);
 assert.match(await visible().first().innerText(),/105.00%/);
 await page.locator('[data-filter="cost"]').click();assert.equal(await page.locator('[data-value]').getAttribute('type'),'password');await page.keyboard.press('Escape');
 await page.evaluate(()=>loadPortfolio());assert.equal(await visible().first().getAttribute('data-holding'),'STOCK25');assert.match(await page.locator('#ph-value-STOCK25').innerText(),/••••/);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Show amounts',exact:true}).click();assert.match(await page.locator('#ph-value-STOCK25').innerText(),/5,330/);
 await page.locator('[data-sort="shares"]').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('th[data-column="shares"]').getAttribute('aria-sort'),'ascending');
 await page.evaluate(()=>{window.openedTicker=null;showXIRR=ticker=>{window.openedTicker=ticker;};});await visible().first().locator('[data-stock]').click();assert.equal(await page.evaluate(()=>window.openedTicker),'STOCK00');
 fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'test-artifacts',`portfolio-grid-${width}.png`),fullPage:true});
 assert.deepEqual(errors,[]);await page.close();console.log('Portfolio advanced grid passed at '+width+'px');
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
