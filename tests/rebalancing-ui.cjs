const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const source={ticker:'OLD',name:'Old Company',code:'OLD',shares:10,price:100,invested_amount:500,market_value:1000,ath_date:'2024-01-01',days_since:900};
const buys=[{ticker:'NEW',name:'New Company',code:'NEW',price:50,shares:10,fall:-30,allocation:50},{ticker:'OTHER',name:'Other Company',code:'OTHER',price:100,shares:5,fall:-10,allocation:50}];
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
 for(const width of [390,768,1440]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];let writes=0,payload;
  page.on('pageerror',e=>errors.push(e.stack));
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/rebalancing'){
     if(route.request().method()==='POST'){writes++;payload=route.request().postDataJSON();json={success:true,data:{trade_ids:[1,2,3]}};}
     else json={success:true,data:{sources:[source],source,combinations:[{buys,total:1000,remaining:0}],date:'2026-10-25'}};
    }
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
  assert.equal(await page.locator('#rebalance-body button, #rebalance-body input, #rebalance-body form').count(),0);
  assert.match(await page.locator('#rebalance-body').innerText(),/Suggested multi-stock combinations/);
  assert.equal(await page.locator('#rebalance-table th').filter({hasText:'ATH Drop %'}).count(),1);
  const box=await page.locator('#rebalance-dialog').boundingBox();assert.ok(box.width<=width&&box.x>=0);
  assert.equal(await page.locator('#rebalance-dialog').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#rebalance-dialog').evaluate(el=>el.open),false);
  assert.equal(writes,0);
  assert.deepEqual(errors,[]);console.log('View-only Rebalance Losers popup and layout passed at '+width+'px');await page.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});


