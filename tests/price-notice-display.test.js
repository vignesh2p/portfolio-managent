const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const notice='Cached Yahoo price is older than 5 minutes; refresh pending.';
for(const [name,file,start,end] of [
 ['customer','onepiece.html','async function api(','async function adminApi('],
 ['embedded admin','onepiece.html','async function adminApi(','function showPublicPage('],
 ['admin','admin.html','async function fetchJson(','async function doLogin(']
])test(name+' hides only redundant quote notices and preserves freshness and real errors',async()=>{
 const payload={success:true,summary:{message:notice},data:[{quote_error:notice,stale:true,price:100,quote_fetched_at:'2026-11-15T03:00:00Z'},{quote_error:'ATH unavailable: provider error',price:null},{nested:{quote_error:notice}}]};
 const source=fs.readFileSync(file,'utf8'),ctx={BASE:'',TOKEN:null,ADMIN_TOKEN:null,adminToken:null,accountUnavailable:false,fetch:async()=>({status:200,text:async()=>JSON.stringify(payload)})};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end)),ctx);
 const result=await ctx[name==='customer'?'api':name==='admin'?'fetchJson':'adminApi']('/test');
 assert.equal(result.data[0].quote_error,null);assert.equal(result.data[0].stale,true);assert.equal(result.data[0].price,100);assert.equal(result.data[0].quote_fetched_at,payload.data[0].quote_fetched_at);assert.equal(result.data[1].quote_error,payload.data[1].quote_error);assert.equal(result.data[2].nested.quote_error,null);assert.equal(result.summary.message,notice);
});
test('admin page mirror matches its source and portfolio footer has no repeated age warning',()=>{
 assert.equal(require('../admin-page')(),fs.readFileSync('admin.html','utf8'));
 assert.doesNotMatch(fs.readFileSync('onepiece.html','utf8'),/Some prices are older than 30 minutes/);
});
