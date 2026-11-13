const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const {opportunityGroups}=require('../rebalancing');
const source={ticker:'OLD',name:'Old Company',code:'OLD',shares:10,price:100,xirr_pct:12,invested_amount:500,market_value:1000,ath_date:'2024-01-01',days_since:900};
const buys=[{ticker:'HELD',name:'Held Company',code:'HELD',price:50,fall:-10,allocation:50,in_portfolio:true},{ticker:'HELD2',name:'Second Held Company',code:'HELD2',price:100,fall:-30,allocation:50,in_portfolio:true},{ticker:'NEW',name:'New Company',code:'NEW',price:50,shares:10,fall:-30,allocation:50},{ticker:'OTHER',name:'Other Company',code:'OTHER',price:100,shares:5,fall:-10,allocation:50}];
buys.forEach(b=>{b.suggested_investment=200;b.suggested_quantity=Math.floor(200/b.price);});
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 for(const width of [390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];let writes=0,payload,targetGrowth=30;
  page.on('pageerror',e=>errors.push(e.stack));
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/rebalancing'){
     if(route.request().method()==='POST'){writes++;payload=route.request().postDataJSON();json={success:true,data:{trade_ids:[1,2,3]}};}
     else json={success:true,data:{target_growth_pct:targetGrowth,sources:source.xirr_pct<targetGrowth?[source]:[],source,candidates:buys,opportunities:opportunityGroups(buys,source.market_value),combinations:[{buys,total:1000,remaining:0}],date:'2026-10-25'}};
    }
    if(u.pathname==='/api/growth-target'){if(route.request().method()==='PUT')targetGrowth=route.request().postDataJSON().target_growth_pct;json={success:true,data:{target_growth_pct:targetGrowth}};}
    if(u.pathname==='/api/sip-config')json={success:true,data:{max_budget:50000,levels:[{fall:-10,allocation:50},{fall:-30,allocation:50}]}};
    if(u.pathname==='/api/portfolio')json={success:true,data:{holdings:[],xirr_eligible:false}};
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');
  await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  await page.locator('#portfolio-tab-rebalancing').click();
  await page.getByRole('button',{name:'Rebalance',exact:true}).click();
  await page.waitForSelector('#rebalance-body table');
  assert.equal(await page.locator('#portfolio-tab-rebalancing').innerText(),'Rebalance Losers');
  assert.equal(await page.locator('#rebalance-body input, #rebalance-body form').count(),0);
  const inside=page.getByRole('tab',{name:'Rebalance Inside portfolio',exact:true});
  const fresh=page.getByRole('tab',{name:'Rebalance with new opportunities',exact:true});
  const panel=()=>page.locator('#rebalance-dialog').getByRole('tabpanel');
  assert.equal(await inside.getAttribute('aria-selected'),'true');
  assert.equal(await panel().getByRole('columnheader',{name:'Beta suggested investment',exact:true}).count(),2);
  assert.equal(await panel().locator('tbody tr').first().locator('td').last().innerText(),'4');
  assert.match(await panel().innerText(),/Held Company/);assert.doesNotMatch(await panel().innerText(),/New Company/);
  assert.match(await panel().innerText(),/-10% SIP level/);assert.match(await panel().innerText(),/-30% SIP level/);
  await fresh.click();assert.match(await panel().innerText(),/New Company/);assert.doesNotMatch(await panel().innerText(),/Held Company/);
  assert.match(await panel().innerText(),/Suggested multi-stock combinations/);
  await page.keyboard.press('ArrowLeft');assert.equal(await inside.getAttribute('aria-selected'),'true');
  assert.equal(await inside.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('End');assert.equal(await fresh.getAttribute('aria-selected'),'true');
  await page.screenshot({path:path.join(root,'test-artifacts','rebalance-tabs-'+width+'.png'),fullPage:true});
  await page.evaluate(()=>{rebalanceProposal.opportunities.portfolio={candidates:[],combinations:[]};renderRebalanceChoices();});
  await inside.click();assert.match(await panel().innerText(),/No affordable stocks inside your portfolio/);
  await fresh.click();assert.match(await panel().innerText(),/New Company/);
  assert.match(await page.locator('#rebalance-body').innerText(),/Suggested multi-stock combinations/);
  assert.equal(await page.locator('#rebalance-table th').filter({hasText:'ATH Drop %'}).count(),1);
  const box=await page.locator('#rebalance-dialog').boundingBox();assert.ok(box.width<=width&&box.x>=0);
  assert.equal(await page.locator('#rebalance-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#rebalance-dialog').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#rebalance-table th').filter({hasText:'XIRR %'}).count(),1);
  assert.match(await page.locator('#rebalance-description').innerText(),/30%/);
  await page.evaluate(()=>switchTab('settings'));await page.waitForFunction(()=>document.getElementById('growth-target-message').textContent==='');
  assert.equal(await page.locator('#set-target-growth').inputValue(),'30');
  const strategy=page.getByRole('tab',{name:'Portfolio Allocation Strategy',exact:true}),override=page.getByRole('tab',{name:'Stock Allocation Override',exact:true});
  assert.equal(await strategy.getAttribute('aria-selected'),'true');assert.equal(await strategy.evaluate(el=>el.getBoundingClientRect().left>=0&&el.getBoundingClientRect().right<=innerWidth),true);assert.equal(await page.locator('#stock-budget-form').isVisible(),false);
  await override.click();assert.equal(await page.locator('#stock-budget-form').isVisible(),true);assert.equal(await page.locator('#sip-config-form').isVisible(),false);
  await page.keyboard.press('ArrowLeft');assert.equal(await strategy.getAttribute('aria-selected'),'true');
  await page.locator('#set-target-growth').fill('10');await page.getByRole('button',{name:'Save Target Growth',exact:true}).click();await page.getByText('Target growth saved. Rebalance Losers will use 10%.',{exact:true}).waitFor();
  await page.evaluate(()=>loadSettings());await page.waitForFunction(()=>document.getElementById('growth-target-message').textContent==='');assert.equal(await page.locator('#set-target-growth').inputValue(),'10');
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
  await page.screenshot({path:path.join(root,'test-artifacts','settings-growth-'+width+'.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.evaluate(()=>switchTab('portfolio'));await page.locator('#portfolio-tab-rebalancing').click();
  await page.getByText('No holdings meet both conditions: ATH more than 365 days ago and XIRR below 10%.',{exact:true}).waitFor();
  assert.equal(writes,0);
  assert.deepEqual(errors,[]);console.log('Separate rebalancing tabs, combinations, keyboard navigation and empty states passed at '+width+'px');await page.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});


