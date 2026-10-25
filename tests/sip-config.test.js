const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {validateSIPConfig}=require('../sip-config-validation');
const valid=()=>({max_budget:50000,levels:[10,5,20,10,30,15,10].map((allocation,i)=>({fall:-10-i*5,allocation}))});
test('SIP validation rejects invalid totals, budgets, falls and malformed inputs',()=>{
  assert.deepEqual(validateSIPConfig(valid()),valid());
  for(const value of [null,{}, {...valid(),max_budget:-1},{...valid(),max_budget:Infinity},{...valid(),levels:{}},{...valid(),levels:[]}]){
    assert.throws(()=>validateSIPConfig(value));
  }
  for(const [field,value] of [['fall',0],['fall',-100],['fall',NaN],['fall','-10'],['allocation',-1],['allocation',101],['allocation',NaN],['allocation',11]]){
    const config=valid();config.levels[0][field]=value;
    assert.throws(()=>validateSIPConfig(config));
  }
  const duplicate=valid();duplicate.levels[1].fall=-10;
  assert.throws(()=>validateSIPConfig(duplicate),/order/);
  const decimals=valid();decimals.levels[0].allocation=10.1;decimals.levels[1].allocation=4.9;
  assert.doesNotThrow(()=>validateSIPConfig(decimals));
});
test('actual SIP save route validates before writing and scopes persistence to the user',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
  const start=source.indexOf('app.put("/api/sip-config"');
  const route=source.slice(start,source.indexOf('\n});',start)+4);
  let handler,writes=[];
  vm.runInNewContext(route,{app:{put:(_p,_a,fn)=>handler=fn},auth:()=>{},validateSIPConfig,db:{prepare:()=>({run:async(...args)=>writes.push(args)})}});
  const call=async body=>{
    let status=200,result;
    await handler({user:{id:42},body},{status(code){status=code;return this;},json(value){result=value;}});
    return {status,...result};
  };
  const invalid=valid();invalid.levels[0].allocation=0;
  assert.equal((await call(invalid)).status,400);
  assert.equal(writes.length,0);
  assert.equal((await call(valid())).success,true);
  assert.equal(writes[0][0],42);
  assert.deepEqual(JSON.parse(writes[0][2]),valid().levels);
});
test('browser validator can be served directly from the bundled function',()=>{
  const context={};
  vm.runInNewContext(`globalThis.validateSIPConfig = ${validateSIPConfig.toString()};`,context);
  assert.equal(context.validateSIPConfig(valid()).max_budget,50000);
  const invalid=valid();invalid.levels[0].allocation=1;
  assert.throws(()=>context.validateSIPConfig(invalid),/100%/);
});
test('accepts one, three, and more than seven custom levels while preserving order and total validation',()=>{
 for(const count of [1,3,9,15]){
   const config={max_budget:1000,levels:Array.from({length:count},(_,i)=>({fall:-(i+1)*5,allocation:100/count}))};
   assert.equal(validateSIPConfig(config).levels.length,count);
 }
 const unordered={max_budget:1000,levels:[{fall:-20,allocation:50},{fall:-10,allocation:50}]};
 assert.throws(()=>validateSIPConfig(unordered),/order/);
});
