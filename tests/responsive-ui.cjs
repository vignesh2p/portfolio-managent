// Browser layout checks with synthetic data; no production account or database access.
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const levels=[-10,-15,-20,-25,-30,-35,-40].map((fall,i)=>({fall,allocation:[10,5,20,10,30,15,10][i]}));
const stock={ticker:'NSE:EXAMPLE',stock_code:'NSE:EXAMPLE',code:'OK123',name:'Example Manufacturing and Engineering Limited',price:850,cmp:850,ath:1000,ath_date:'2026-01-01',changePct:2};
const trades=[{id:1,ticker:stock.ticker,type:'BUY',price:850,shares:10,amount:8500,traded_at:'2026-01-01',notes:'Imported bonus and purchase history'}];
function api(url){
  const p=new URL(url).pathname;
  if(p.includes('admin-me'))return {success:true,user:{name:'Test Admin'}};
  if(p.includes('/admin/debug'))return {success:true,database:{host:'test.example',database:'test'},counts:{users:1}};
  if(p.includes('/admin/table/'))return {success:true,columns:[{name:'id'},{name:'name'}],rows:[{id:1,name:stock.name}]};
  if(p.includes('/sip-config'))return {success:true,data:{max_budget:50000,levels}};
  if(p==='/api/portfolio')return {success:true,data:{holdings:[{ticker:stock.ticker,shares:10,avg_price:850}],xirr:10}};
  if(p.includes('/price/'))return {success:true,data:stock};
  if(p.includes('/xirr'))return {success:true,livePrice:850,ath:1000,xirrPct:10,cashflows:trades.map(t=>({...t,date:t.traded_at,cashflow:-8500,runningShares:10}))};
  if(p.includes('portfolio-opportunities'))return {success:true,data:{levels,rows:[{...stock,ok_code:'OK123',levels:levels.map(l=>({...l,trigger_price:1000*(1+l.fall/100),allocated_amount:5000,shares_to_buy:5,invested_amount:l.fall===-15?8500:0,bought_quantity:l.fall===-15?10:0,selected:l.fall===-15,active:l.fall===-15}))}]}};
  if(p.includes('/watchlist/'))return {success:true,data:[stock]};
  if(p.includes('/settings/stocks'))return {success:true,data:[{id:1,...stock,ok_code:'OK123'}]};
  if(p.includes('/trades'))return {success:true,data:trades};
  return {success:true,data:[]};
}
(async()=>{
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const errors=[];
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.hostname!=='onepiece.test')return route.abort();
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:api(url.href)});
    const file=path.join(root,url.pathname==='/'?'onepiece.html':url.pathname==='/admin'?'admin.html':url.pathname.slice(1));
    const type=file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html';
    return route.fulfill({body:fs.readFileSync(file),contentType:type});
  });
  const output=path.join(root,'test-artifacts');
  fs.mkdirSync(output,{recursive:true});
  async function fits(label){
    await page.waitForTimeout(80);
    const sizes=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(sizes.scroll<=sizes.width+1,`${label}: page overflow ${JSON.stringify(sizes)}`);
  }
  try{
    for(const width of [320,390,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      await page.goto('http://onepiece.test/');
      assert.equal(await page.getByText('Admin Login',{exact:true}).count(),0);
      await fits(`public ${width}`);
      await page.evaluate(()=>{TOKEN='fixture';USERINFO={name:'Test User'};showApp();});
      for(const tab of ['sip','portfolio','opportunities','watchlist','trades','settings']){
        if(width<=920){
          await page.locator('#navigation-toggle').click();
          assert.equal(await page.locator('#navigation-toggle').getAttribute('aria-expanded'),'true');
        }
        await page.locator(`.side-tab[onclick*="'${tab}'"]`).click();
        if(width<=920)assert.equal(await page.locator('#navigation-toggle').getAttribute('aria-expanded'),'false');
        await fits(`${tab} ${width}`);
        if(tab==='sip'){
          await page.evaluate(({stock,levels})=>renderSIP({stock,fallPct:-15,budget:50000,totalDeployable:10000,triggered:[levels[1]],analysis:levels.map(l=>({...l,triggerPrice:900,amount:5000,triggered:l.fall>=-15}))}),{stock,levels});
          await fits(`SIP data ${width}`);
        }
        if(tab==='portfolio'){
          await page.waitForSelector('.port-row');
          assert.ok(await page.locator('.port-row>div:nth-child(2)').isVisible());
          assert.ok(await page.locator('.port-row>div:nth-child(5)').isVisible());
          await page.evaluate(()=>switchPortfolioView('allocation'));
          await fits(`allocation ${width}`);
          await page.evaluate(()=>switchPortfolioView('holdings'));
          await page.locator('.port-row').click();
          await fits(`XIRR ${width}`);
          await page.evaluate(()=>closeModal());
        }
        if(tab==='trades'){
          await page.locator('#export-trades-btn').click();
          await fits(`export ${width}`);
          await page.keyboard.press('Escape');
        }
        if(tab==='opportunities'){
          const scroller=page.locator('#opportunity-table .sheet-table-wrap');
          await scroller.evaluate(el=>el.scrollLeft=el.scrollWidth);
          assert.ok(await page.locator('[data-op-level="6"]').isDisabled());
          assert.ok(await page.locator('[data-op-level="1"]').isChecked());
          assert.equal(await page.getByText('Save selections',{exact:true}).count(),0);
          await page.evaluate(()=>loadOpportunityScope('watchlist'));
          await fits(`watchlist opportunities ${width}`);
        }
        if(tab==='settings'){
          await page.locator('[name="allocation_0"]').fill('11');
          await page.locator('#save-sip-config').click();
          assert.match(await page.locator('#settings-msg').textContent(),/100%/);
          await page.locator('[name="allocation_0"]').fill('10');
          await page.locator('[name="fall_0"]').fill('-12');
          await page.locator('#save-sip-config').click();
          await page.waitForFunction(()=>document.getElementById('settings-msg').textContent.includes('Configuration saved'));
          await fits(`SIP config ${width}`);
          await page.locator('#settings-stocks-tab').click();
          await fits(`stocks config ${width}`);
        }
        if([390,768,1440].includes(width)){
          await page.evaluate(()=>window.scrollTo(0,0));
          await page.screenshot({path:path.join(output,`${tab}-${width}.png`),fullPage:true});
        }
      }
      if(width<=920){
        await page.locator('#navigation-toggle').click();
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#navigation-toggle').getAttribute('aria-expanded'),'false');
      }
      await page.goto('http://onepiece.test/admin');
      await fits(`admin login ${width}`);
      await page.evaluate(()=>{adminToken='fixture';adminUser={name:'Test Admin'};showAdmin();return bootstrapAdmin();});
      await fits(`admin ${width}`);
      if(width===390)await page.screenshot({path:path.join(output,'admin-390.png'),fullPage:true});
      console.log(`All screens fit ${width}px`);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
