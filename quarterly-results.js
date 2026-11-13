const schema=`CREATE TABLE IF NOT EXISTS quarterly_results_cache (ticker TEXT PRIMARY KEY,payload TEXT NOT NULL,fetched_at INTEGER NOT NULL)`;
const fields=[
 {key:'sales',label:'Sales',children:[['materialCosts','Material Costs'],['inventoryChanges','Inventory Changes'],['grossRevenue','Gross Revenue']]},
 {key:'expenses',label:'Expenses',children:[['employeeCosts','Employee Costs'],['manufacturingExpenses','Manufacturing Expenses'],['sga','SG&A']]},
 {key:'operatingProfit',label:'Operating Profit'}, {key:'opm',label:'OPM %',rate:true},
 {key:'otherIncome',label:'Other Income',children:[['investmentReturns','Investment Returns'],['forex','Forex'],['miscIncome','Misc Income']]},
 {key:'interest',label:'Interest'}, {key:'depreciation',label:'Depreciation'}, {key:'pbt',label:'Profit before tax'},
 {key:'taxRate',label:'Tax %',rate:true},
 {key:'netProfit',label:'Net Profit',children:[['minorityInterest','Minority Interest'],['continuingOperations','Continuing Operations']]},
 {key:'eps',label:'EPS in Rs / Currency',perShare:true}, {key:'filing',label:'Raw PDF'}
];
const allKeys=[...fields.filter(f=>f.key!=='filing').flatMap(f=>[f.key,...(f.children||[]).map(c=>c[0])]),'taxProvision'];
const additive=allKeys.filter(k=>!['opm','taxRate','eps'].includes(k));
const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
const value=(row,...keys)=>{for(const key of keys){const n=number(row[key]);if(n!==null)return n;}return null;};
const subtract=(a,b)=>a===null||b===null?null:a-b;
const divide=(a,b)=>a===null||b===null||b===0?null:a/b*100;
function dateOf(value){if(value===null||value===undefined||value==='')return null;const d=new Date(typeof value==='number'&&value<1e12?value*1000:value);return Number.isFinite(d.getTime())?d:null;}
// 52/53-week fiscal years may end a few days either side of month-end.
function monthOf(value){const d=dateOf(value);if(!d)return null;return d.getUTCFullYear()*12+d.getUTCMonth()-(d.getUTCDate()<=7?1:0);}
function endDate(month){return new Date(Date.UTC(Math.floor(month/12),month%12+1,0)).toISOString().slice(0,10);}
function normalize(row){
 const sales=value(row,'totalRevenue','operatingRevenue');
 const cost=value(row,'costOfRevenue'),opex=value(row,'operatingExpense');
 const expenses=cost!==null&&opex!==null?cost+opex:value(row,'totalExpenses')??subtract(sales,value(row,'operatingIncome'));
 const operatingProfit=subtract(sales,expenses),pbt=value(row,'pretaxIncome'),taxProvision=value(row,'taxProvision');
 return {sales,expenses,operatingProfit,opm:divide(operatingProfit,sales),otherIncome:value(row,'otherIncomeExpense'),
  interest:value(row,'interestExpense','interestExpenseNonOperating'),depreciation:value(row,'depreciationAndAmortizationInIncomeStatement','depreciationAmortizationDepletionIncomeStatement','reconciledDepreciation'),
  pbt,taxProvision,taxRate:divide(taxProvision,pbt),netProfit:value(row,'netIncomeCommonStockholders','netIncome'),eps:value(row,'dilutedEPS'),
  materialCosts:value(row,'materialCosts'),inventoryChanges:value(row,'inventoryChanges'),grossRevenue:value(row,'grossRevenue'),
  employeeCosts:value(row,'salariesAndWages'),manufacturingExpenses:value(row,'manufacturingExpenses'),sga:value(row,'sellingGeneralAndAdministration'),
  investmentReturns:value(row,'gainOnSaleOfSecurity'),forex:value(row,'foreignExchangeTradingGains'),miscIncome:value(row,'otherNonOperatingIncomeExpenses'),
  minorityInterest:value(row,'minorityInterests'),continuingOperations:value(row,'netIncomeContinuousOperations')};
}
function growth(current,previous){return current===null||previous===null||previous===0?null:(current-previous)/Math.abs(previous)*100;}
function safeFiling(url){try{const u=new URL(url);return u.protocol==='https:'&&['sec.gov','nseindia.com','bseindia.com'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host))?u.href:null;}catch{return null;}}
function filingSearch(ticker){return ticker.endsWith('.NS')?'https://www.nseindia.com/companies-listing/corporate-filings-financial-results':ticker.endsWith('.BO')?'https://www.bseindia.com/corporates/Comp_Resultsnew.aspx':'https://www.sec.gov/edgar/search/#/q='+encodeURIComponent(ticker);}
function buildResults(ticker,raw,annual=[],meta={},now=new Date()){
 const byMonth=new Map(),today=now.toISOString().slice(0,10);
 for(const row of raw){const month=monthOf(row.date);if(month===null||dateOf(row.date)>now||endDate(month)>today||!['3M',undefined].includes(row.periodType))continue;
  const values=normalize(row);if(values.sales===null&&values.netProfit===null&&values.pbt===null)continue;
  const previous=byMonth.get(month);
  byMonth.set(month,{date:endDate(month),reported_period_end:dateOf(row.date).toISOString().slice(0,10),values:Object.fromEntries(allKeys.map(k=>[k,values[k]??previous?.values[k]??null])),derived:[]});
 }
 // A single missing fiscal quarter can be reconstructed from its annual total
 // and the other three quarters. EPS is not additive under changing share counts.
 for(const row of annual){const last=monthOf(row.date);if(last===null||endDate(last)>today||!['12M',undefined].includes(row.periodType))continue;
  const months=[last-9,last-6,last-3,last],year=normalize(row);
  for(const key of additive){const missing=months.filter(m=>byMonth.get(m)?.values[key]==null);
   if(year[key]===null||missing.length!==1)continue;
   const month=missing[0],quarter=byMonth.get(month)||{date:endDate(month),reported_period_end:null,values:Object.fromEntries(allKeys.map(k=>[k,null])),derived:[]};
   quarter.values[key]=year[key]-months.filter(m=>m!==month).reduce((sum,m)=>sum+byMonth.get(m).values[key],0);
   quarter.derived.push(key);byMonth.set(month,quarter);
  }
 }
 for(const q of byMonth.values()){q.values.operatingProfit=subtract(q.values.sales,q.values.expenses);q.values.opm=divide(q.values.operatingProfit,q.values.sales);q.values.taxRate=divide(q.values.taxProvision,q.values.pbt);}
 const available=[...byMonth.keys()].sort((a,b)=>a-b);
 const last=available.at(-1)??(now.getUTCFullYear()*12+Math.floor(now.getUTCMonth()/3)*3-1);
 const quarters=Array.from({length:8},(_,i)=>{
  const m=last-(7-i)*3,q=byMonth.get(m)||{date:endDate(m),reported_period_end:null,values:Object.fromEntries(allKeys.map(k=>[k,null])),derived:[]};
  const filing=(meta.filings||[]).find(f=>f.reportDate&&monthOf(f.reportDate)===m&&safeFiling(f.url||f.edgarUrl));
  return {...q,label:new Date(q.date+'T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'}),
   missing:!byMonth.has(m),filing_url:filing?safeFiling(filing.url||filing.edgarUrl):null,
   yoy:Object.fromEntries(allKeys.map(k=>[k,growth(q.values[k],byMonth.get(m-12)?.values[k]??null)])),
   qoq:Object.fromEntries(allKeys.map(k=>[k,growth(q.values[k],byMonth.get(m-3)?.values[k]??null)]))};
 });
 const four=quarters.slice(-4),ttm={};
 for(const key of allKeys){const values=four.map(q=>q.values[key]);ttm[key]=values.every(v=>v!==null)?values.reduce((a,b)=>a+b,0)/(['opm','taxRate'].includes(key)?4:1):null;}
 const previousEPS=quarters.slice(-5,-1).map(q=>q.values.eps);
 const priorTTMEPS=previousEPS.every(v=>v!==null)?previousEPS.reduce((a,b)=>a+b,0):null;
 // Keep price fixed to isolate the earnings change; do not mix reporting currencies.
 const price=number(meta.price),comparable=meta.currency&&meta.price_currency===meta.currency&&price>0;
 const peAt=eps=>comparable&&eps>0?number(price/eps):null;
 const pe_comparison={before:peAt(priorTTMEPS),after:peAt(ttm.eps),price,price_as_of:meta.price_as_of||null};
 const currency=meta.currency||(/\.(NS|BO)$/.test(ticker)?'INR':'USD');
 return {ticker,name:meta.name||ticker,currency,currency_inferred:!meta.currency,pe_comparison,fields,quarters,ttm,
  latest_period:available.length?endDate(last):null,latest_result_date:available.length&&dateOf(meta.latest_result_date)>dateOf(endDate(last))&&dateOf(meta.latest_result_date)<=now?dateOf(meta.latest_result_date).toISOString().slice(0,10):null,pe:number(meta.pe),
  filing_search_url:filingSearch(ticker),filings:(meta.filings||[]).map(f=>({date:f.date,type:f.type,url:safeFiling(f.url||f.edgarUrl)})).filter(f=>f.url),
  coverage:{reported:quarters.filter(q=>q.reported_period_end).length,derived:quarters.filter(q=>q.derived.length).length,missing:quarters.filter(q=>q.missing).length},
  notes:['Eight consecutive fiscal quarters ending at the latest available result. Missing values are not zero.','† Backfilled from annual total minus three reported quarters; diluted EPS is never backfilled this way.','TTM sums the latest four quarters; OPM and tax rate are arithmetic averages. Incomplete TTM fields remain unavailable.','Expenses use cost of revenue plus operating expenses where available. Operating profit = Sales − Expenses. Yahoo classification can differ from Screener, especially for banks.','Breakdowns show only explicitly reported fields and may not reconcile to totals. Investment Returns is reported gains on securities; Forex is reported trading gains.','Raw PDF links appear only when a period-matched exchange filing is available; Find filing opens the official filing search.']};
}
const validTicker=t=>typeof t==='string'&&/^[A-Z0-9][A-Z0-9&._-]{0,39}$/.test(t)&&!t.includes('..');
function createQuarterlyResults({yf,db,now=()=>new Date()}){
 const pending=new Map(),searchCache=new Map();
 async function get(ticker){
  if(!validTicker(ticker))throw Object.assign(Error('Enter a valid Yahoo ticker.'),{status:400});
  if(pending.has(ticker))return pending.get(ticker);
  const work=load(ticker);pending.set(ticker,work);try{return await work;}finally{pending.delete(ticker);}
 }
 async function load(ticker){
  const saved=await db.prepare('SELECT payload,fetched_at FROM quarterly_results_cache WHERE ticker=?').get(ticker);
  const old=saved?JSON.parse(saved.payload):null,time=now();
  if(old&&old.summary_version===2&&time.getTime()-saved.fetched_at<6*3600000)return {...buildResults(ticker,old.raw,old.annual,old.meta,time),fetched_at:new Date(saved.fetched_at).toISOString(),cached:true};
  let raw;
  try{raw=await yf.fundamentalsTimeSeries(ticker,{period1:new Date(Date.UTC(time.getUTCFullYear()-3,time.getUTCMonth(),1)),type:'quarterly',module:'all'});}
  catch{if(old)return {...buildResults(ticker,old.raw,old.annual,old.meta,time),fetched_at:new Date(saved.fetched_at).toISOString(),stale:true,warning:'Yahoo is unavailable. Showing the last saved results.'};throw Object.assign(Error('Yahoo quarterly results are unavailable. Please retry.'),{status:502});}
  if(!Array.isArray(raw))throw Object.assign(Error('Invalid quarterly results response.'),{status:502});
  let meta=old?.meta||{},annual=old?.annual||[];
  const merge=(older,newer)=>{const map=new Map(older.map(r=>[String(r.date),r]));for(const row of newer){const key=dateOf(row.date)?.toISOString();if(key)map.set(key,{...map.get(key),...row,date:key});}return [...map.values()].sort((a,b)=>dateOf(a.date)-dateOf(b.date)).slice(-24);};
  raw=merge(old?.raw||[],raw);
  let quoteMeta={};
  const jobs=[yf.quoteSummary(ticker,{modules:['price','financialData','secFilings']}).then(s=>{meta={name:s.price?.longName||s.price?.shortName||ticker,currency:s.financialData?.financialCurrency,filings:s.secFilings?.filings||[]};})];
  const initial=buildResults(ticker,raw,annual,meta,time);
  if(initial.coverage.reported<8){
   const start=new Date(Date.UTC(time.getUTCFullYear()-5,0,1));
   jobs.push(yf.fundamentalsTimeSeries(ticker,{period1:start,type:'quarterly',module:'all'}).then(rows=>{raw=merge(raw,rows);}));
   jobs.push(yf.fundamentalsTimeSeries(ticker,{period1:start,type:'annual',module:'all'}).then(rows=>{annual=merge(annual,rows);}));
  }
  if(typeof yf.quote==='function')jobs.push(yf.quote(ticker).then(q=>{quoteMeta={pe:number(q.trailingPE),price:number(q.regularMarketPrice),price_currency:q.currency||null,price_as_of:dateOf(q.regularMarketTime)?.toISOString()||null,latest_result_date:q.isEarningsDateEstimate===true?null:dateOf(q.earningsTimestamp)?.toISOString()||null};}));
  await Promise.allSettled(jobs);
  meta={...meta,...quoteMeta};
  const result=buildResults(ticker,raw,annual,meta,time);
  if(!result.latest_period)throw Object.assign(Error('No quarterly income statements are available for this ticker.'),{status:404});
  await db.prepare('INSERT INTO quarterly_results_cache(ticker,payload,fetched_at) VALUES (?,?,?) ON CONFLICT(ticker) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at').run(ticker,JSON.stringify({raw,annual,meta,summary_version:2}),time.getTime());
  return {...result,fetched_at:time.toISOString(),cached:false};
 }
 async function search(query){
  if(typeof query!=='string'||query.trim().length<2||query.length>80)throw Object.assign(Error('Enter 2–80 characters.'),{status:400});
  const key=query.trim().toUpperCase(),cached=searchCache.get(key);if(cached&&cached.until>Date.now())return cached.rows;
  let found;try{found=await yf.search(query,{quotesCount:15,newsCount:0});}catch{throw Object.assign(Error('Stock search is unavailable. Please retry.'),{status:502});}
  const rows=(found.quotes||[]).filter(q=>q.quoteType==='EQUITY'&&validTicker(q.symbol)&&(/\.(NS|BO)$/.test(q.symbol)||['NMS','NYQ','NGM','NCM','ASE','PCX'].includes(q.exchange))).map(q=>({ticker:q.symbol,name:q.longname||q.shortname||q.symbol,exchange:q.exchDisp||q.exchange}));
  if(searchCache.size>=100)searchCache.delete(searchCache.keys().next().value);searchCache.set(key,{rows,until:Date.now()+300000});return rows;
 }
 return {get,search};
}
module.exports={schema,fields,normalize,buildResults,createQuarterlyResults,validTicker,monthOf};
