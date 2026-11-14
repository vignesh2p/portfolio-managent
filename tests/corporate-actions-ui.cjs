const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],decisions=[];
  const actions=[{id:1,ticker:'ABC.NS',holding_ticker:'ABC',kind:'bonus',ex_date:'2026-02-01',numerator:1,denominator:1,source:'Admin',description:'Verified 1:1 bonus',from_date:'2025-06-01',status:'pending',plan:{eligible_shares:80,additional_shares:80,resulting_shares:170,fingerprint:'abc'}},{id:2,ticker:'OLD.NS',holding_ticker:'OLD',kind:'split',ex_date:'2025-01-01',numerator:2,denominator:1,source:'Admin',description:'Historic action',from_date:'2024-06-01',status:'read',plan:{}}];
  page.on('pageerror',e=>errors.push(e.stack));
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   if(u.pathname.startsWith('/api/')){
    let json={success:true,data:[]};
    if(u.pathname.endsWith('/decision')){const body=route.request().postDataJSON();decisions.push(body);actions[0].status=body.decision==='ignore'?'ignored':'applied';}
    else if(u.pathname.startsWith('/api/corporate-actions'))json.data={baseline:'2026-01-01',pending:actions.filter(a=>a.status==='pending').length,actions};
    else if(u.pathname==='/api/admin/corporate-actions'){if(route.request().method()==='POST'){decisions.push(route.request().postDataJSON());}else json.data=actions;}
    else if(u.pathname==='/api/auth/admin-me')json.user={name:'Admin',email:'admin@test'};
    else if(u.pathname==='/api/portfolio')json.data={holdings:[],xirr_eligible:false};
    else if(u.pathname==='/api/sip-config')json.data={max_budget:50000,levels:[]};
    return route.fulfill({json});
   }
   const file=path.join(root,u.pathname==='/'?'onepiece.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('https://onepiece.test/');await page.evaluate(()=>{TOKEN='test';USERINFO={name:'Test'};showApp();});
  if(width<921)await page.locator('#navigation-toggle').click();
  await page.getByRole('button',{name:/Corporate Actions/}).click();await page.getByText('1 awaiting your decision').waitFor();
  assert.equal(await page.locator('#corporate-actions-count').innerText(),'1');
  await page.getByRole('button',{name:'Review action',exact:true}).click();await page.getByText(/Shares held before ex-date/).waitFor();
  await page.getByRole('button',{name:'Apply to holding',exact:true}).click();assert.equal(decisions.length,0);
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Apply to holding',exact:true}).click();
  await page.getByText('Action applied. Your holdings and trades have been updated.').waitFor();assert.equal(decisions[0].decision,'apply');assert.equal(await page.locator('#corporate-actions-count').isVisible(),false);
  actions[0].status='pending';await page.getByRole('button',{name:'Refresh actions',exact:true}).click();await page.getByRole('button',{name:'Review action',exact:true}).click();
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Ignore action',exact:true}).click();await page.getByText('Action ignored.',{exact:true}).waitFor();assert.equal(decisions[1].decision,'ignore');
  await page.locator('#ca-filter').selectOption('read');await page.getByRole('button',{name:'View details',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Apply to holding'}).count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:path.join(root,'test-artifacts',`corporate-actions-${width}.png`),fullPage:true});
  await page.evaluate(()=>{localStorage.setItem('pf_admin_token','test');localStorage.setItem('pf_admin_user',JSON.stringify({name:'Admin'}));});
  await page.goto('https://onepiece.test/admin.html');await page.getByRole('button',{name:/Corporate actions.*Open/}).click();
  await page.locator('[name="ticker"]').fill('TEST.NS');await page.locator('[name="kind"]').selectOption('bonus');await page.locator('[name="ex_date"]').fill('2027-01-01');await page.locator('[name="numerator"]').fill('1');await page.locator('[name="denominator"]').fill('1');
  await page.getByRole('button',{name:'Save corporate action'}).click();await page.getByText(/Saved. Eligible users/).waitFor();assert.equal(decisions[2].ticker,'TEST.NS');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Corporate actions UI: mobile and desktop apply, ignore, history and admin entry passed.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
