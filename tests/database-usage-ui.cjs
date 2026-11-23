const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {FREE_LIMITS}=require('../database-usage');
const root=path.join(__dirname,'..');
(async()=>{
 assert.equal(require('../admin-page')(),fs.readFileSync(path.join(root,'admin.html'),'utf8'));
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{
    const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
    const file=path.join(root,u.pathname==='/admin'?'admin.html':u.pathname.slice(1));
    return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
   });
   await page.goto('https://onepiece.test/admin');
   await page.evaluate(limits=>{
    showAdmin();renderNav();
    fetchJson=async()=>({success:true,data:{as_of:'2026-11-14T05:00:00Z',storage_bytes:2048000,free_bytes:4096,total_rows:201,estimated_bytes:9000,
     provider:{status:'not_configured'},free_plan:{limits,checked_on:'2026-11-14'},shared:{rows:1,estimated_bytes:2000},tables:[{name:'portfolio',rows:200,estimated_bytes:7000}],
     users:[{id:1,name:'Alice <script>',email:'alice@example.test',account_status:'approved',rows:100,estimated_bytes:4000,tables:[{name:'portfolio',rows:100,estimated_bytes:4000}]},{id:2,name:'Bob',email:'bob@example.test',rows:100,estimated_bytes:3000,tables:[]}]}});
   },FREE_LIMITS);
   await page.getByRole('button',{name:'Database usage Open table'}).click();
   await page.waitForSelector('#database-usage-search');
   assert.match(await page.locator('#database-usage-users').innerText(),/Alice <script>/);
   assert.equal(await page.locator('#database-usage-users script').count(),0);
   assert.match(await page.locator('.usage-cards').innerText(),/Unavailable/);
   assert.equal(await page.locator('meter').count(),1);
   await page.locator('#database-usage-search').fill('bob');
   assert.doesNotMatch(await page.locator('#database-usage-users').innerText(),/Alice/);
   await page.locator('#database-usage-search').fill('');
   await page.getByText('View 1 tables',{exact:true}).click();
   assert.match(await page.locator('#database-usage-users').innerText(),/portfolio: 100 records/);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.screenshot({path:path.join(root,'test-artifacts',`database-usage-${width}.png`),fullPage:true});
   await page.evaluate(()=>{fetchJson=async()=>({success:false,error:'Usage unavailable'});});
   await page.getByRole('button',{name:'Database usage Open table'}).click();
   await page.waitForFunction(()=>document.getElementById('content').textContent.includes('Usage unavailable'));
   assert.deepEqual(errors,[]);await page.close();
  }
  console.log('Database usage navigation, filtering, details, safe rendering and errors passed on mobile and desktop.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
