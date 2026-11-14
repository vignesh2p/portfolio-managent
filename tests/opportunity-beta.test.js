const {test}=require('node:test'),assert=require('node:assert/strict');
const {applyOpportunityBeta,actualInvested}=require('../opportunity-beta');
const levels=[10,15,20,25,30].map((allocation,i)=>({fall:-10*(i+1),allocation,allocated_amount:allocation*500,active:i===2}));
const buy=(amount,shares=1,ticker='A')=>({type:'BUY',price:amount/shares,shares,ticker});
test('requirement example: cumulative targets, partial carry and whole shares',()=>{
 const result=applyOpportunityBeta(levels,[buy(8000)],50000,100,150);
 assert.deepEqual(result.map(l=>l.cumulative_allocation),[5000,12500,22500,35000,50000]);
 assert.equal(result[2].carry_forward_amount,4500);assert.equal(result[2].suggested_investment,14500);assert.equal(result[2].suggested_quantity,145);
});
test('skipped, partly funded, overfunded and completed levels never double count carry',()=>{
 for(const [invested,carry,suggested] of [[0,12500,22500],[8000,4500,14500],[12500,0,10000],[20000,0,2500],[22500,0,0],[60000,0,0]]){
  const result=applyOpportunityBeta(levels,[buy(invested)],50000,103,150)[2];
  assert.equal(result.carry_forward_amount,carry);assert.equal(result.suggested_investment,suggested);
  assert.equal(result.suggested_quantity,Math.floor(suggested/103));assert.ok(result.suggested_quantity*103<=suggested);
 }
});
test('sales release average cost, bonus shares add no cost, aliases keep separate cost bases',()=>{
 const trades=[buy(8000,80),{ticker:'A',type:'SELL',shares:20,price:200}];
 assert.equal(actualInvested(trades),6000);
 assert.equal(applyOpportunityBeta(levels,trades,50000,100,150)[2].suggested_investment,16500);
 assert.equal(actualInvested([buy(8000,80),buy(0,80),{ticker:'A',type:'SELL',shares:80,price:50}]),4000);
 assert.equal(actualInvested([buy(8000,80),{ticker:'A',type:'SELL',shares:80,price:50},buy(2000,20)]),2000);
 assert.equal(actualInvested([buy(8000,80),buy(4000,80,'ALIAS'),{ticker:'A',type:'SELL',shares:40,price:200}]),8000);
});
test('dynamic configurations and expanded budgets stay capped without mutating inputs',()=>{
 const before=JSON.stringify(levels);
 assert.equal(applyOpportunityBeta(levels,[buy(8000)],100000,100,150)[2].suggested_investment,37000);
 const changed=[{fall:-5,allocation:40},{fall:-15,allocation:80}];
 assert.deepEqual(applyOpportunityBeta(changed,[],50000,100,150).map(l=>l.cumulative_allocation),[20000,50000]);
 assert.equal(applyOpportunityBeta([{allocation:100}],[],50000,100,150)[0].suggested_quantity,500);
 assert.equal(JSON.stringify(levels),before);
});
test('missing prices do not invent quantity; missing investment data blocks recommendations',()=>{
 for(const price of [null,undefined,0,-1,NaN,Infinity]){
  const level=applyOpportunityBeta(levels,[],50000,price,150)[2];assert.equal(level.suggested_quantity,null);assert.equal(level.active,false);assert.equal(level.suggested_investment,22500);
 }
 for(const trades of [null,[{type:'BUY',shares:1,price:null}],[buy(Infinity)]])assert.equal(applyOpportunityBeta(levels,trades,50000,100,150)[2].suggested_investment,null);
 assert.equal(applyOpportunityBeta(levels,[],50000,100,150,8000)[2].suggested_investment,14500);
 assert.equal(applyOpportunityBeta(levels,[],50000,100,150,NaN)[2].suggested_investment,null);
 assert.equal(applyOpportunityBeta([{allocation:-1}],[],50000,100,150)[0].suggested_investment,null);
});
test('fractional spending and tiny CMP respect whole-share budgets',()=>{
 assert.equal(applyOpportunityBeta([33.33,33.33,33.34].map(allocation=>({allocation})),[],100.01,1,2)[2].cumulative_allocation,100.01);
 const l=applyOpportunityBeta([{allocation:100}],[buy(49.99)],300,0.1,100)[0];assert.equal(l.suggested_investment,250.01);assert.ok(l.suggested_quantity*0.1<=250.01);
});
