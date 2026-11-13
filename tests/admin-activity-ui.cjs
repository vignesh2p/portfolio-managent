const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const weeks=[{week:'2026-10-12',active_users:1,active_minutes:20},{week:'2026-10-19',active_users:2,active_minutes:90}];
const users=[{id:1,name:'Alice',email:'alice@test',account_status:'approved',active_weeks:2,active_days:4,active_minutes:80,first_seen:'2026-10-12T00:00:00Z',last_seen:'2026-10-25T00:00:00Z',weeks:[{week:'2026-10-12',active_days:1,active_minutes:20},{week:'2026-10-19',active_days:3,active_minutes:60}]},{id:2,name:'Bob',email:'bob@test',account_status:'approved',active_weeks:1,active_days:1,active_minutes:30,first_seen:'2026-10-19T00:00:00Z',last_seen:'2026-10-19T00:00:00Z',weeks:[{week:'2026-10-12',active_days:0,active_minutes:0},{week:'2026-10-19',active_days:1,active_minutes:30}]}];
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 for(const width of [390,768,1440]){
 const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.stack));
 await page.addInitScript(()=>{localStorage.setItem('pf_admin_token','fixture');localStorage.setItem('pf_admin_user',JSON.stringify({name:'Admin'}));});
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
 if(u.pathname.startsWith('/api/')){let json={success:true,data:[],tables:[],counts:{}};
 if(u.pathname.includes('admin-me'))json={success:true,user:{name:'Admin'}};
 if(u.pathname==='/api/admin/activity')json={success:true,data:{tracking_since:'2026-10-12T00:00:00Z',current_week:'2026-10-19',weeks,users}};
 return route.fulfill({json});}
 const file=path.join(root,u.pathname==='/admin'?'admin.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
 });
 await page.goto('https://onepiece.test/admin');await page.waitForFunction(()=>booted);await page.evaluate(()=>loadTable('User activity'));
 await page.waitForSelector('#activity-users table');assert.equal(await page.locator('#activity-users tbody tr').count(),2);
 assert.equal(await page.locator('.activity-chart').count(),2);
 await page.locator('[data-activity-week="2026-10-12"]').first().click();assert.match(await page.locator('#activity-week-title').textContent(),/2026-10-12/);
 await page.locator('[data-activity-user="1"]').click();assert.equal(await page.locator('#activity-users tbody tr').count(),1);assert.match(await page.locator('#activity-charts').innerText(),/Alice/);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 if(width===390){fs.mkdirSync(path.join(root,'test-artifacts'),{recursive:true});await page.screenshot({path:path.join(root,'test-artifacts/activity-admin-390.png'),fullPage:true});}
 assert.deepEqual(errors,[]);console.log('Activity charts, week drill-down, user history and layout passed at '+width+'px');await page.close();
 }
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
