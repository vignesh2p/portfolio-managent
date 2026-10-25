const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:740},hasTouch:true,isMobile:true});
  await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><form><label for="stock">Stock</label><select id="stock" required><option value="">Choose</option><option value="A">Alpha</option><option value="B">Beta</option></select><button type="submit">Save</button></form><div id="dynamic"></div>');
  await page.addStyleTag({path:path.join(__dirname,'../responsive.css')});
  await page.addScriptTag({path:path.join(__dirname,'../responsive.js')});
  await page.locator('#stock-search').tap();await page.locator('#stock-search').fill('Bet');
  await page.locator('#stock-search-panel [role=option]').tap();
  assert.equal(await page.locator('#stock').inputValue(),'B');
  assert.equal(await page.locator('#stock-search').getAttribute('aria-expanded'),'false');
  await page.locator('#stock-search').fill('bad');assert.equal(await page.locator('#stock').inputValue(),'');
  await page.locator('#stock-search').press('Escape');assert.equal(await page.locator('#stock').inputValue(),'B');
  await page.evaluate(()=>{document.getElementById('stock').value='A';});assert.equal(await page.locator('#stock-search').inputValue(),'Alpha');
  await page.evaluate(()=>{document.getElementById('stock').disabled=true;});await page.waitForFunction(()=>document.getElementById('stock-search').disabled);
  await page.evaluate(()=>{document.getElementById('dynamic').innerHTML='<label for="new">New stock</label><input id="new" list="names"><datalist id="names"><option value="New company"></datalist>';});
  await page.locator('#new').fill('New');await page.locator('#new-panel [role=option]').tap();assert.equal(await page.locator('#new').inputValue(),'New company');
  await page.evaluate(()=>document.getElementById('dynamic').replaceChildren());await page.waitForFunction(()=>!document.getElementById('new-panel'));
  console.log('Touch selection, validation, Escape, programmatic updates, disabled state and dynamic cleanup passed');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
