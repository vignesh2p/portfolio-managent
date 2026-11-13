// Browser layout checks with synthetic data; no production account or database access.
const {chromium}=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const levels=[-10,-15,-20,-25,-30,-35,-40].map((fall,i)=>({fall,allocation:[10,5,20,10,30,15,10][i]}));
const stock={ticker:'NSE:EXAMPLE',stock_code:'NSE:EXAMPLE',yahoo_finance_code:'EXAMPLE.NS',code:'OK123',name:'Example Manufacturing and Engineering Limited',price:850,cmp:850,ath:1000,ath_date:'2026-01-01',changePct:2};
const trades=[{id:1,ticker:stock.ticker,type:'BUY',price:850,shares:10,amount:8500,traded_at:'2026-01-01',notes:'Imported bonus and purchase history'}];
function api(url){
  const p=new URL(url).pathname;
  if(p==='/api/watchlists')return {success:true,data:[{id:1,slot:1,name:'Default watchlist',all_stocks:1}]};
  if(p.includes('/watchlists/')||p==='/api/stocks/universe')return {success:true,data:[stock]};
  if(p==='/api/admin/users')return {success:true,data:[{id:1,name:'Pending User',email:'pending@example.com',account_status:'pending',created_at:'2026-10-24'}]};
  if(p.startsWith('/api/admin/users/'))return {success:true};
  if(p.includes('admin-me'))return {success:true,user:{name:'Test Admin'}};
  if(p==='/api/admin/stock-config')return {success:true,data:[stock]};
  if(p.startsWith('/api/admin/stock-config/'))return {success:true,data:{...stock,code:'ADMIN1',stock_code:'BOM:500001'}};
  if(p==='/api/admin/leaderboard')return {success:true,as_of:'2026-10-24T10:00:00Z',data:[{rank:1,name:'Test User',email:'test@example.com',xirr_pct:12.5,status:'Ranked'}]};
  if(p.includes('/admin/debug'))return {success:true,database:{host:'test.example',database:'test'},counts:{users:1}};
  if(p.includes('/admin/table/'))return {success:true,columns:[{name:'id'},{name:'name'}],rows:[{id:1,name:stock.name}]};
  if(p==='/api/sip-stock-budgets')return {success:true,data:[{ticker:stock.ticker,name:stock.name,max_budget:25000}]};
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
    if(url.pathname==='/api/admin/stock-config'&&route.request().method()==='POST')return route.fulfill({json:{success:true,data:stock}});
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
      for(const tab of ['portfolio','opportunities','watchlist','trades','settings']){
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
          await page.waitForFunction(()=>document.getElementById('t-stock-options').options.length>0);
          await page.locator('#t-stock-name').fill('Example');
          await page.locator('#t-stock-name-panel [role=option]').first().click();
          assert.ok((await page.locator('#t-stock-name').inputValue()).includes('Example'));
          await page.locator('#t-stock-name').fill('unknown company');
          assert.equal(await page.locator('#t-stock-name-panel .autocomplete-empty').textContent(),'No matching options');
          await page.locator('#t-stock-name').press('Escape');
          assert.ok((await page.locator('#t-stock-name').inputValue()).includes('Example'));

          await page.locator('#export-trades-btn').click();
          await fits(`export ${width}`);
          await page.keyboard.press('Escape');
        }
        if(tab==='portfolio'){
          await page.locator('#portfolio-sort-field-search').fill('Stock');
          assert.equal(await page.locator('#portfolio-sort-field-search').getAttribute('aria-expanded'),'true');
          await page.locator('#portfolio-sort-field-search').press('Enter');
          assert.equal(await page.locator('#portfolio-sort-field').inputValue(),'name');
          await page.locator('#portfolio-sort-order-search').fill('Desc');
          await page.locator('#portfolio-sort-order-search-panel [role=option]').click();
          assert.equal(await page.locator('#portfolio-sort-order').inputValue(),'desc');
          await page.locator('#portfolio-sort-order-search').fill('invalid');
          assert.equal(await page.locator('#portfolio-sort-order-search').evaluate(el=>el.checkValidity()),false);
          await page.locator('#portfolio-sort-order-search').press('Escape');
          assert.equal(await page.locator('#portfolio-sort-order-search').inputValue(),'Descending');
        }
        if(tab==='watchlist'){
          assert.equal(await page.getByRole('button',{name:'Edit watchlist',exact:true}).isDisabled(),true);
          assert.equal(await page.getByRole('button',{name:'Delete watchlist',exact:true}).isDisabled(),true);
          const watchScroll=page.locator('#watchlist-table .sheet-table-wrap');
          await watchScroll.evaluate(el=>el.scrollLeft=el.scrollWidth);
          const geometry=await page.locator('#watchlist-table .sheet-table').evaluate(table=>{
            const a=table.querySelector('tbody td').getBoundingClientRect(),b=table.querySelector('tbody td:nth-child(2)').getBoundingClientRect(),h=table.querySelector('th:nth-child(2)').getBoundingClientRect();
            return {right:a.right,left:b.left,header:h.left,bg:getComputedStyle(table.querySelector('tbody td:nth-child(2)')).backgroundColor};
          });
          assert.ok(Math.abs(geometry.right-geometry.left)<1,JSON.stringify(geometry));assert.ok(Math.abs(geometry.left-geometry.header)<1);assert.ok(!geometry.bg.startsWith('rgba'));
          await page.getByRole('button',{name:'Create watchlist',exact:true}).click();
          await page.waitForSelector('#watchlist-editor:not([hidden])');
          assert.equal(await page.locator('#watchlist-name').inputValue(),'');
          assert.equal(await page.locator('#watchlist-choices input').isChecked(),false);
          await fits(`watchlist editor ${width}`);
          await page.locator('#watchlist-search').fill('does not exist');
          assert.equal(await page.locator('#watchlist-choices label:visible').count(),0);
          await page.locator('#watchlist-editor').getByRole('button',{name:'Cancel'}).click();
        }
        if(tab==='opportunities'){
          const scroller=page.locator('#opportunity-table .sheet-table-wrap');
          await page.locator('#opportunity-table tbody').evaluate(body=>body.append(body.firstElementChild.cloneNode(true)));
          await scroller.evaluate(el=>{el.scrollLeft=el.scrollWidth;el.scrollTop=20;});
          const frozen=await page.locator('#opportunity-table tbody tr:nth-child(2) td:first-child').evaluate(cell=>({background:getComputedStyle(cell).backgroundColor,left:cell.getBoundingClientRect().left,head:cell.closest('table').querySelector('th').getBoundingClientRect().left}));
          assert.ok(!frozen.background.startsWith('rgba'),JSON.stringify(frozen));assert.ok(Math.abs(frozen.left-frozen.head)<1);
          if(width===390)await page.screenshot({path:path.join(output,'sticky-opportunities-390.png'),fullPage:true});
          assert.ok(await page.locator('[data-op-level="6"]').first().isDisabled());
          assert.ok(await page.locator('[data-op-level="1"]').first().isChecked());
          assert.equal(await page.getByText('Save selections',{exact:true}).count(),0);
          await page.evaluate(()=>loadOpportunityScope('watchlist'));
          await fits(`watchlist opportunities ${width}`);
        }
        if(tab==='settings'){
          await page.waitForSelector('#stock-budget-select-search');
          await page.locator('#stock-budget-select-search').fill('Example');
          await page.waitForSelector('#stock-budget-select-search-panel [role=option]');
          await fits(`autocomplete panel ${width}`);
          if(width===390)await page.screenshot({path:path.join(output,'autocomplete-390.png'),fullPage:true});
          await page.locator('#stock-budget-select-search').press('ArrowDown');
          await page.locator('#stock-budget-select-search').press('Enter');
          assert.equal(await page.locator('#stock-budget-select').inputValue(),stock.ticker);
          assert.equal(await page.locator('#stock-budget-amount').inputValue(),'25000');
          assert.equal(await page.evaluate(()=>Boolean(document.getElementById('settings-strategy').compareDocumentPosition(document.getElementById('stock-budget-form'))&Node.DOCUMENT_POSITION_FOLLOWING)),true);
        
          await page.locator('#add-sip-level').click();
          assert.equal(await page.locator('#settings-breakdown tbody tr').count(),8);
          await page.getByRole('button',{name:'Remove level 8',exact:true}).click();
          assert.equal(await page.locator('#settings-breakdown tbody tr').count(),7);
          await page.getByRole('button',{name:'Remove level 7',exact:true}).click();
          assert.equal(await page.locator('#settings-breakdown tbody tr').count(),6);
          await page.locator('#add-sip-level').click();
          await page.locator('[name="allocation_6"]').fill('10');
          await page.locator('[name="allocation_0"]').fill('11');
          await page.locator('#save-sip-config').click();
          assert.match(await page.locator('#settings-msg').textContent(),/100%/);
          await page.locator('[name="allocation_0"]').fill('10');
          await page.locator('[name="fall_0"]').fill('-12');
          await page.locator('#save-sip-config').click();
          await page.waitForFunction(()=>document.getElementById('settings-msg').textContent.includes('Configuration saved'));
          await fits(`SIP config ${width}`);
          assert.equal(await page.locator('#settings-stocks-tab').count(),0);
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
      await page.getByRole('button',{name:/User management/}).click();
      await page.getByRole('button',{name:'Approve',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('user-action-message').textContent==='User access updated.');
      await fits(`user management ${width}`);
      await page.getByRole('button',{name:/Stocks Config/}).click();
      await page.waitForSelector('#universe-code-0');
      const defaultToggle=page.getByRole('checkbox',{name:'Include '+stock.name+' in Default watchlist',exact:true});
      await defaultToggle.uncheck();
      await page.waitForFunction(()=>document.getElementById('universe-message').textContent==='Removed from Default watchlist for all users.');
      await defaultToggle.check();
      await page.waitForFunction(()=>document.getElementById('universe-message').textContent==='Added to Default watchlist for all users.');
      await page.locator('#universe-code-0').fill('ADMIN1');
      await page.locator('#universe-stock_code-0').fill('BOM:500001');
      await page.locator('#universe-form-0 button').click();
      await page.waitForFunction(()=>document.getElementById('universe-message').textContent.startsWith('Saved'));
      await page.locator('#add-code').fill('NEW1');
      await page.locator('#add-stock-code').fill('NSE:NEW');
      await page.locator('#add-yahoo-code').fill('NEW.NS');
      await page.locator('#universe-add button').click();
      await page.waitForFunction(()=>document.getElementById('universe-message').textContent.startsWith('Stock added'));
      page.once('dialog',dialog=>dialog.accept());
      await page.getByRole('button',{name:'Delete '+stock.name,exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('universe-message').textContent==='Stock deleted.');
      await fits(`admin stock config ${width}`);
      await page.locator('#universe-search').fill('nonexistent');
      assert.equal(await page.locator('#universe-rows tr:visible').count(),0);
      await page.getByRole('button',{name:/Leader board/}).click();
      await page.waitForFunction(()=>document.getElementById('table-title').textContent==='Leader board');
      assert.match(await page.locator('#content').textContent(),/12.50%/);
      await fits(`leaderboard ${width}`);
      if(width===390)await page.screenshot({path:path.join(output,'admin-390.png'),fullPage:true});
      console.log(`All screens fit ${width}px`);
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
