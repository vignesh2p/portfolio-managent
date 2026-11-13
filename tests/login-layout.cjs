const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();const file=path.join(__dirname,'..',u.pathname==='/'?'onepiece.html':u.pathname.slice(1));return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});});
 for(const [width,height] of [[320,700],[390,844],[768,1024],[1024,768],[1440,900],[1920,1080],[844,390]]){
  await page.setViewportSize({width,height});await page.goto('https://onepiece.test/');
  for(const tab of ['login','signup']){
   await page.locator('.auth-tab').nth(tab==='login'?0:1).click();
   const layout=await page.evaluate(()=>{const c=document.querySelector('.auth-card').getBoundingClientRect(),p=document.querySelector('.public-shell').getBoundingClientRect();return {center:c.x+c.width/2,width:c.width,top:c.top,bottom:c.bottom,publicTop:p.top,overflow:document.documentElement.scrollWidth>innerWidth};});
   assert.ok(Math.abs(layout.center-width/2)<2,JSON.stringify(layout));assert.ok(layout.width<=width-32);assert.ok(layout.publicTop>=layout.bottom);assert.equal(layout.overflow,false);assert.ok(layout.top>=0);
  }
  if(width===1440||width===390){await page.locator('.auth-tab').first().click();fs.mkdirSync(path.join(__dirname,'../test-artifacts'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../test-artifacts/login-centered-'+width+'.png')});}
  console.log('Centered sign-in/signup verified at '+width+'x'+height);
 }
 assert.deepEqual(errors,[]);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
