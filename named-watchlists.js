const schema = [
  `CREATE TABLE IF NOT EXISTS user_watchlists (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),name TEXT NOT NULL COLLATE NOCASE,all_stocks INTEGER NOT NULL DEFAULT 0,UNIQUE(user_id,slot),UNIQUE(user_id,name))`,
  `CREATE TABLE IF NOT EXISTS user_watchlist_items (watchlist_id INTEGER NOT NULL REFERENCES user_watchlists(id),ticker TEXT NOT NULL,PRIMARY KEY(watchlist_id,ticker))`
];
function fail(status,message){throw Object.assign(new Error(message),{status});}
function createWatchlists({db,transactionRaw,systemId,readPrices=async rows=>rows,discovery}){
  async function lists(uid){
    await db.prepare("INSERT OR IGNORE INTO user_watchlists(user_id,slot,name,all_stocks) VALUES (?,1,'Default watchlist',1)").run(uid);
    return db.prepare('SELECT * FROM user_watchlists WHERE user_id=? ORDER BY slot').all(uid);
  }
  async function selected(uid,id){
    const available=await lists(uid);
    const list=id?available.find(x=>x.id===Number(id)):available[0];
    if(!list)fail(404,'Watchlist not found');
    return list;
  }
  async function universe(){return readPrices(await db.prepare('SELECT * FROM watchlist WHERE user_id=? ORDER BY name,ticker').all(await systemId()));}
  async function stocks(uid,id){
    const list=await selected(uid,id),all=await universe();
    if(Number(list.slot)===1)return all.filter(stock=>Number(stock.in_default_watchlist)!==0);
    if(list.all_stocks)return all;
    const members=await db.prepare('SELECT ticker FROM user_watchlist_items WHERE watchlist_id=?').all(list.id);
    const tickers=new Set(members.map(x=>x.ticker));
    return all.filter(x=>tickers.has(x.ticker));
  }
  async function save(uid,id,body){
    const name=typeof body.name==='string'?body.name.trim():'';
    if(!name||name.length>60)fail(400,'Watchlist name must contain 1–60 characters');
    if(!Array.isArray(body.tickers)||body.tickers.some(t=>typeof t!=='string'))fail(400,'Select stocks from the stock universe');
    const tickers=[...new Set(body.tickers)],allowed=new Set((await universe()).map(x=>x.ticker));
    if(tickers.some(t=>!allowed.has(t)))fail(400,'Only stocks from the stock universe can be added');
    const available=await lists(uid);
    if(id){const target=available.find(x=>x.id===Number(id));if(!target)fail(404,'Watchlist not found');if(Number(target.slot)===1)fail(403,'The default watchlist cannot be edited or renamed.');}
    else if(available.length>=3)fail(400,'You can create a maximum of 3 watchlists');
    const prepared=discovery?await discovery.prepare(body.discovered||[]):[];
    return transactionRaw(async tx=>{
      const rows=(await tx.execute({sql:'SELECT * FROM user_watchlists WHERE user_id=? ORDER BY slot',args:[uid]})).rows;
      let list=id?rows.find(x=>x.id===Number(id)):null;
      if(id&&!list)fail(404,'Watchlist not found');
      if(list?.slot===1)fail(403,'The default watchlist cannot be edited or renamed.');
      if(rows.some(x=>x.id!==list?.id&&x.name.toLowerCase()===name.toLowerCase()))fail(400,'Choose a different watchlist name');
      if(!id){
        const slot=[1,2,3].find(s=>!rows.some(x=>x.slot===s));
        if(!slot)fail(400,'You can create a maximum of 3 watchlists');
        const result=await tx.execute({sql:'INSERT INTO user_watchlists(user_id,slot,name) VALUES (?,?,?)',args:[uid,slot,name]});
        list={id:Number(result.lastInsertRowid)};
      }
      await tx.execute({sql:'UPDATE user_watchlists SET name=?,all_stocks=0 WHERE id=? AND user_id=?',args:[name,list.id,uid]});
      await tx.execute({sql:'DELETE FROM user_watchlist_items WHERE watchlist_id=?',args:[list.id]});
      const discovered=discovery?await discovery.insert(tx,prepared):[];
      for(const ticker of new Set([...tickers,...discovered]))await tx.execute({sql:'INSERT INTO user_watchlist_items(watchlist_id,ticker) VALUES (?,?)',args:[list.id,ticker]});
      return {id:list.id};
    });
  }
  function register(app,auth){
    const wrap=fn=>async(req,res)=>{try{res.set('Cache-Control','no-store');res.json({success:true,data:await fn(req)});}catch(e){res.status(e.status||500).json({success:false,error:e.message});}};
    app.get('/api/watchlists',auth,wrap(req=>lists(req.user.id)));
    if(discovery)app.get('/api/stocks/search',auth,wrap(req=>discovery.search(req.query.q)));
    app.get('/api/stocks/universe',auth,wrap(()=>universe()));
    app.get('/api/watchlists/:id/stocks',auth,wrap(req=>stocks(req.user.id,req.params.id)));
    app.post('/api/watchlists',auth,wrap(req=>save(req.user.id,null,req.body)));
    app.put('/api/watchlists/:id',auth,wrap(req=>save(req.user.id,req.params.id,req.body)));
    app.delete('/api/watchlists/:id',auth,wrap(async req=>{
      const list=await selected(req.user.id,req.params.id);
      if(list.slot===1)fail(400,'The default watchlist cannot be deleted');
      await transactionRaw(async tx=>{
        await tx.execute({sql:'DELETE FROM user_watchlist_items WHERE watchlist_id=?',args:[list.id]});
        await tx.execute({sql:'DELETE FROM user_watchlists WHERE id=? AND user_id=?',args:[list.id,req.user.id]});
      });return {deleted:true};
    }));
  }
  return {lists,stocks,universe,register,save};
}
module.exports={schema,createWatchlists};
