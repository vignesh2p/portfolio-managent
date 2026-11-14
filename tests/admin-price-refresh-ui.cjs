const {chromium}=require(process.env.PLAYWRIGHT_PATH),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>{
   const u=new URL(route.request().url());if(u.hostname!=='onepiece.test')return route.abort();
   const file=path.join(__dirname,'..',u.pathname==='/admin'?'admin.html':u.pathname.slice(1));
   return route.fulfill({body:fs.readFileSync(file),contentType:file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html'});
  });
  for(const width of [390,768,1440]){
   await page.setViewportSize({width,height:900});await page.goto('https://onepiece.test/admin');
   await page.evaluate(()=>{
    showAdmin();window.priceCalls=0;refreshCurrentTable=async()=>{};
    fetchJson=async(url,options)=>{
     if(url!=='/api/admin/prices/refresh')throw Error('Unexpected endpoint');
     window.priceCalls++;await new Promise(resolve=>setTimeout(resolve,100));
     return priceCalls===1?{success:true,total:12,successful:11,failed:1,errors:[{ticker:'BAD',error:'Provider offline'}],next:'LAST'}:{success:true,total:1,successful:1,failed:0,next:null};
    };
   });
   const button=page.getByRole('button',{name:'Refresh all prices now',exact:true});
   await button.focus();await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.getElementById('price-refresh-status').textContent.startsWith('Refresh complete:'));
   assert.equal(await page.evaluate(()=>priceCalls),2);
   assert.match(await page.locator('#price-refresh-status').textContent(),/12 updated, 1 failed/);
   assert.equal(await button.isEnabled(),true);
   await page.locator('#price-refresh-errors summary').click();
   assert.equal(await page.locator('#price-refresh-error-list').textContent(),'BAD: Provider offline');
   const box=await button.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1,'Button fits viewport');
   await page.evaluate(()=>{fetchJson=async()=>({success:false,error:'Another price refresh is running.'});});
   await button.click();await page.waitForFunction(()=>document.getElementById('price-refresh-status').textContent.startsWith('Refresh stopped:'));
   assert.equal(await button.isEnabled(),true);
   console.log('Admin price refresh keyboard, batches, failures and contention verified at '+width+'px');
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
