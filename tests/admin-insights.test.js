const {test}=require('node:test'),assert=require('node:assert/strict');
const {leaderboard,uniqueStocks}=require('../admin-insights');
const {matchStock}=require('../stock-code-settings');
test('leaderboard uses all cash flows, terminal value, missing-price and unranked handling',()=>{
 const users=[{id:1,name:'A'},{id:2,name:'B'},{id:3,name:'C'}];
 const stocks=[{ticker:'NSE:A',stock_code:'NSE:A',yahoo_finance_code:'A.NS',cmp:120,name:'Alpha',code:'A1'}];
 const holdings=[{user_id:1,ticker:'NSE:A',shares:5},{user_id:2,ticker:'NSE:MISSING',shares:1}];
 let calls=0;
 const rows=leaderboard(users,holdings,[{user_id:1,type:'BUY',amount:1000,traded_at:'2020-01-01'},{user_id:1,type:'SELL',amount:600,traded_at:'2021-01-01'}],stocks,flows=>{calls++;assert.deepEqual(flows.map(f=>f.amount),[-1000,600,600]);return 12.5;},matchStock,new Date('2022-01-01'));
 assert.equal(calls,1);assert.equal(rows[0].rank,1);assert.equal(rows[0].current_value,600);assert.equal(rows[1].xirr_pct,null);assert.equal(rows[2].rank,null);
});
test('stock API deduplicates portfolio/watchlist aliases and returns only stock metadata',()=>{
 const stocks=[{ticker:'NSE:A',stock_code:'NSE:A',yahoo_finance_code:'A.NS',code:'A1',name:'Alpha'}];
 const rows=uniqueStocks([{ticker:'A1',user_id:1},{ticker:'NSE:B',stock_name:'Beta',ok_code:'B1'}],[{ticker:'NSE:A',user_id:2}],stocks,matchStock);
 assert.deepEqual(rows,[{ticker:'NSE:A',stock_code:'NSE:A',yahoo_finance_code:'A.NS',name:'Alpha',code:'A1'},{ticker:'NSE:B',stock_code:'NSE:B',yahoo_finance_code:'NSE:B',name:'Beta',code:'B1'}]);
});
test('stock API preserves full stock code alongside the internal ticker',()=>{
 const stocks=[{ticker:'500655',stock_code:'BOM:500655',yahoo_finance_code:'GRWRHITECH.BO',name:'Garware',code:''}];
 const rows=uniqueStocks([{ticker:'BOM:500655'}],[{ticker:'500655'}],stocks,matchStock);
 assert.deepEqual(rows,[{ticker:'500655',stock_code:'BOM:500655',yahoo_finance_code:'GRWRHITECH.BO',name:'Garware',code:''}]);
});
