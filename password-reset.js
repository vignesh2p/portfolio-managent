const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const schema = [
  `CREATE TABLE IF NOT EXISTS password_resets (user_id INTEGER PRIMARY KEY, code_hash TEXT, token_hash TEXT, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, token_version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS password_reset_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)`
];
const genericMessage = 'If this email is eligible, a verification code has been sent. Check your inbox and spam folder.';
const invalidMessage = 'Invalid or expired code. Request a new code if needed.';
function createEmailSender(env = process.env, fetcher = globalThis.fetch) {
  const send = async (email, code) => {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.PASSWORD_RESET_FROM, to: [email], subject: 'Your ONEPIECE password reset code',
        text: `Your verification code is ${code}. It expires in 10 minutes and can only be used once. If you did not request this, you can ignore this email.` })
    });
    if (!response.ok) throw new Error('Email delivery failed');
  };
  send.available = () => Boolean(env.RESEND_API_KEY && env.PASSWORD_RESET_FROM);
  return send;
}
function createPasswordReset({ transaction, secret, systemEmail, sendEmail, now = Date.now }) {
  const digest = value => crypto.createHmac('sha256', secret).update(value).digest('hex');
  const execute = (tx, sql, args = []) => tx.execute({ sql, args });
  const eligible = user => user && !user.deleted_at && ['approved','pending'].includes(user.account_status) && user.email !== systemEmail;
  async function limit(tx, key, max, duration, time) {
    const result = await execute(tx, `INSERT INTO password_reset_limits(key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count`, [digest(key), time + duration, max]);
    return result.rows.length > 0;
  }
  async function request(email, ip) {
    if (sendEmail.available && !sendEmail.available()) return { status:503, error:'Password reset email is not configured. Please contact support.' };
    const time = now();
    const delivery = await transaction(async tx => {
      await execute(tx, 'DELETE FROM password_reset_limits WHERE expires_at<=?', [time]);
      await execute(tx, 'DELETE FROM password_resets WHERE expires_at<=?', [time]);
      if (!await limit(tx, `ip:${ip}`, 30, 3600000, time)) return { limited:true };
      // Apply the same limits to unknown accounts to avoid disclosing registration.
      if (!await limit(tx, `cooldown:${email}`, 1, 60000, time)) return null;
      if (!await limit(tx, `email:${email}`, 5, 3600000, time)) return null;
      const user = (await execute(tx, 'SELECT * FROM users WHERE email=?', [email])).rows[0];
      if (!eligible(user)) return null;
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const hash = digest(`${user.id}:${code}`);
      await execute(tx, `INSERT INTO password_resets(user_id,code_hash,token_hash,expires_at,attempts,token_version) VALUES (?,?,NULL,?,0,?)
        ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,token_hash=NULL,expires_at=excluded.expires_at,attempts=0,token_version=excluded.token_version`, [user.id, hash, time + 600000, user.token_version]);
      return { email:user.email, id:user.id, code, hash };
    });
    if (delivery?.limited) return { status:429, error:'Too many requests. Please try again later.' };
    if (delivery) {
      try { await sendEmail(delivery.email, delivery.code); }
      catch {
        await transaction(tx => execute(tx, 'DELETE FROM password_resets WHERE user_id=? AND code_hash=?', [delivery.id, delivery.hash]));
        // Do not expose account existence through provider errors or log the code.
        console.error('Password reset email delivery failed');
      }
    }
    return { message:genericMessage };
  }
  async function verify(email, code) {
    return transaction(async tx => {
      const row = (await execute(tx, `SELECT r.*,u.email,u.account_status,u.deleted_at,u.token_version AS current_version FROM password_resets r JOIN users u ON u.id=r.user_id WHERE u.email=?`, [email])).rows[0];
      if (!eligible(row) || !row.code_hash || row.expires_at <= now() || row.attempts >= 5 || row.token_version !== row.current_version) return {status:400,error:invalidMessage};
      await execute(tx, 'UPDATE password_resets SET attempts=attempts+1 WHERE user_id=?', [row.user_id]);
      if (!crypto.timingSafeEqual(Buffer.from(row.code_hash,'hex'), Buffer.from(digest(`${row.user_id}:${code}`),'hex'))) return {status:400,error:invalidMessage};
      const token = crypto.randomBytes(32).toString('hex');
      await execute(tx, 'UPDATE password_resets SET code_hash=NULL,token_hash=?,expires_at=? WHERE user_id=?', [digest(token), now()+600000, row.user_id]);
      return { reset_token:token };
    });
  }
  async function reset(token, password) {
    const hashed = await bcrypt.hash(password, 10);
    return transaction(async tx => {
      const row = (await execute(tx, `SELECT r.*,u.email,u.account_status,u.deleted_at,u.token_version AS current_version FROM password_resets r JOIN users u ON u.id=r.user_id WHERE r.token_hash=?`, [digest(token)])).rows[0];
      if (!eligible(row) || row.expires_at<=now() || row.token_version!==row.current_version) return {status:400,error:'Reset session expired or invalid. Request a new code.'};
      await execute(tx, 'UPDATE users SET password=?,token_version=token_version+1 WHERE id=?', [hashed,row.user_id]);
      await execute(tx, 'DELETE FROM password_resets WHERE user_id=?', [row.user_id]);
      return {message:'Password updated. Sign in with your new password.'};
    });
  }
  return {request,verify,reset};
}
function register(app, options) {
  const service = createPasswordReset(options);
  for (const action of ['request','verify','reset']) app.post(`/api/auth/password-reset/${action}`, async (req,res) => {
    res.set('Cache-Control','no-store');
    const body = req.body || {};
    const email = typeof body.email==='string' ? body.email.trim().toLowerCase() : '';
    if (action!=='reset' && (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({success:false,error:'Enter a valid email address.'});
    if (action==='verify' && (typeof body.code!=='string' || !/^\d{6}$/.test(body.code))) return res.status(400).json({success:false,error:'Enter the six-digit code.'});
    if (action==='reset' && (typeof body.reset_token!=='string' || !/^[a-f0-9]{64}$/.test(body.reset_token) || typeof body.password!=='string' || body.password.length<8 || Buffer.byteLength(body.password,'utf8')>72)) return res.status(400).json({success:false,error:'Use a valid reset session and a password with at least 8 characters (at most 72 UTF-8 bytes).'});
    try {
      const result = action==='request' ? await service.request(email,req.ip) : action==='verify' ? await service.verify(email,body.code) : await service.reset(body.reset_token,body.password);
      const {status=200,...data}=result;
      res.status(status).json({success:status===200,...data});
    } catch { res.status(503).json({success:false,error:'Password reset is temporarily unavailable. Please try again.'}); }
  });
}
module.exports={schema,createEmailSender,createPasswordReset,register};
