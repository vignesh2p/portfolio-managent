const FREE_LIMITS={storage_bytes:5e9,rows_read:500e6,rows_written:10e6,bytes_synced:3e9,databases:100};
const identifier=value=>'"'+String(value).replace(/"/g,'""')+'"';
const numeric=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;

async function platformUsage(env,fetcher,now){
 const from=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString();
 const period={from,to:now.toISOString(),timezone:'UTC',label:'Calendar month to date'};
 if(!env.TURSO_PLATFORM_API_TOKEN||!env.TURSO_ORGANIZATION||!env.TURSO_DATABASE_NAME)return {status:'not_configured',period};
 try{
  const url=new URL(`https://api.turso.tech/v1/organizations/${encodeURIComponent(env.TURSO_ORGANIZATION)}/databases/${encodeURIComponent(env.TURSO_DATABASE_NAME)}/usage`);
  url.searchParams.set('from',from);url.searchParams.set('to',period.to);
  const response=await fetcher(url,{headers:{Authorization:'Bearer '+env.TURSO_PLATFORM_API_TOKEN},signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)throw Error('Unavailable');
  const total=(await response.json()).database?.total;
  if(!total)throw Error('Unavailable');
  return {status:'available',period,...Object.fromEntries(['storage_bytes','rows_read','rows_written','bytes_synced'].map(key=>[key,numeric(total[key])]))};
 }catch{return {status:'unavailable',period};}
}

function createDatabaseUsage({db,systemEmail,env=process.env,fetcher=globalThis.fetch,now=()=>new Date()}){
 let cache,pending;
 async function collect(){
  const timestamp=now();
  const users=(await db.prepare('SELECT id,name,email,account_status FROM users ORDER BY id').all()).map(u=>({...u,system:u.email===systemEmail,rows:0,estimated_bytes:0,tables:[]}));
  const byId=new Map(users.map(u=>[Number(u.id),u]));
  const tables=await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  let storage_bytes=null,free_bytes=null;
  try{
   const page=await db.prepare('PRAGMA page_size').get(),count=await db.prepare('PRAGMA page_count').get(),free=await db.prepare('PRAGMA freelist_count').get();
   const size=numeric(page?.page_size),pages=numeric(count?.page_count),unused=numeric(free?.freelist_count);
   if(size!==null&&pages!==null)storage_bytes=size*pages;
   if(size!==null&&unused!==null)free_bytes=size*unused;
  }catch{}
  const breakdown=[];let sharedRows=0,sharedBytes=0;
  for(const {name} of tables){
   const columns=await db.prepare(`PRAGMA table_info(${identifier(name)})`).all();
   const names=new Set(columns.map(c=>c.name));
   // Aggregate lengths inside SQL: no passwords, tokens or row contents leave the database.
   const bytes=columns.map(c=>{const column='t.'+identifier(c.name);return `CASE WHEN ${column} IS NULL THEN 0 WHEN typeof(${column}) IN ('integer','real') THEN 8 ELSE length(CAST(${column} AS BLOB)) END`;}).join('+')||'0';
   let owner='NULL',join='';
   if(name==='users')owner='t.id';
   else if(names.has('user_id'))owner='t.user_id';
   else if(name==='user_watchlist_items'){owner='w.user_id';join=' LEFT JOIN user_watchlists w ON w.id=t.watchlist_id';}
   else if(name==='tax_family_codes')owner='t.subject_id';
   else if(name==='tax_family_links')owner='t.viewer_id';
   const groups=await db.prepare(`SELECT ${owner} AS owner_id,COUNT(*) AS rows,COALESCE(SUM(${bytes}),0) AS estimated_bytes FROM ${identifier(name)} t${join} GROUP BY ${owner}`).all();
   const table={name,rows:0,estimated_bytes:0};
   for(const group of groups){
    const rows=Number(group.rows),estimated_bytes=Number(group.estimated_bytes);
    table.rows+=rows;table.estimated_bytes+=estimated_bytes;
    const user=group.owner_id===null?null:byId.get(Number(group.owner_id));
    if(user){user.rows+=rows;user.estimated_bytes+=estimated_bytes;user.tables.push({name,rows,estimated_bytes});}
    else{sharedRows+=rows;sharedBytes+=estimated_bytes;}
   }
   breakdown.push(table);
  }
  const provider=await platformUsage(env,fetcher,timestamp);
  return {as_of:timestamp.toISOString(),cache_seconds:300,storage_bytes,free_bytes,
   total_rows:breakdown.reduce((sum,t)=>sum+t.rows,0),estimated_bytes:breakdown.reduce((sum,t)=>sum+t.estimated_bytes,0),
   shared:{rows:sharedRows,estimated_bytes:sharedBytes},tables:breakdown.sort((a,b)=>b.estimated_bytes-a.estimated_bytes),
   users:users.sort((a,b)=>b.estimated_bytes-a.estimated_bytes),provider,
   free_plan:{limits:FREE_LIMITS,source:'https://turso.tech/pricing',checked_on:'2026-11-14',scope:'Organization-wide reference; current subscription and other databases are not included.'}};
 }
 async function get(){
  if(cache&&now().getTime()-Date.parse(cache.as_of)<300000)return cache;
  if(!pending)pending=collect().then(result=>(cache=result)).finally(()=>{pending=null;});
  return pending;
 }
 function register(app,adminAuth){app.get('/api/admin/database-usage',adminAuth,async(req,res)=>{
  res.set('Cache-Control','no-store');
  try{res.json({success:true,data:await get()});}catch{res.status(503).json({success:false,error:'Unable to load database usage. Please retry.'});}
 });}
 return {get,register};
}
module.exports={createDatabaseUsage,platformUsage,FREE_LIMITS};
