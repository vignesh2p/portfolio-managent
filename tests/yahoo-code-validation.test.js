const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateYahooCodes}=require('../yahoo-code-validation');
test('validates Yahoo equities, deduplicates, and separates outages',async()=>{
 const calls=[];
 const yf={quote:async symbol=>{calls.push(symbol);if(symbol==='FAIL.NS')throw new Error('timeout');if(symbol==='MISSING.NS')return undefined;return {symbol,quoteType:symbol==='FUND.NS'?'ETF':'EQUITY'};}};
 const result=await validateYahooCodes(yf,['ABC.NS','MISSING.NS','','FUND.NS','FAIL.NS','ABC.NS']);
 assert.deepEqual(result.map(row=>row.status),['valid','invalid','invalid','invalid','unavailable','valid']);
 assert.deepEqual(calls,['ABC.NS','MISSING.NS','FUND.NS','FAIL.NS']);
 assert.equal(result[0].symbol,'ABC.NS');
 assert.equal((await validateYahooCodes({quote:async()=>({symbol:'WRONG.NS',quoteType:'EQUITY'})},['ABC.NS']))[0].status,'invalid');
});
test('exchange-prefixed Sky Gold code is invalid even though its normalized symbol exists',async()=>{
 const calls=[];
 const yf={quote:async symbol=>{calls.push(symbol);return {symbol,quoteType:'EQUITY'};}};
 const rows=await validateYahooCodes(yf,['NSE:SKYGOLD','SKYGOLD.NS','BSE:SKYGOLD','BOM:SKYGOLD']);
 assert.deepEqual(rows.map(row=>row.status),['invalid','valid','invalid','invalid']);
 assert.match(rows[0].message,/Use Yahoo symbol SKYGOLD\.NS/);
 assert.match(rows[2].message,/SKYGOLD\.BO/);
 assert.deepEqual(calls,['SKYGOLD.NS']);
});
test('bounds validation requests',async()=>{
 for(const codes of [null,[],Array(11).fill('ABC.NS'),[{}],['a'.repeat(55)]])await assert.rejects(validateYahooCodes({},codes),{status:400});
});
