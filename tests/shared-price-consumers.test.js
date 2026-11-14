const {test}=require('node:test'),assert=require('node:assert/strict');
const {createYahooPrices,TTL}=require('../yahoo-prices');
const {leaderboard}=require('../admin-insights');
const {matchStock}=require('../stock-code-settings');
test('bulk screens use Yahoo cache, preserve config, clear missing mirror values, and never call provider',async()=>{
 const db={prepare:sql=>({all:async()=>sql.includes('yahoo_symbol_aliases')?[{stock_code:'BOM:500655',yahoo_symbol:'GARWARE.BO'}]:[{yahoo_symbol:'GARWARE.BO',fetched_at:1000,data_json:JSON.stringify({ticker:'OTHER',price:150,ath:200,ath_date:'2024-01-01',source:'YAHOO_FINANCE'})}]})};
 const service=createYahooPrices({db,yf:new Proxy({},{get(){throw Error('Unexpected provider access');}}),now:()=>1000+TTL});
 const rows=await service.readStocks([{ticker:'500655',code:'CODE1',yahoo_finance_code:'BOM:500655',cmp:999},{ticker:'MISSING',yahoo_finance_code:'MISSING.NS',cmp:999,ath:999}]);
 assert.equal(rows[0].cmp,150);assert.equal(rows[0].ticker,'500655');assert.equal(rows[0].code,'CODE1');assert.equal(rows[0].stale,true);
 assert.equal(rows[1].cmp,null);assert.equal(rows[1].ath,null);assert.ok(rows[1].quote_error);
 const result=leaderboard([{id:1},{id:2}],[{user_id:1,ticker:'500655',shares:2},{user_id:2,ticker:'MISSING',shares:1}],[1,2].map(user_id=>({user_id,ticker:user_id===1?'500655':'MISSING',type:'BUY',amount:100,traded_at:'2020-01-01'})),rows,flows=>{assert.equal(flows.at(-1).amount,300);return 10;},matchStock,new Date('2026-01-01'));
 assert.equal(result[0].xirr_pct,10);assert.equal(result[1].xirr_pct,null);assert.equal(result[1].status,'Missing stock price');
});
test('portfolio displays the server XIRR without recalculating from remaining holdings',()=>{
 const fs=require('fs'),vm=require('vm');const html=fs.readFileSync('onepiece.html','utf8');
 const source=html.slice(html.indexOf('function calcPortfolioXIRR(){'),html.indexOf('// -- XIRR MODAL'));
 const ctx={portfolioXirrEligible:true,portfolioXirrPct:12.34,portfolioHoldings:[],priceMap:{}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 assert.equal(ctx.calcPortfolioXIRR(),12.34);
 for(const value of [null,undefined,NaN,Infinity]){ctx.portfolioXirrPct=value;assert.equal(ctx.calcPortfolioXIRR(),null);}
 ctx.portfolioXirrPct=12.34;ctx.portfolioXirrEligible=false;assert.equal(ctx.calcPortfolioXIRR(),null);
});
