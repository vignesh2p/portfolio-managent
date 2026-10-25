const {indiaDate}=require('./rebalancing');
const schema=[
 `CREATE TABLE IF NOT EXISTS user_activity_days(user_id INTEGER NOT NULL,day TEXT NOT NULL,active_minutes INTEGER NOT NULL DEFAULT 0,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(user_id,day))`,
 `CREATE INDEX IF NOT EXISTS user_activity_day_index ON user_activity_days(day)`,
 `CREATE TABLE IF NOT EXISTS user_activity_state(user_id INTEGER PRIMARY KEY,last_bucket INTEGER NOT NULL)`,
 `CREATE TABLE IF NOT EXISTS user_activity_meta(id INTEGER PRIMARY KEY CHECK(id=1),started_at TEXT NOT NULL)`,
 `INSERT OR IGNORE INTO user_activity_meta(id,started_at) VALUES (1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
];
function weekStart(day){const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-(date.getUTCDay()+6)%7);return date.toISOString().slice(0,10);}
function addDays(day,n){const date=new Date(day+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+n);return date.toISOString().slice(0,10);}
async function record(tx,userId,now=new Date()){
 const bucket=Math.floor(+now/60000),day=indiaDate(now),timestamp=now.toISOString();
 const result=await tx.execute({sql:`INSERT INTO user_activity_state(user_id,last_bucket) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_bucket=excluded.last_bucket WHERE user_activity_state.last_bucket<excluded.last_bucket`,args:[userId,bucket]});
 if(!Number(result.rowsAffected))return {counted:false};
 await tx.execute({sql:`INSERT INTO user_activity_days(user_id,day,active_minutes,first_seen,last_seen) VALUES (?,?,1,?,?) ON CONFLICT(user_id,day) DO UPDATE SET active_minutes=active_minutes+1,last_seen=excluded.last_seen`,args:[userId,day,timestamp,timestamp]});
 return {counted:true};
}
async function report(db,systemEmail,count=12,now=new Date()){
 if(![4,12,26,52].includes(count))throw Object.assign(new Error('Choose 4, 12, 26 or 52 weeks.'),{status:400});
 const current=weekStart(indiaDate(now)),start=addDays(current,-7*(count-1));
 const [users,days,totals,meta]=await Promise.all([
  db.prepare('SELECT id,name,email,account_status FROM users WHERE email<>? ORDER BY id').all(systemEmail),
  db.prepare('SELECT user_id,day,active_minutes FROM user_activity_days WHERE day>=? AND day<=? ORDER BY day').all(start,indiaDate(now)),
  db.prepare(`SELECT user_id,SUM(active_minutes) AS active_minutes,COUNT(*) AS active_days,COUNT(DISTINCT date(day,'-'||((CAST(strftime('%w',day) AS INTEGER)+6)%7)||' days')) AS active_weeks,MIN(first_seen) AS first_seen,MAX(last_seen) AS last_seen FROM user_activity_days GROUP BY user_id`).all(),
  db.prepare('SELECT started_at FROM user_activity_meta WHERE id=1').get()
 ]);
 const weeks=Array.from({length:count},(_,i)=>({week:addDays(start,i*7),active_users:0,active_minutes:0}));
 const byWeek=new Map(weeks.map(w=>[w.week,w]));
 const byUser=new Map(users.map(u=>[u.id,{...u,active_minutes:0,active_days:0,active_weeks:0,first_seen:null,last_seen:null,...totals.find(t=>t.user_id===u.id),weeks:weeks.map(w=>({week:w.week,active_minutes:0,active_days:0}))}]));
 const seen=new Set();
 for(const d of days){const user=byUser.get(d.user_id),week=weekStart(d.day),target=byWeek.get(week);if(!user||!target)continue;
  const row=user.weeks.find(w=>w.week===week);row.active_minutes+=Number(d.active_minutes);row.active_days++;
  target.active_minutes+=Number(d.active_minutes);const key=d.user_id+':'+week;if(!seen.has(key)){seen.add(key);target.active_users++;}
 }
 return {tracking_since:meta?.started_at||null,timezone:'Asia/Kolkata',current_week:current,weeks,users:[...byUser.values()].sort((a,b)=>Number(b.active_weeks)-Number(a.active_weeks)||Number(b.active_minutes)-Number(a.active_minutes)||a.id-b.id)};
}
module.exports={schema,weekStart,record,report};
