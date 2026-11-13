const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage();const errors=[],calls=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.includes('/api/auth/password-reset/')){
    const body=route.request().postDataJSON();calls.push({path:url.pathname,body});
    const data=url.pathname.endsWith('verify')?body.code==='012345'?{success:true,reset_token:'a'.repeat(64)}:{success:false,error:'Invalid or expired code.'}:{success:true,message:url.pathname.endsWith('reset')?'Password updated. Sign in with your new password.':'If eligible, check your email.'};
    return route.fulfill({json:data});
   }
   if(url.hostname!=='onepiece.test')return route.abort();
   const file=path.join(__dirname,'..',url.pathname==='/'?'onepiece.html':url.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
  });
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/');
   await page.getByRole('button',{name:'Forgot password?'}).click();await page.locator('#reset-email').fill('user@example.com');
   await page.locator('#reset-btn').click();await page.locator('#reset-code').waitFor({state:'visible'});
   await page.locator('#reset-code').fill('999999');await page.locator('#reset-btn').click();await page.getByText('Invalid or expired code.',{exact:true}).waitFor();
   await page.locator('#reset-code').fill('012345');await page.locator('#reset-code').press('Enter');await page.locator('#reset-password').waitFor({state:'visible'});
   await page.locator('#reset-password').fill('newPassword1');await page.locator('#reset-confirm').fill('mismatched');await page.locator('#reset-btn').click();await page.getByText('Passwords do not match.',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.locator('#reset-confirm').fill('newPassword1');await page.locator('#reset-btn').click();await page.locator('#login-msg').waitFor({state:'visible'});
   assert.match(await page.locator('#login-msg').textContent(),/Password updated/);
   assert.equal(await page.locator('#reset-password').inputValue(),'');
  }
  assert.equal(calls.filter(c=>c.path.endsWith('/reset')).length,2);assert.deepEqual(errors,[]);
  console.log('Password reset browser flow passed at mobile and desktop sizes.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
