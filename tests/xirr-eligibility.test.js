const {test}=require('node:test'),assert=require('node:assert/strict');
const {xirrEligible}=require('../xirr-eligibility');
const buy=(date,shares=10)=>({type:'BUY',traded_at:date,shares,amount:1000});
test('strict calendar anniversary, leap years, missing/future dates and bonus shares',()=>{
 const trades=[buy('2025-10-24')];
 assert.equal(xirrEligible(trades,false,new Date('2026-10-24T20:00:00+05:30')),false);
 assert.equal(xirrEligible(trades,false,new Date('2026-10-25T00:00:00+05:30')),true);
 assert.equal(xirrEligible([buy('2024-02-29')],false,new Date('2025-02-28')),false);
 assert.equal(xirrEligible([buy('2024-02-29')],false,new Date('2025-03-01')),true);
 assert.equal(xirrEligible([buy('invalid')]),false);assert.equal(xirrEligible([]),false);
 assert.equal(xirrEligible([buy('2099-01-01')]),false);
 assert.equal(xirrEligible([buy('2020-01-01'),{...buy('2026-01-01'),amount:0}],false,new Date('2026-10-24')),true);
});
test('partial sales preserve holding age, full sales reset it, portfolio uses inception',()=>{
 const history=[buy('2020-01-01'),{type:'SELL',traded_at:'2025-01-01',shares:5}];
 const now=new Date('2026-10-24');assert.equal(xirrEligible(history,false,now),true);
 history.push({type:'SELL',traded_at:'2025-02-01',shares:5});assert.equal(xirrEligible(history,false,now),false);
 history.push(buy('2026-05-01'));assert.equal(xirrEligible(history,false,now),false);assert.equal(xirrEligible(history,true,now),true);
});
test('server, browser and leaderboard gate XIRR',()=>{
 const fs=require('fs'),vm=require('vm'),path=require('path');
 const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const fn=server.slice(server.indexOf('function computeXIRR('),server.indexOf('// Admin manages'));
 const ctx={xirrEligible,xirr:()=>99};vm.createContext(ctx);vm.runInContext(fn,ctx);
 assert.equal(ctx.computeXIRR([buy(new Date().toISOString())],120),null);
 const html=fs.readFileSync(path.join(__dirname,'../onepiece.html'),'utf8');
 for(const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(script[1]);
 const code=html.slice(html.indexOf('function calcXIRR('),html.indexOf('// -- XIRR MODAL'));
 const browser={xirrEligible,cashflowsFromTrades:()=>[],xirrFromCashflows:()=>99};vm.createContext(browser);vm.runInContext(code,browser);
 assert.equal(browser.calcXIRR([buy(new Date().toISOString())],120),null);assert.equal(browser.calcPortfolioXIRR(),null);
 const {leaderboard}=require('../admin-insights');
 const rows=leaderboard([{id:1}],[],[{...buy('2026-01-01'),user_id:1}],[],()=>99,()=>null,new Date('2026-10-24'));
 assert.equal(rows[0].xirr_pct,null);assert.equal(rows[0].rank,null);
});
