'use strict';
// ProgressBuddy server. Zero npm dependencies: Node >= 22.13. Runs on a laptop/Docker (local SQLite) or on Vercel (Turso database).
const zlib = require('node:zlib'), http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), tls = require('node:tls'), net = require('node:net');
const { openDb } = require('./db.js');

const PORT = +process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const TRUST = process.env.TRUST_PROXY || process.env.VERCEL;   // behind a proxy (Render, Fly, Vercel...): use the forwarded client IP and protocol
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');

let SECRET = process.env.JWT_SECRET;
if (!SECRET && process.env.VERCEL) throw new Error('JWT_SECRET is not set. Add it in Vercel -> Settings -> Environment Variables.');
if (!SECRET) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.secret');
  try { SECRET = fs.readFileSync(f, 'utf8'); }
  catch { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

const db = openDb({ dataDir: DATA_DIR });
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,pw TEXT NOT NULL,
 circumstances TEXT NOT NULL DEFAULT '',xp INTEGER NOT NULL DEFAULT 0,streak INTEGER NOT NULL DEFAULT 0,last_day TEXT,
 share_progress INTEGER NOT NULL DEFAULT 1,share_hours INTEGER NOT NULL DEFAULT 0,share_ach INTEGER NOT NULL DEFAULT 1,
 ext_hash TEXT,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_users_ext ON users(ext_hash);
CREATE TABLE IF NOT EXISTS friendships(id INTEGER PRIMARY KEY,a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL,blocker INTEGER,created_at INTEGER NOT NULL,UNIQUE(a,b));
CREATE TABLE IF NOT EXISTS goals(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',unit TEXT NOT NULL,total INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0,
 deadline TEXT,priority TEXT NOT NULL DEFAULT 'medium',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 goal_id INTEGER,challenge_id INTEGER,amount INTEGER NOT NULL,day TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_logs_user_day ON logs(user_id,day);
CREATE TABLE IF NOT EXISTS challenges(id INTEGER PRIMARY KEY,creator INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 opponent INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,unit TEXT NOT NULL,total INTEGER NOT NULL,
 days INTEGER NOT NULL,reward TEXT NOT NULL,penalty TEXT NOT NULL,status TEXT NOT NULL,winner INTEGER,start_at INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ch_users ON challenges(creator,opponent);
CREATE TABLE IF NOT EXISTS chal_progress(challenge_id INTEGER NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(challenge_id,user_id));
CREATE TABLE IF NOT EXISTS help(id INTEGER PRIMARY KEY,from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL,message TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_help_to ON help(to_id,status);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_id,to_id,id);
CREATE TABLE IF NOT EXISTS lectures(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vid TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',pos REAL NOT NULL DEFAULT 0,dur REAL NOT NULL DEFAULT 0,secs REAL NOT NULL DEFAULT 0,
 done INTEGER NOT NULL DEFAULT 0,goal_id INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER,UNIQUE(user_id,vid));
CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 text TEXT NOT NULL,read INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notifs_user ON notifs(user_id,read);
CREATE TABLE IF NOT EXISTS otp(email TEXT PRIMARY KEY,purpose TEXT NOT NULL,code_hash TEXT NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_sent INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,reporter INTEGER NOT NULL,target INTEGER NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
`;
// Creates the tables on first use (safe to repeat). On serverless this runs once per cold start.
let readyP = null;
const ensureReady = () => readyP || (readyP = db.exec(SCHEMA).catch(e => { readyP = null; throw e; }));

// ---------- helpers ----------
const PENALTIES = ['Buy the winner a coffee', 'Lose 50 XP in this challenge', 'Do one extra agreed study task', 'Winner picks the next activity', 'No penalty, just bragging rights'];
const HELP_KINDS = ['notes', 'resources', 'hint', 'explain', 'encourage', 'smaller_target', 'study_session', 'solution'];
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://www.youtube.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://i.ytimg.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
};
class HttpError extends Error { constructor(c, m) { super(m); this.code = c; } }
const bad = (m, c = 400) => { throw new HttpError(c, m); };
const S = (v, min, max, name) => { if (typeof v !== 'string') bad(`${name} is required`); v = v.trim(); if (v.length < min || v.length > max) bad(`${name} must be ${min}-${max} characters`); return v; };
const N = (v, min, max, name) => { v = Number(v); if (!Number.isFinite(v) || v < min || v > max) bad(`${name} must be between ${min} and ${max}`); return Math.floor(v); };
const day = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const pctOf = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;
const b64 = b => Buffer.from(b).toString('base64url');
const hmac = body => crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
const sign = p => { const body = b64(JSON.stringify(p)); return body + '.' + hmac(body); };
const verify = t => {
  if (typeof t !== 'string') return null; const [body, sig] = t.split('.'); if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(hmac(body)); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url')); return p.exp > Date.now() ? p : null; } catch { return null; }
};
const hashPw = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const checkPw = (pw, h) => { const [s, k] = h.split(':'); const d = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64); return crypto.timingSafeEqual(d, Buffer.from(k, 'hex')); };
const DUMMY = hashPw('dummy-password');

// ---------- optional email one-time-code (OTP) verification ----------
// Switched on only when RESEND_API_KEY and MAIL_FROM are set. Otherwise sign-in/sign-up behave exactly as before.
const USE_RESEND = () => !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
const USE_GMAIL = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const OTP_ON = () => USE_RESEND() || USE_GMAIL();
const OTP_TTL = 10 * 60 * 1000, OTP_COOLDOWN = 30 * 1000, OTP_MAX_TRIES = 5;
const otpHash = (email, code) => crypto.createHmac('sha256', SECRET).update('otp:' + email + ':' + code).digest('hex');
// Minimal SMTP client (implicit TLS) so Gmail works without any npm package.
function smtpSend({ host, port, secure, user, pass, fromName, to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    if (/[\r\n<>"]/.test(to) || /[\r\n<>"]/.test(user)) return reject(new Error('bad address'));
    let buf = '', step = 0, done = false;
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const finish = err => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} err ? reject(err) : resolve(); };
    const timer = setTimeout(() => finish(new Error('smtp timeout')), 15000);
    const b64w = t => Buffer.from(t, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim();
    const bound = 'pb_' + crypto.randomBytes(12).toString('hex');
    const msg = [`From: "${fromName}" <${user}>`, `To: <${to}>`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@progressbuddy>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${bound}"`, '',
      `--${bound}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64w(text),
      `--${bound}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64w(html), `--${bound}--`, ''].join('\r\n');
    const send = l => sock.write(l + '\r\n');
    const cmds = [null, () => send('EHLO progressbuddy'), () => send('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`).toString('base64')), () => send(`MAIL FROM:<${user}>`), () => send(`RCPT TO:<${to}>`), () => send('DATA'), () => sock.write(msg.replace(/^\./gm, '..') + '\r\n.\r\n'), () => { send('QUIT'); finish(); }];
    const expect = [220, 250, 235, 250, 250, 354, 250];
    sock.setEncoding('utf8');
    sock.on('data', d => {
      buf += d;
      let i; while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^\d{3}-/.test(line)) continue; // continuation line
        const code = +line.slice(0, 3);
        if (code !== expect[step]) return finish(new Error('smtp ' + line.slice(0, 80)));
        step++; cmds[step]();
      }
    });
    sock.on('error', finish); sock.on('close', () => finish(step < 7 ? new Error('smtp closed early') : undefined));
  });
}
async function sendOtpMail(email, code) {
  if (!USE_RESEND()) {
    const text = `Your ProgressBuddy verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email.`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#0B0C0F"><h2 style="margin:0 0 12px">ProgressBuddy</h2><p>Your verification code is</p><p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:12px 0;color:#2563EB">${code}</p><p style="color:#6B7280;font-size:13px">It expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`;
    return smtpSend({ host: process.env.SMTP_HOST || 'smtp.gmail.com', port: +process.env.SMTP_PORT || 465, secure: process.env.SMTP_SECURE !== '0', user: process.env.GMAIL_USER.trim(), pass: process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, ''), fromName: (process.env.GMAIL_FROM_NAME || 'ProgressBuddy').replace(/[\r\n"<>]/g, ''), to: email, subject: `${code} is your ProgressBuddy code`, text, html });
  }
  const base = process.env.MAIL_API_BASE || 'https://api.resend.com';
  const text = `Your ProgressBuddy verification code is ${code}. It expires in 10 minutes. If you did not request it, you can ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#0B0C0F"><h2 style="margin:0 0 12px">ProgressBuddy</h2><p>Your verification code is</p><p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:12px 0;color:#2563EB">${code}</p><p style="color:#6B7280;font-size:13px">It expires in 10 minutes. If you did not request it, you can ignore this email.</p></div>`;
  const r = await fetch(base + '/emails', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RESEND_API_KEY }, body: JSON.stringify({ from: process.env.MAIL_FROM, to: [email], subject: `${code} is your ProgressBuddy code`, text, html }), signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('mail failed ' + r.status);
}
async function issueOtp(email, purpose, data) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'), now = Date.now();
  (await db.prepare('DELETE FROM otp WHERE expires_at<?').run(now));
  (await db.prepare('INSERT OR REPLACE INTO otp(email,purpose,code_hash,data,expires_at,attempts,last_sent) VALUES(?,?,?,?,?,0,?)').run(email, purpose, otpHash(email, code), JSON.stringify(data), now + OTP_TTL, now));
  try { await sendOtpMail(email, code); }
  catch (e) { console.error('OTP email failed:', e.message); (await db.prepare('DELETE FROM otp WHERE email=?').run(email)); bad('We could not send the code email. Please try again in a moment.', 502); }
}
const sessionFor = u => ({ token: sign({ uid: u.id, exp: Date.now() + 30 * 864e5 }), user: pub(u) });
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const notify = async (uid, text) => (await db.prepare('INSERT INTO notifs(user_id,text,created_at) VALUES(?,?,?)').run(uid, text, Date.now()));
const addXp = async (uid, n) => (await db.prepare('UPDATE users SET xp=xp+? WHERE id=?').run(n, uid));
const userById = async id => (await db.prepare('SELECT * FROM users WHERE id=?').get(id));
const pub = u => ({ id: u.id, name: u.name, email: u.email, circumstances: u.circumstances, xp: u.xp, level: Math.floor(u.xp / 100) + 1, streak: u.streak,
  share_progress: !!u.share_progress, share_hours: !!u.share_hours, share_ach: !!u.share_ach });
const rel = async (x, y) => (await db.prepare('SELECT * FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').get(x, y, y, x));
const isFriend = async (x, y) => (await rel(x, y))?.status === 'accepted';
const needFriend = async (x, y) => { if (!Number.isInteger(y) || !(await isFriend(x, y))) bad('You can only do this with an accepted friend', 403); };
const friendIds = async u => (await db.prepare("SELECT CASE WHEN a=? THEN b ELSE a END AS id FROM friendships WHERE status='accepted' AND (a=? OR b=?)").all(u, u, u)).map(r => r.id);
const own = async (table, id, uid) => { const r = (await db.prepare(`SELECT * FROM ${{ goals: 'goals', lectures: 'lectures' }[table]} WHERE id=? AND user_id=?`).get(+id, uid)); if (!r) bad('Not found', 404); return r; };
async function bumpStreak(uid) {
  const u = (await userById(uid)), t = day(); if (u.last_day === t) return u.streak;
  const s = u.last_day === daysAgo(1) ? u.streak + 1 : 1;
  (await db.prepare('UPDATE users SET streak=?,last_day=? WHERE id=?').run(s, t, uid));
  if (s > 1 && s % 7 === 0) { (await notify(uid, `🔥 You have maintained a ${s}-day streak!`)); (await addXp(uid, 50)); }
  return s;
}
async function stats(uid) {
  const c = async (sql, ...a) => (await db.prepare(sql).get(...a)).c;
  return { helps: await c("SELECT COUNT(*) c FROM help WHERE from_id=? AND status='accepted'", uid), wins: await c('SELECT COUNT(*) c FROM challenges WHERE winner=?', uid),
    lectures_done: await c('SELECT COUNT(*) c FROM lectures WHERE user_id=? AND done=1', uid), goals_done: await c('SELECT COUNT(*) c FROM goals WHERE user_id=? AND done>=total', uid) };
}
async function settle(c) {
  if (c.status !== 'active' || Date.now() < c.start_at + c.days * 864e5) return c;
  const p = async id => (await db.prepare('SELECT done FROM chal_progress WHERE challenge_id=? AND user_id=?').get(c.id, id))?.done ?? 0;
  const a = await p(c.creator), b = await p(c.opponent); const w = a === b ? null : a > b ? c.creator : c.opponent;
  (await db.prepare("UPDATE challenges SET status='ended',winner=? WHERE id=?").run(w, c.id));
  for (const u of [c.creator, c.opponent]) (await notify(u, `🏁 "${c.title}" has ended. ${w ? 'Both of you made real progress. Time to enjoy the agreed reward.' : 'It finished level. Nicely done, both of you.'}`));
  if (w) (await addXp(w, 150));
  return { ...c, status: 'ended', winner: w };
}
const VID = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/;
async function applyProgress(uid, vid, r, trusted = false) {
  const l = (await db.prepare('SELECT * FROM lectures WHERE user_id=? AND vid=?').get(uid, vid)); if (!l) bad('Lecture not found', 404);
  const now = Date.now(), maxD = (now - (l.updated_at || l.created_at)) / 1000 + 5;   // cannot gain more watch time than real time elapsed
  const dur = Math.max(0, Math.min(Number(r.dur) || l.dur, 86400)), pos = Math.max(0, Math.min(Number(r.pos) || 0, dur || 86400));
  const secs = Math.max(l.secs, trusted ? Math.min(Number(r.secs) || 0, dur || 86400) : Math.min(Number(r.secs) || 0, l.secs + maxD));
  const title = typeof r.title === 'string' && r.title ? r.title.slice(0, 200) : l.title;
  let done = l.done;
  if (!done && dur > 0 && pos / dur >= 0.9) {
    done = 1; (await addXp(uid, 50)); (await bumpStreak(uid));
    if (l.goal_id) (await db.prepare('UPDATE goals SET done=done+1 WHERE id=? AND user_id=? AND done<total').run(l.goal_id, uid));
    (await notify(uid, `🎉 Lecture complete: ${title || 'your lecture'}`));
  }
  (await db.prepare('UPDATE lectures SET pos=?,dur=?,secs=?,title=?,done=?,updated_at=? WHERE id=?').run(pos, dur, secs, title, done, now, l.id));
}

// ---------- router ----------
const routes = [];
const route = (m, p, fn, auth = 'user') => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, auth });

route('GET', '/api/health', () => ({ ok: true }), false);
route('GET', '/api/config', () => ({ penalties: PENALTIES, helpKinds: HELP_KINDS, search: !!process.env.YOUTUBE_API_KEY, otp: OTP_ON() }), false);
route('POST', '/api/auth/register', async ({ body }) => {
  const name = S(body.name, 1, 60, 'Name'), email = S(body.email, 5, 120, 'Email').toLowerCase(), pw = S(body.password, 8, 100, 'Password');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address');
  if ((await db.prepare('SELECT 1 FROM users WHERE email=?').get(email))) bad('That email is already registered', 409);
  if (OTP_ON()) { await issueOtp(email, 'register', { name, pw: hashPw(pw) }); return { otp: true, email }; }
  const r = (await db.prepare('INSERT INTO users(name,email,pw,created_at) VALUES(?,?,?,?)').run(name, email, hashPw(pw), Date.now()));
  const u = (await userById(Number(r.lastInsertRowid))); (await notify(u.id, 'Welcome to ProgressBuddy! Add a goal, then invite a friend.'));
  return { token: sign({ uid: u.id, exp: Date.now() + 30 * 864e5 }), user: pub(u) };
}, false);
route('POST', '/api/auth/login', async ({ body }) => {
  const email = S(body.email, 3, 120, 'Email').toLowerCase(), pw = S(body.password, 1, 100, 'Password');
  const u = (await db.prepare('SELECT * FROM users WHERE email=?').get(email));
  const ok = checkPw(pw, u ? u.pw : DUMMY); if (!u || !ok) bad('Incorrect email or password', 401);
  if (OTP_ON()) { await issueOtp(email, 'login', { uid: u.id }); return { otp: true, email }; }
  return { token: sign({ uid: u.id, exp: Date.now() + 30 * 864e5 }), user: pub(u) };
}, false);
route('POST', '/api/auth/verify', async ({ body }) => {
  const email = S(body.email, 3, 120, 'Email').toLowerCase(), code = S(String(body.code ?? ''), 6, 6, 'Code');
  const row = (await db.prepare('SELECT * FROM otp WHERE email=?').get(email));
  if (!row || row.expires_at < Date.now()) { if (row) (await db.prepare('DELETE FROM otp WHERE email=?').run(email)); bad('That code has expired. Please request a new one.', 400); }
  if (row.purpose === 'reset') bad('Please use the password reset screen for this code.', 400);
  if (row.attempts >= OTP_MAX_TRIES) { (await db.prepare('DELETE FROM otp WHERE email=?').run(email)); bad('Too many wrong attempts. Please request a new code.', 429); }
  const a = Buffer.from(otpHash(email, code)), b = Buffer.from(row.code_hash);
  if (!/^\d{6}$/.test(code) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) { (await db.prepare('UPDATE otp SET attempts=attempts+1 WHERE email=?').run(email)); bad('Incorrect code. Please check and try again.', 401); }
  (await db.prepare('DELETE FROM otp WHERE email=?').run(email));
  const d = JSON.parse(row.data);
  if (row.purpose === 'register') {
    if ((await db.prepare('SELECT 1 FROM users WHERE email=?').get(email))) bad('That email is already registered', 409);
    const r = (await db.prepare('INSERT INTO users(name,email,pw,created_at) VALUES(?,?,?,?)').run(d.name, email, d.pw, Date.now()));
    const u = (await userById(Number(r.lastInsertRowid))); (await notify(u.id, 'Welcome to ProgressBuddy! Add a goal, then invite a friend.'));
    return sessionFor(u);
  }
  const u = (await userById(d.uid)); if (!u) bad('Account not found', 404);
  return sessionFor(u);
}, false);
route('POST', '/api/auth/forgot', async ({ body }) => {
  if (!OTP_ON()) bad('Password reset by email is not set up on this site yet.', 503);
  const email = S(body.email, 3, 120, 'Email').toLowerCase();
  const u = (await db.prepare('SELECT * FROM users WHERE email=?').get(email));
  const row = (await db.prepare('SELECT last_sent FROM otp WHERE email=?').get(email));
  // Same answer whether or not the email has an account, so this cannot be used to find who is registered.
  if (u && !(row && Date.now() - row.last_sent < OTP_COOLDOWN)) await issueOtp(email, 'reset', { uid: u.id });
  return { ok: true, email };
}, false);
route('POST', '/api/auth/reset', async ({ body }) => {
  const email = S(body.email, 3, 120, 'Email').toLowerCase(), code = S(String(body.code ?? ''), 6, 6, 'Code'), pw = S(body.password, 8, 100, 'Password');
  const row = (await db.prepare('SELECT * FROM otp WHERE email=?').get(email));
  if (!row || row.purpose !== 'reset' || row.expires_at < Date.now()) { if (row && row.purpose === 'reset') (await db.prepare('DELETE FROM otp WHERE email=?').run(email)); bad('That code has expired. Please request a new one.', 400); }
  if (row.attempts >= OTP_MAX_TRIES) { (await db.prepare('DELETE FROM otp WHERE email=?').run(email)); bad('Too many wrong attempts. Please request a new code.', 429); }
  const a = Buffer.from(otpHash(email, code)), b = Buffer.from(row.code_hash);
  if (!/^\d{6}$/.test(code) || a.length !== b.length || !crypto.timingSafeEqual(a, b)) { (await db.prepare('UPDATE otp SET attempts=attempts+1 WHERE email=?').run(email)); bad('Incorrect code. Please check and try again.', 401); }
  (await db.prepare('DELETE FROM otp WHERE email=?').run(email));
  const d = JSON.parse(row.data); if (!(await userById(d.uid))) bad('Account not found', 404);
  (await db.prepare('UPDATE users SET pw=? WHERE id=?').run(hashPw(pw), d.uid));
  (await notify(d.uid, 'Your password was changed. If this was not you, reset it again right away.'));
  return { ok: true };
}, false);
route('POST', '/api/auth/resend', async ({ body }) => {
  const email = S(body.email, 3, 120, 'Email').toLowerCase();
  const row = (await db.prepare('SELECT * FROM otp WHERE email=?').get(email));
  if (!row) bad('Please sign in again to get a new code.', 400);
  if (Date.now() - row.last_sent < OTP_COOLDOWN) bad('Please wait a few seconds before requesting another code.', 429);
  await issueOtp(email, row.purpose, JSON.parse(row.data)); return { otp: true, email };
}, false);
route('GET', '/api/me', async ({ user }) => ({ user: pub(user), stats: (await stats(user.id)) }));
route('PATCH', '/api/me', async ({ user, body }) => {
  const f = { name: body.name !== undefined ? S(body.name, 1, 60, 'Name') : user.name, circ: body.circumstances !== undefined ? S(body.circumstances || ' ', 0, 1000, 'Circumstances').trim() : user.circumstances };
  const flag = (k) => body[k] === undefined ? user[k] : (body[k] ? 1 : 0);
  (await db.prepare('UPDATE users SET name=?,circumstances=?,share_progress=?,share_hours=?,share_ach=? WHERE id=?').run(f.name, f.circ, flag('share_progress'), flag('share_hours'), flag('share_ach'), user.id));
  return { user: pub((await userById(user.id))) };
});
route('DELETE', '/api/me', async ({ user, body }) => {
  if (!checkPw(S(body.password, 1, 100, 'Password'), user.pw)) bad('Incorrect password', 401);
  await db.batch([
    ['DELETE FROM chal_progress WHERE user_id=? OR challenge_id IN (SELECT id FROM challenges WHERE creator=? OR opponent=?)', [user.id, user.id, user.id]],
    ['DELETE FROM challenges WHERE creator=? OR opponent=?', [user.id, user.id]],
    ['DELETE FROM friendships WHERE a=? OR b=?', [user.id, user.id]],
    ['DELETE FROM help WHERE from_id=? OR to_id=?', [user.id, user.id]],
    ['DELETE FROM messages WHERE from_id=? OR to_id=?', [user.id, user.id]],
    ['DELETE FROM logs WHERE user_id=?', [user.id]], ['DELETE FROM lectures WHERE user_id=?', [user.id]],
    ['DELETE FROM goals WHERE user_id=?', [user.id]], ['DELETE FROM notifs WHERE user_id=?', [user.id]],
    ['DELETE FROM reports WHERE reporter=? OR target=?', [user.id, user.id]],
    ['DELETE FROM users WHERE id=?', [user.id]]
  ]);
});

// friends
route('GET', '/api/friends', async ({ user }) => {
  const rows = (await db.prepare('SELECT * FROM friendships WHERE a=? OR b=?').all(user.id, user.id));
  const info = async id => { const u = (await userById(id)); return { id: u.id, name: u.name, xp: u.xp, streak: u.streak }; };
  return {
    friends: await Promise.all(rows.filter(r => r.status === 'accepted').map(r => info(r.a === user.id ? r.b : r.a))),
    incoming: await Promise.all(rows.filter(r => r.status === 'pending' && r.b === user.id).map(async r => ({ id: r.id, from: await info(r.a) }))),
    outgoing: await Promise.all(rows.filter(r => r.status === 'pending' && r.a === user.id).map(async r => ({ id: r.id, to: await info(r.b) }))),
    blocked: await Promise.all(rows.filter(r => r.status === 'blocked' && r.blocker === user.id).map(r => info(r.a === user.id ? r.b : r.a)))
  };
});
route('POST', '/api/friends/request', async ({ user, body }) => {
  const email = S(body.email, 5, 120, 'Email').toLowerCase(); const t = (await db.prepare('SELECT * FROM users WHERE email=?').get(email));
  const generic = { ok: true, message: 'If that person has a ProgressBuddy account, they will see your request.' };
  if (!t || t.id === user.id) return generic;
  const r = (await rel(user.id, t.id));
  if (r) {
    if (r.status === 'pending' && r.b === user.id) { (await db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(r.id)); (await notify(t.id, `🤝 ${user.name} accepted your friend request`)); return { ok: true, message: `You and ${t.name} are now friends.` }; }
    return generic;
  }
  (await db.prepare("INSERT INTO friendships(a,b,status,created_at) VALUES(?,?,'pending',?)").run(user.id, t.id, Date.now()));
  (await notify(t.id, `🤝 ${user.name} sent you a friend request`)); return generic;
});
route('POST', '/api/friends/:id/accept', async ({ user, params }) => {
  const r = (await db.prepare("SELECT * FROM friendships WHERE id=? AND b=? AND status='pending'").get(+params.id, user.id)); if (!r) bad('Request not found', 404);
  (await db.prepare("UPDATE friendships SET status='accepted' WHERE id=?").run(r.id)); (await notify(r.a, `🤝 ${user.name} accepted your friend request`));
});
route('POST', '/api/friends/:id/decline', async ({ user, params }) => { (await db.prepare("DELETE FROM friendships WHERE id=? AND b=? AND status='pending'").run(+params.id, user.id)); });
route('DELETE', '/api/friends/user/:uid', async ({ user, params }) => { (await db.prepare("DELETE FROM friendships WHERE status IN ('accepted','pending') AND ((a=? AND b=?) OR (a=? AND b=?))").run(user.id, +params.uid, +params.uid, user.id)); });
route('POST', '/api/friends/user/:uid/block', async ({ user, params }) => {
  const t = +params.uid; if (!(await userById(t)) || t === user.id) bad('Not found', 404);
  (await db.prepare('DELETE FROM friendships WHERE (a=? AND b=?) OR (a=? AND b=?)').run(user.id, t, t, user.id));
  (await db.prepare("INSERT INTO friendships(a,b,status,blocker,created_at) VALUES(?,?,'blocked',?,?)").run(user.id, t, user.id, Date.now()));
});
route('POST', '/api/friends/user/:uid/unblock', async ({ user, params }) => { (await db.prepare("DELETE FROM friendships WHERE status='blocked' AND blocker=? AND ((a=? AND b=?) OR (a=? AND b=?))").run(user.id, user.id, +params.uid, +params.uid, user.id)); });
route('POST', '/api/report', async ({ user, body }) => {
  const t = N(body.user_id, 1, 1e12, 'User'); if (!(await userById(t))) bad('Not found', 404);
  (await db.prepare('INSERT INTO reports(reporter,target,reason,created_at) VALUES(?,?,?,?)').run(user.id, t, S(body.reason, 3, 500, 'Reason'), Date.now()));
  return { ok: true, message: 'Thanks. Your report was recorded.' };
});
route('GET', '/api/friends/user/:uid/compare', async ({ user, params }) => {
  const fid = +params.uid; (await needFriend(user.id, fid)); const f = (await userById(fid));
  const goals = async id => (await db.prepare('SELECT name,unit,total,done FROM goals WHERE user_id=?').all(id));
  const hours = async id => Math.round((await db.prepare('SELECT COALESCE(SUM(secs),0) s FROM lectures WHERE user_id=?').get(id)).s / 36) / 100;
  return { me: { name: user.name, streak: user.streak, xp: user.xp, goals: await goals(user.id), hours: await hours(user.id) },
    friend: { name: f.name, streak: f.share_progress ? f.streak : null, xp: f.share_progress ? f.xp : null, goals: f.share_progress ? await goals(fid) : null, hours: f.share_hours ? await hours(fid) : null } };
});

// goals
route('GET', '/api/goals', async ({ user }) => ({ goals: (await db.prepare('SELECT * FROM goals WHERE user_id=? ORDER BY id DESC').all(user.id)) }));
route('POST', '/api/goals', async ({ user, body }) => {
  const dl = body.deadline ? S(body.deadline, 10, 10, 'Deadline') : null; if (dl && !/^\d{4}-\d{2}-\d{2}$/.test(dl)) bad('Deadline must be a date');
  const pr = ['low', 'medium', 'high'].includes(body.priority) ? body.priority : 'medium';
  const r = (await db.prepare('INSERT INTO goals(user_id,name,description,unit,total,deadline,priority,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(user.id, S(body.name, 1, 100, 'Goal name'), String(body.description || '').slice(0, 500), S(body.unit || 'tasks', 1, 20, 'Unit'), N(body.total, 1, 100000, 'Total target'), dl, pr, Date.now()));
  return { goal: (await db.prepare('SELECT * FROM goals WHERE id=?').get(Number(r.lastInsertRowid))) };
});
route('POST', '/api/goals/:id/log', async ({ user, params, body }) => {
  const g = (await own('goals', params.id, user.id)); if (g.done >= g.total) bad('This goal is already complete');
  const amt = N(body.amount ?? 1, 1, 1000, 'Amount'), done = Math.min(g.total, g.done + amt);
  (await db.prepare('UPDATE goals SET done=? WHERE id=?').run(done, g.id));
  (await db.prepare('INSERT INTO logs(user_id,goal_id,amount,day,created_at) VALUES(?,?,?,?,?)').run(user.id, g.id, done - g.done, day(), Date.now()));
  const before = pctOf(g.done, g.total), after = pctOf(done, g.total); let xp = 5, message = null;
  if (done >= g.total) { xp += 100; message = '🏆 Goal complete!'; (await notify(user.id, `🏆 You completed "${g.name}"`)); }
  else if (Math.floor(after / 25) > Math.floor(before / 25)) { xp += 20; message = `🎉 Milestone completed: ${after}%`; }
  (await addXp(user.id, xp)); (await bumpStreak(user.id));
  return { goal: { ...g, done }, xp, message };
});
route('DELETE', '/api/goals/:id', async ({ user, params }) => { (await own('goals', params.id, user.id)); (await db.prepare('DELETE FROM goals WHERE id=?').run(+params.id)); });

// challenges (reward + penalty are chosen up front and must be accepted by both people)
route('POST', '/api/challenges', async ({ user, body }) => {
  const fid = N(body.friend_id, 1, 1e12, 'Friend'); (await needFriend(user.id, fid));
  const penalty = S(body.penalty, 1, 100, 'Penalty'); if (!PENALTIES.includes(penalty)) bad('Choose one of the agreed penalty options');
  const r = (await db.prepare("INSERT INTO challenges(creator,opponent,title,unit,total,days,reward,penalty,status,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?)")
    .run(user.id, fid, S(body.title, 1, 100, 'Title'), S(body.unit || 'tasks', 1, 20, 'Unit'), N(body.total, 1, 100000, 'Target'), N(body.days, 1, 365, 'Days'), S(body.reward, 1, 100, 'Reward'), penalty, Date.now()));
  const id = Number(r.lastInsertRowid);
  for (const u of [user.id, fid]) (await db.prepare('INSERT INTO chal_progress(challenge_id,user_id) VALUES(?,?)').run(id, u));
  (await notify(fid, `🏆 ${user.name} challenged you: "${body.title}". Review the reward and penalty, then accept or decline.`)); return { id };
});
route('GET', '/api/challenges', async ({ user }) => {
  const rawRows = (await db.prepare('SELECT * FROM challenges WHERE creator=? OR opponent=? ORDER BY id DESC').all(user.id, user.id));
  const rows = await Promise.all(rawRows.map(settle));
  const pr = async (c, id) => (await db.prepare('SELECT done FROM chal_progress WHERE challenge_id=? AND user_id=?').get(c, id))?.done ?? 0;
  return { challenges: await Promise.all(rows.map(async c => { const oid = c.creator === user.id ? c.opponent : c.creator; const o = (await userById(oid));
    return { id: c.id, title: c.title, unit: c.unit, total: c.total, days: c.days, reward: c.reward, penalty: c.penalty, status: c.status, start_at: c.start_at,
      end_at: c.start_at ? c.start_at + c.days * 864e5 : null, iCreated: c.creator === user.id, needsMyAccept: c.status === 'pending' && c.opponent === user.id,
      other: { id: o.id, name: o.name }, mine: await pr(c.id, user.id), theirs: await pr(c.id, oid), iWon: c.winner === user.id, theyWon: !!c.winner && c.winner !== user.id }; })) };
});
const chal = async (id, uid) => { const c = (await db.prepare('SELECT * FROM challenges WHERE id=? AND (creator=? OR opponent=?)').get(+id, uid, uid)); if (!c) bad('Challenge not found', 404); return c; };
route('POST', '/api/challenges/:id/accept', async ({ user, params }) => {
  const c = (await chal(params.id, user.id)); if (c.status !== 'pending' || c.opponent !== user.id) bad('Nothing to accept');
  (await db.prepare("UPDATE challenges SET status='active',start_at=? WHERE id=?").run(Date.now(), c.id));
  (await notify(c.creator, `🏆 ${user.name} accepted "${c.title}". The challenge has started!`));
});
route('POST', '/api/challenges/:id/decline', async ({ user, params }) => {
  const c = (await chal(params.id, user.id)); if (c.status !== 'pending' || c.opponent !== user.id) bad('Nothing to decline');
  (await db.prepare("UPDATE challenges SET status='declined' WHERE id=?").run(c.id)); (await notify(c.creator, `${user.name} passed on "${c.title}" this time.`));
});
route('POST', '/api/challenges/:id/leave', async ({ user, params }) => {
  const c = (await chal(params.id, user.id)); if (!['pending', 'active'].includes(c.status)) bad('This challenge is already over');
  (await db.prepare("UPDATE challenges SET status='left' WHERE id=?").run(c.id)); (await notify(c.creator === user.id ? c.opponent : c.creator, `${user.name} left "${c.title}". No penalty applies.`));
});
route('POST', '/api/challenges/:id/log', async ({ user, params, body }) => {
  const c = (await settle((await chal(params.id, user.id)))); if (c.status !== 'active') bad('This challenge is not active');
  const cur = (await db.prepare('SELECT done FROM chal_progress WHERE challenge_id=? AND user_id=?').get(c.id, user.id)).done;
  const done = Math.min(c.total, cur + N(body.amount ?? 1, 1, 1000, 'Amount'));
  (await db.prepare('UPDATE chal_progress SET done=? WHERE challenge_id=? AND user_id=?').run(done, c.id, user.id));
  (await db.prepare('INSERT INTO logs(user_id,challenge_id,amount,day,created_at) VALUES(?,?,?,?,?)').run(user.id, c.id, done - cur, day(), Date.now()));
  (await addXp(user.id, 5)); (await bumpStreak(user.id)); let message = null;
  if (done >= c.total) {
    (await db.prepare("UPDATE challenges SET status='ended',winner=? WHERE id=?").run(user.id, c.id)); (await addXp(user.id, 150)); message = '🏆 You completed the challenge!';
    (await notify(c.creator === user.id ? c.opponent : c.creator, `🏁 ${user.name} finished "${c.title}". Great effort from both of you.`));
  }
  return { done, message };
});

// help your friend
route('GET', '/api/help', async ({ user }) => {
  const q = async (w) => (await db.prepare(`SELECT h.id,h.kind,h.message,h.status,h.created_at,u.id uid,u.name uname FROM help h JOIN users u ON u.id=h.${w === 'to_id' ? 'from_id' : 'to_id'} WHERE h.${w}=? ORDER BY h.id DESC LIMIT 30`).all(user.id));
  return { incoming: await q('to_id'), outgoing: await q('from_id') };
});
route('POST', '/api/help', async ({ user, body }) => {
  const to = N(body.to_id, 1, 1e12, 'Friend'); (await needFriend(user.id, to));
  if (!HELP_KINDS.includes(body.kind)) bad('Choose a type of help');
  (await db.prepare('INSERT INTO help(from_id,to_id,kind,message,created_at) VALUES(?,?,?,?,?)').run(user.id, to, body.kind, String(body.message || '').slice(0, 500), Date.now()));
  (await notify(to, `🤝 ${user.name} offered to help you. You can accept or decline.`));
});
route('POST', '/api/help/:id/accept', async ({ user, params }) => {
  const h = (await db.prepare("SELECT * FROM help WHERE id=? AND to_id=? AND status='pending'").get(+params.id, user.id)); if (!h) bad('Not found', 404);
  (await db.prepare("UPDATE help SET status='accepted' WHERE id=?").run(h.id)); (await addXp(h.from_id, 25));
  (await notify(h.from_id, `🤝 ${user.name} accepted your help. +25 XP`));
});
route('POST', '/api/help/:id/decline', async ({ user, params }) => { (await db.prepare("UPDATE help SET status='declined' WHERE id=? AND to_id=? AND status='pending'").run(+params.id, user.id)); });

// chat
route('GET', '/api/messages/unread', async ({ user }) => ({ unread: (await db.prepare('SELECT from_id,COUNT(*) c FROM messages WHERE to_id=? AND read=0 GROUP BY from_id').all(user.id)) }));
route('GET', '/api/messages/:uid', async ({ user, params, q }) => {
  const f = +params.uid; (await needFriend(user.id, f)); const after = +q.get('after') || 0;
  const rows = (await db.prepare('SELECT id,from_id,body,created_at FROM messages WHERE id>? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id DESC LIMIT 100').all(after, user.id, f, f, user.id)).reverse();
  (await db.prepare('UPDATE messages SET read=1 WHERE to_id=? AND from_id=?').run(user.id, f)); return { messages: rows };
});
route('POST', '/api/messages/:uid', async ({ user, params, body }) => {
  const f = +params.uid; (await needFriend(user.id, f));
  const r = (await db.prepare('INSERT INTO messages(from_id,to_id,body,created_at) VALUES(?,?,?,?)').run(user.id, f, S(body.body, 1, 1000, 'Message'), Date.now())); return { id: Number(r.lastInsertRowid) };
});

// lectures + extension
route('GET', '/api/lectures', async ({ user }) => ({ lectures: (await db.prepare('SELECT id,vid,title,pos,dur,secs,done,goal_id FROM lectures WHERE user_id=? ORDER BY id DESC').all(user.id)) }));
route('POST', '/api/lectures', async ({ user, body }) => {
  const t = S(body.url, 5, 300, 'Link'), m = t.match(VID) || (/^[\w-]{11}$/.test(t) ? [0, t] : null); if (!m) bad('Paste a valid YouTube link');
  let gid = null; if (body.goal_id) gid = (await own('goals', body.goal_id, user.id)).id;
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '', dur = Math.max(0, Math.min(Number(body.dur) || 0, 86400));
  (await db.prepare('INSERT OR IGNORE INTO lectures(user_id,vid,title,dur,goal_id,created_at) VALUES(?,?,?,?,?,?)').run(user.id, m[1], title, dur, gid, Date.now()));
  if (gid) (await db.prepare('UPDATE lectures SET goal_id=? WHERE user_id=? AND vid=?').run(gid, user.id, m[1]));
  return { vid: m[1] };
});
route('POST', '/api/lectures/:id/progress', async ({ user, params, body }) => { const l = (await own('lectures', params.id, user.id)); (await applyProgress(user.id, l.vid, body)); });
route('POST', '/api/lectures/:id/manual', async ({ user, params, body }) => {
  const l = (await own('lectures', params.id, user.id)); const pos = N(body.pos, 0, 86400, 'Position'), dur = body.dur ? N(body.dur, 1, 86400, 'Length') : l.dur;
  if (dur && pos > dur) bad('Watched time cannot be longer than the lecture'); (await applyProgress(user.id, l.vid, { pos, dur, secs: pos }, true));
});
route('DELETE', '/api/lectures/:id', async ({ user, params }) => { (await own('lectures', params.id, user.id)); (await db.prepare('DELETE FROM lectures WHERE id=?').run(+params.id)); });
route('POST', '/api/ext/token', async ({ user }) => { const token = 'pbx_' + crypto.randomBytes(24).toString('hex'); (await db.prepare('UPDATE users SET ext_hash=? WHERE id=?').run(sha(token), user.id)); return { token }; });
route('GET', '/api/ext/tracked', async ({ user }) => {
  const t = {}; for (const l of (await db.prepare('SELECT vid,pos,dur,secs FROM lectures WHERE user_id=?').all(user.id))) t[l.vid] = { pos: l.pos, dur: l.dur, secs: l.secs };
  return { tracked: t, name: user.name };
}, 'ext');
route('POST', '/api/ext/progress', async ({ user, body }) => { if (!/^[\w-]{11}$/.test(String(body.vid))) bad('Invalid video'); (await applyProgress(user.id, body.vid, body)); }, 'ext');

// lecture search (YouTube Data API, called only from the server so the key stays secret)
const YT_BASE = () => process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const searchCache = new Map();
const isoSecs = d => { const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || ''); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; };
const unent = t => String(t || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function ytApi(pathAndQuery) {
  let r; try { r = await fetch(YT_BASE() + pathAndQuery, { signal: AbortSignal.timeout(8000) }); } catch { bad('Search is unavailable right now. You can still paste a link.', 502); }
  if (!r.ok) bad(r.status === 403 ? 'Search is temporarily unavailable (daily limit reached). You can still paste a link.' : 'Search is unavailable right now. You can still paste a link.', r.status === 403 ? 503 : 502);
  return r.json();
}
route('GET', '/api/search', async ({ q, req }) => {
  if (!process.env.YOUTUBE_API_KEY) return { enabled: false, items: [] };
  limit(req, 'search:', 20);
  const text = S(q.get('q') || '', 2, 100, 'Search'), ck = text.toLowerCase(), hit = searchCache.get(ck);
  if (hit && Date.now() - hit.t < 600000) return { enabled: true, items: hit.items };      // cached 10 min to protect the daily quota
  const key = encodeURIComponent(process.env.YOUTUBE_API_KEY);
  const sr = await ytApi(`/search?part=snippet&type=video&videoEmbeddable=true&safeSearch=moderate&maxResults=10&q=${encodeURIComponent(text)}&key=${key}`);
  const found = (sr.items || []).filter(i => i.id && /^[\w-]{11}$/.test(i.id.videoId || '')), durs = {};
  if (found.length) for (const v of (await ytApi(`/videos?part=contentDetails&id=${found.map(i => i.id.videoId).join(',')}&key=${key}`)).items || []) durs[v.id] = isoSecs(v.contentDetails && v.contentDetails.duration);
  const items = found.map(i => { const th = i.snippet.thumbnails && (i.snippet.thumbnails.medium || i.snippet.thumbnails.default); const url = th && th.url || '';
    return { vid: i.id.videoId, title: unent(i.snippet.title).slice(0, 200), channel: unent(i.snippet.channelTitle).slice(0, 100), thumb: url.startsWith('https://i.ytimg.com/') ? url : '', dur: durs[i.id.videoId] || 0 }; });
  if (searchCache.size > 200) searchCache.clear(); searchCache.set(ck, { t: Date.now(), items });
  return { enabled: true, items };
});

// notifications, rewards, insights
route('GET', '/api/notifications', async ({ user }) => ({ items: (await db.prepare('SELECT id,text,read,created_at FROM notifs WHERE user_id=? ORDER BY id DESC LIMIT 30').all(user.id)),
  unread: (await db.prepare('SELECT COUNT(*) c FROM notifs WHERE user_id=? AND read=0').get(user.id)).c }));
route('POST', '/api/notifications/read', async ({ user }) => { (await db.prepare('UPDATE notifs SET read=1 WHERE user_id=?').run(user.id)); });
route('GET', '/api/leaderboard', async ({ user }) => {
  const ids = [user.id, ...(await friendIds(user.id))];
  const board = (await Promise.all(ids.map(async id => { const u = (await userById(id)); if (id !== user.id && !u.share_ach) return null; const s = (await stats(id));
    return { id, name: u.name, you: id === user.id, xp: u.xp, streak: u.streak, helps: s.helps, wins: s.wins }; }))).filter(Boolean).sort((a, b) => b.xp - a.xp);
  return { board };
});
route('GET', '/api/insights', async ({ user }) => {
  const out = [], today = day(), goals = (await db.prepare('SELECT * FROM goals WHERE user_id=?').all(user.id));
  for (const g of goals) {
    if (g.done >= g.total) continue; const rem = g.total - g.done;
    if (g.deadline) { const left = Math.round((Date.parse(g.deadline) - Date.parse(today)) / 864e5);
      out.push({ text: left < 0 ? `"${g.name}" passed its deadline with ${rem} ${g.unit} left. You can still recover: pick a new date and split the rest into small daily targets.`
        : `"${g.name}": ${rem} ${g.unit} to go in ${left} day${left === 1 ? '' : 's'}. About ${Math.ceil(rem / Math.max(1, left))} per day keeps you on track.` }); }
  }
  const wk = (await db.prepare('SELECT COALESCE(SUM(amount),0) s,COUNT(DISTINCT day) d FROM logs WHERE user_id=? AND day>=?').get(user.id, daysAgo(6)));
  out.push({ text: wk.d ? `You were active on ${wk.d} of the last 7 days and logged ${wk.s} items. Small progress is still progress.` : 'No activity logged in the last 7 days. One small task today restarts your streak.' });
  const best = goals.filter(g => g.done > 0).sort((a, b) => b.done / b.total - a.done / a.total)[0];
  if (best) out.push({ text: `Your strongest goal right now is "${best.name}" at ${pctOf(best.done, best.total)}%.` });
  const secs = (await db.prepare('SELECT COALESCE(SUM(secs),0) s FROM lectures WHERE user_id=?').get(user.id)).s;
  if (secs > 60) out.push({ text: `You have watched ${Math.round(secs / 60)} minutes of tracked lectures.` });
  return { insights: out.slice(0, 6) };
});


// ---------- extension download (built per site, so users never type an address) ----------
const EXT_DIR = path.join(__dirname, 'extension');
function originOf(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = String(req.headers.host || ''); if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) bad('Bad host');
  const proto = String((TRUST && req.headers['x-forwarded-proto']) || 'http').split(',')[0].trim();
  return (proto === 'https' ? 'https' : 'http') + '://' + host;
}
function zipStore(files) {
  const parts = [], cd = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), len = f.data.length, crc = zlib.crc32(f.data) >>> 0, lh = Buffer.alloc(30), ch = Buffer.alloc(46);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(len, 18); lh.writeUInt32LE(len, 22); lh.writeUInt16LE(name.length, 26);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(len, 20); ch.writeUInt32LE(len, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, name, f.data); cd.push(ch, name); off += 30 + name.length + len;
  }
  const cdb = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdb.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, end]);
}
function sendExtension(req, res) {
  const origin = originOf(req), u = new URL(origin), pattern = `${u.protocol}//${u.hostname}/*`;   // Chrome match patterns ignore the port
  const files = fs.readdirSync(EXT_DIR).filter(f => fs.statSync(path.join(EXT_DIR, f)).isFile()).map(f => {
    let data = fs.readFileSync(path.join(EXT_DIR, f));
    if (f === 'manifest.json') { const m = JSON.parse(data); if (!m.host_permissions.includes(pattern)) { m.host_permissions.push(pattern); m.content_scripts.push({ matches: [pattern], js: ['bridge.js'], run_at: 'document_start' }); } data = Buffer.from(JSON.stringify(m, null, 2)); }
    return { name: f, data };   // files at the top level, so any extracted folder works with Load unpacked
  });
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="progressbuddy-extension.zip"', 'Cache-Control': 'no-store', ...SEC });
  res.end(zipStore(files));
}

// ---------- server ----------
const hits = new Map();
function limit(req, key, max) {
  const ip = (TRUST ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'x';
  const k = key + ip, now = Date.now(); let h = hits.get(k); if (!h || now - h.t > 60000) { h = { t: now, c: 0 }; hits.set(k, h); }
  if (++h.c > max) bad('Too many requests. Please slow down.', 429);
}
setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (n - v.t > 60000) hits.delete(k); }, 60000).unref();
const readBody = req => new Promise((ok, no) => {
  let b = '', size = 0; req.on('data', c => { size += c.length; if (size > 100000) { no(new HttpError(413, 'Request too large')); req.destroy(); } else b += c; });
  req.on('end', () => { if (!b) return ok({}); try { const j = JSON.parse(b); ok(j && typeof j === 'object' ? j : {}); } catch { no(new HttpError(400, 'Invalid JSON')); } });
  req.on('error', no);
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC }); res.end(JSON.stringify(obj)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname); if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(PUB, rel));
  if (!f.startsWith(PUB + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { if (path.extname(rel)) return json(res, 404, { error: 'Not found' }); return serveStatic('/', res); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC }); fs.createReadStream(f).pipe(res);
}
const handler = async (req, res) => {
  try {
    await ensureReady();
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/extension.zip') return sendExtension(req, res);
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    limit(req, 'all:', 600); if (url.pathname.startsWith('/api/auth/')) limit(req, 'auth:', 20);
    const r = routes.find(x => x.m === req.method && x.re.test(url.pathname));
    if (!r) { if (routes.some(x => x.re.test(url.pathname))) bad('Method not allowed', 405); bad('Not found', 404); }
    const params = { ...url.pathname.match(r.re).groups };
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    let user = null; const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (r.auth === 'user') { const p = verify(tok); user = p && (await userById(p.uid)); if (!user) bad('Please sign in', 401); }
    if (r.auth === 'ext') { user = tok.startsWith('pbx_') ? (await db.prepare('SELECT * FROM users WHERE ext_hash=?').get(sha(tok))) : null; if (!user) bad('Invalid device token', 401); }
    json(res, 200, (await r.fn({ user, params, body, q: url.searchParams, req })) ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return json(res, e.code, { error: e.message });
    if (e instanceof URIError) return json(res, 400, { error: 'Bad request' });
    console.error(e); json(res, 500, { error: 'Server error' });
  }
};
const server = http.createServer(handler);
server.handler = handler;   // used by api/index.js on Vercel
if (require.main === module) server.listen(PORT, () => console.log(`ProgressBuddy running on http://localhost:${PORT}`));
module.exports = server;
