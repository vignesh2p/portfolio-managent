const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {analyzeAccount,DEFAULTS}=require('../tax-harvesting');
const root=path.join(__dirname,'..'),now=new Date('2026-10-30T10:00:00Z');
const account=analyzeAccount({user:{id:1,name:'Test taxpayer'},now,holdings:[{ticker:'GAIN',stock_name:'Growth Industries',shares:2000,current_price:200,quote_fetched_at:now.toISOString()},{ticker:'LOSS',stock_name:'Declining Industries',shares:200,current_price:100,quote_fetched_at:now.toISOString()}],trades:[{id:1,ticker:'GAIN',type:'BUY',shares:1000,price:100,traded_at:'2024-01-01'},{id:5,ticker:'GAIN',type:'BUY',shares:1000,price:100,traded_at:'2024-02-01'},{id:2,ticker:'LOSS',type:'BUY',shares:200,price:200,traded_at:'2026-04-01'},{id:3,ticker:'SOLD',type:'BUY',shares:100,price:10,traded_at:'2026-04-01'},{id:4,ticker:'SOLD',type:'SELL',shares:100,price:110,traded_at:'2026-06-01'}]});
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];let fail=false,empty=false,saved=null;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname==='/api/sip-config')json.data={max_budget:1000,levels:[]};
    if(u.pathname==='/api/portfolio')json.data={holdings:[],xirr_eligible:false};
    if(u.pathname==='/api/tax-harvesting')json=fail?{success:false,error:'Test data unavailable'}:{success:true,data:{accounts:[empty?analyzeAccount({user:{id:1,name:'Empty'},now,trades:[],holdings:[]}):account],as_of:now.toISOString(),settings:{values:DEFAULTS,financial_year:2026},scope:'Saved delivery equity only'}};
    if(u.pathname==='/api/tax-harvesting/family')json.data={viewing:[],shared_with:[]};
    if(u.pathname==='/api/tax-harvesting/family/code')json.data={code:'a'.repeat(36)};
    if(u.pathname==='/api/admin/tax-settings'){
     if(route.request().method()==='PUT')saved=route.request().postDataJSON();
     json.data=saved||{values:DEFAULTS,financial_year:2026,updated_at:null};
    }
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  if(width<921)await page.locator('#navigation-toggle').click();
  await page.getByRole('button',{name:'Taxloss Harvesting',exact:true}).click();
  await page.waitForSelector('#tax-results table');
  assert.equal(await page.locator('#tax-results table').first().locator('tbody tr').count(),2);
  assert.match(await page.locator('#tax-results table').first().innerText(),/2 applicable lots/);
  assert.match(await page.locator('#tax-results table').first().innerText(),/2024-01-01 to 2024-02-01/);
  await page.getByLabel('Harvest type').selectOption('STCL Loss Harvest');
  assert.equal(await page.locator('#tax-results table').first().locator('tbody tr').count(),1);
  assert.match(await page.locator('#tax-results table').first().innerText(),/LOSS/);
  await page.getByLabel('Find security').fill('Declining');assert.match(await page.locator('#tax-results table').first().innerText(),/Declining Industries/);
  await page.getByLabel('Find security').fill('nonexistent');assert.match(await page.locator('#tax-results table').first().innerText(),/No matching rows/);
  await page.getByLabel('Find security').fill('');await page.getByLabel('Harvest type').selectOption('');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:path.join(root,'test-artifacts','tax-harvesting-'+width+'.png'),fullPage:true});
  await page.getByText('Family accounts & sharing',{exact:true}).click();
  await page.locator('#tax-share-form input').check();await page.getByRole('button',{name:'Generate sharing code'}).click();
  await page.waitForFunction(()=>document.getElementById('tax-share-code').textContent.includes('aaaa'));
  fail=true;await page.getByRole('button',{name:'Recalculate',exact:true}).click();await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
  fail=false;empty=true;await page.getByRole('button',{name:'Retry',exact:true}).click();await page.waitForSelector('#tax-results');
  assert.match(await page.locator('#tax-results').innerText(),/No useful whole-share/);
  await page.goto('https://onepiece.test/admin.html');
  await page.evaluate(async()=>{adminToken='test';loginView.classList.add('hidden');adminView.classList.remove('hidden');await loadTable('Tax settings');});
  await page.getByLabel('Annual LTCG exemption (₹)').fill('150000');await page.getByRole('button',{name:'Save tax settings'}).click();
  await page.waitForFunction(()=>document.getElementById('tax-admin-status').textContent.startsWith('Saved'));
  assert.equal(saved.values.ltcg_exemption,150000);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:path.join(root,'test-artifacts','tax-admin-'+width+'.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('Harvesting filters, errors, sharing and admin save verified at '+width+'px');await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
