const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {applyOpportunityBeta}=require('../opportunity-beta');
const root=path.join(__dirname,'..');
const levels=[{fall:-10,allocation:10},{fall:-20,allocation:20},{fall:-30,allocation:70}];
const base=levels.map((l,i)=>({...l,allocated_amount:l.allocation*10,trigger_price:100+l.fall,active:i===1,invested_amount:0,bought_quantity:0}));
const rows=[100,50,0,150].map((spent,i)=>({ticker:'TEST'+i,name:['Fully used','Partly used','Skipped purchase','Overspent'][i],max_budget:1000,price:80,ath:100,ath_date:'2026-01-01',
 levels:applyOpportunityBeta(base,[{type:'BUY',price:spent,shares:1}],1000,80,100)}));
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],calls=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/sip-config')json={success:true,data:{max_budget:1000,levels}};
    if(u.pathname==='/api/portfolio')json={success:true,data:{holdings:[],xirr_eligible:false}};
    if(u.pathname==='/api/watchlists')json={success:true,data:[{id:1,name:'Default watchlist'}]};
    if(u.pathname==='/api/portfolio-opportunities'){
     calls.push(u.searchParams.get('mode'));
     json={success:true,data:{levels,rows:u.searchParams.get('mode')==='beta'?rows:rows.map(r=>({...r,levels:base}))}};
    }
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');
  await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  if(width<921)await page.locator('#navigation-toggle').click();
  await page.getByRole('button',{name:'Opportunities Beta',exact:true}).click();
  await page.waitForSelector('#beta-table table');
  assert.equal(await page.locator('#beta-watchlist-controls').isVisible(),false);
  const active=page.locator('#beta-table .opportunity-active');
  assert.equal(await active.count(),4);
  for(const [i,amount] of [200,250,300,150].entries()){
   assert.ok((await active.nth(i).locator('dd.beta-result').innerText()).startsWith('₹'+amount+'.00'));
   assert.match(await active.nth(i).innerText(),/Cumulative target/);
   assert.match(await active.nth(i).innerText(),/Already invested/);
   if(i===1)assert.match(await active.nth(i).locator('dd.beta-result').innerText(),/\(\+₹50.00\)/);
   assert.match(await active.nth(i).innerText(),/Unused previous allocation/);
   assert.match(await active.nth(i).innerText(),/Suggested Quantity/);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const cycleLevels=[10,15,20,25,30].map((allocation,i)=>({fall:-10*(i+1),allocation,active:i===2,trigger_price:150*(1-(i+1)/10)}));
  const cycle={base_invested:20000,ath:150,cycle_cap:30000,reset_at:'2026-09-01T00:00:00+05:30',ath_date:'2026-09-01',kind:'yahoo_history',date_note:'Trades on the ATH date count in the new cycle.',history:[{ath:140,base_invested:0,cycle_cap:50000,reset_at:'2026-10-01T10:00:00Z',closed_at:'2026-10-31T10:00:00Z',snapshot:{as_of:'2026-10-30T10:00:00Z',levels:[{fall:-30,cumulative_allocation:22500,suggested_investment:2500,carry_forward_amount:0}]}}]};
  const cycleRow={ticker:'ABC',name:'ATH reset example',max_budget:50000,price:100,ath:150,ath_date:'2026-10-31',beta_cycle:cycle,levels:applyOpportunityBeta(cycleLevels,[{type:'BUY',price:24000,shares:1}],50000,100,150,0,cycle)};
  await page.evaluate(data=>renderOpportunityBeta(data),{levels:cycleLevels,rows:[cycleRow]});
  assert.match(await page.locator('.beta-current').innerText(),/₹9,500.00 \(\+₹3,500.00\) \| 95 Shares/);
  await page.locator('.beta-cycle-history summary').click();
  assert.match(await page.locator('.beta-cycle-history').innerText(),/target ₹22,500.00; suggested ₹2,500.00/);
  assert.match(await page.locator('#beta-table tbody th').innerText(),/Cycle cap: ₹30,000.00/);
  assert.match(await page.locator('#beta-table tbody th').innerText(),/Cycle start: 2026-09-01/);
  assert.match(await page.locator('.beta-cycle-history').innerText(),/Reconstructed from Yahoo Finance ATH history/);
  await page.screenshot({path:path.join(root,'test-artifacts','opportunities-beta-'+width+'.png'),fullPage:true});
  await page.locator('#beta-tab-watchlist').click();
  await page.waitForSelector('#beta-table table');
  assert.equal(await page.locator('#beta-watchlist-controls').isVisible(),true);
  if(width<921)await page.locator('#navigation-toggle').click();
  await page.getByRole('button',{name:'Opportunities',exact:true}).click();
  await page.waitForSelector('#opportunity-table table');
  assert.ok(!await page.locator('#opportunity-table').innerText().then(text=>text.includes('Suggested Investment')));
  assert.ok(calls.includes('beta')&&calls.includes(null));assert.deepEqual(errors,[]);
  console.log('Beta and original screen verified at '+width+'px');await page.close();
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
