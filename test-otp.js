'use strict';
// Email one-time-code tests (uses a fake mail service; nothing is really sent).
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-otp-')); process.env.TRUST_PROXY = '1'; let ipn = 0;
const server = require('./server.js');
(async () => {
  const sent = [];
  const mail = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { sent.push({ auth: req.headers.authorization, ...JSON.parse(b) }); res.setHeader('Content-Type', 'application/json'); res.end('{"id":"x"}'); }); });
  await new Promise(r => mail.listen(0, r));
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (u, b) => { const r = await fetch(base + '/api' + u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.' + (++ipn) }, body: JSON.stringify(b) }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
  const codeOf = m => /\b(\d{6})\b/.exec(m.text)[1];

  // OFF by default: plain password sign-up still returns a token
  delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM;
  let r = await call('/auth/register', { name: 'Plain', email: 'plain@x.com', password: 'password123' });
  assert.equal(r.s, 200); assert.ok(r.d.token); assert.equal(sent.length, 0);

  assert.equal((await call('/auth/forgot', { email: 'plain@x.com' })).s, 503);

  // ON
  process.env.RESEND_API_KEY = 'k_test'; process.env.MAIL_FROM = 'PB <no-reply@example.com>'; process.env.MAIL_API_BASE = `http://127.0.0.1:${mail.address().port}`;
  r = await call('/auth/register', { name: 'Ria', email: 'ria@x.com', password: 'password123' });
  assert.equal(r.s, 200); assert.equal(r.d.otp, true); assert.equal(r.d.token, undefined);
  assert.equal(sent.length, 1); assert.equal(sent[0].auth, 'Bearer k_test'); assert.deepEqual(sent[0].to, ['ria@x.com']);
  // account must not exist before verifying
  assert.equal((await call('/auth/login', { email: 'ria@x.com', password: 'password123' })).s, 401);
  // wrong code
  const good = codeOf(sent[0]); const wrong = good === '123456' ? '654321' : '123456';
  r = await call('/auth/verify', { email: 'ria@x.com', code: wrong }); assert.equal(r.s, 401);
  r = await call('/auth/verify', { email: 'ria@x.com', code: 'abcdef' }); assert.equal(r.s, 401);
  // resend cooldown
  r = await call('/auth/resend', { email: 'ria@x.com' }); assert.equal(r.s, 429);
  // correct code creates the account and signs in
  r = await call('/auth/verify', { email: 'ria@x.com', code: good }); assert.equal(r.s, 200); assert.ok(r.d.token); assert.equal(r.d.user.email, 'ria@x.com');
  // code is single-use
  assert.equal((await call('/auth/verify', { email: 'ria@x.com', code: good })).s, 400);
  // duplicate sign-up still rejected
  assert.equal((await call('/auth/register', { name: 'Ria', email: 'ria@x.com', password: 'password123' })).s, 409);

  // login: wrong password sends no email; right password needs a code
  const n = sent.length;
  assert.equal((await call('/auth/login', { email: 'ria@x.com', password: 'nope-nope' })).s, 401); assert.equal(sent.length, n);
  r = await call('/auth/login', { email: 'ria@x.com', password: 'password123' }); assert.equal(r.d.otp, true); assert.equal(r.d.token, undefined); assert.equal(sent.length, n + 1);
  const lc = codeOf(sent[n]);
  // lockout after 5 wrong tries, even with the right code afterwards
  const w2 = lc === '111111' ? '222222' : '111111';
  for (let i = 0; i < 5; i++) assert.equal((await call('/auth/verify', { email: 'ria@x.com', code: w2 })).s, 401);
  assert.equal((await call('/auth/verify', { email: 'ria@x.com', code: lc })).s, 429);
  // fresh login works end to end
  r = await call('/auth/login', { email: 'ria@x.com', password: 'password123' }); const c2 = codeOf(sent[sent.length - 1]);
  r = await call('/auth/verify', { email: 'ria@x.com', code: c2 }); assert.equal(r.s, 200); assert.ok(r.d.token);

  // expired code
  const db = new (require('node:sqlite').DatabaseSync)(path.join(process.env.DATA_DIR, 'progressbuddy.db'));
  await call('/auth/login', { email: 'ria@x.com', password: 'password123' }); const c3 = codeOf(sent[sent.length - 1]);
  db.prepare('UPDATE otp SET expires_at=? WHERE email=?').run(Date.now() - 1000, 'ria@x.com');
  assert.equal((await call('/auth/verify', { email: 'ria@x.com', code: c3 })).s, 400);
  // resend after cooldown issues a new code
  await call('/auth/login', { email: 'ria@x.com', password: 'password123' });
  db.prepare('UPDATE otp SET last_sent=? WHERE email=?').run(Date.now() - 60000, 'ria@x.com');
  const cnt = sent.length; r = await call('/auth/resend', { email: 'ria@x.com' }); assert.equal(r.s, 200); assert.equal(sent.length, cnt + 1);
  // forgot password: unknown email gets the same answer and no mail
  const before = sent.length;
  r = await call('/auth/forgot', { email: 'nobody@x.com' }); assert.equal(r.s, 200); assert.equal(r.d.ok, true); assert.equal(sent.length, before);
  // known email gets a code; reset code cannot be used to sign in
  db.prepare('DELETE FROM otp').run();
  r = await call('/auth/forgot', { email: 'ria@x.com' }); assert.equal(r.s, 200); assert.equal(sent.length, before + 1);
  const rc = codeOf(sent[sent.length - 1]);
  assert.equal((await call('/auth/verify', { email: 'ria@x.com', code: rc })).s, 400);
  // quick repeat does not send another email
  await call('/auth/forgot', { email: 'ria@x.com' }); assert.equal(sent.length, before + 1);
  // short password and wrong code are refused
  assert.equal((await call('/auth/reset', { email: 'ria@x.com', code: rc, password: 'short' })).s, 400);
  assert.equal((await call('/auth/reset', { email: 'ria@x.com', code: rc === '999999' ? '888888' : '999999', password: 'brandnewpass1' })).s, 401);
  r = await call('/auth/reset', { email: 'ria@x.com', code: rc, password: 'brandnewpass1' }); assert.equal(r.s, 200);
  assert.equal((await call('/auth/reset', { email: 'ria@x.com', code: rc, password: 'brandnewpass2' })).s, 400);
  // old password no longer works; new one does (needs its own login code)
  assert.equal((await call('/auth/login', { email: 'ria@x.com', password: 'password123' })).s, 401);
  r = await call('/auth/login', { email: 'ria@x.com', password: 'brandnewpass1' }); assert.equal(r.d.otp, true);

  // mail provider failure -> clean error, no dangling code
  process.env.MAIL_API_BASE = 'http://127.0.0.1:1';
  r = await call('/auth/login', { email: 'ria@x.com', password: 'brandnewpass1' }); assert.equal(r.s, 502);

  // ---- Gmail (SMTP) route, against a fake SMTP server ----
  const net = require('node:net'); const smtpMsgs = []; let smtpGoodPass = 'abcdefghijklmnop';
  const smtp = net.createServer(sock => {
    let data = false, buf = '', cur = {}; sock.write('220 fake ESMTP\r\n');
    sock.on('data', d => { buf += d.toString();
      if (data) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; cur.body = buf.slice(0, i); buf = buf.slice(i + 5); data = false; smtpMsgs.push(cur); sock.write('250 queued\r\n'); }
      let i; while (!data && (i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/.test(l)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/.test(l)) { const [, u, p] = Buffer.from(l.slice(11), 'base64').toString().split('\0'); cur = { u }; if (p === smtpGoodPass) sock.write('235 ok\r\n'); else sock.write('535 bad credentials\r\n'); }
        else if (/^MAIL FROM/.test(l)) { cur.from = l; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO/.test(l)) { cur.to = l; sock.write('250 ok\r\n'); }
        else if (l === 'DATA') { data = true; sock.write('354 go\r\n'); if (buf) sock.emit('data', ''); }
        else if (l === 'QUIT') sock.end('221 bye\r\n'); } });
  });
  await new Promise(r => smtp.listen(0, r));
  delete process.env.RESEND_API_KEY; delete process.env.MAIL_FROM; delete process.env.MAIL_API_BASE;
  process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = String(smtp.address().port); process.env.SMTP_SECURE = '0';
  process.env.GMAIL_USER = 'progressbuddy.app@gmail.com'; process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  const smtpCode = m => { const part = /Content-Type: text\/plain[^]*?\r\n\r\n([^]*?)\r\n--pb_/.exec(m.body)[1]; return /\b(\d{6})\b/.exec(Buffer.from(part, 'base64').toString())[1]; };
  r = await call('/auth/register', { name: 'Gia', email: 'gia@x.com', password: 'password123' });
  assert.equal(r.s, 200); assert.equal(r.d.otp, true); assert.equal(smtpMsgs.length, 1);
  assert.match(smtpMsgs[0].to, /<gia@x\.com>/); assert.match(smtpMsgs[0].from, /<progressbuddy\.app@gmail\.com>/); assert.match(smtpMsgs[0].body, /Subject: \d{6} is your ProgressBuddy code/);
  r = await call('/auth/verify', { email: 'gia@x.com', code: smtpCode(smtpMsgs[0]) }); assert.equal(r.s, 200); assert.ok(r.d.token);
  // wrong app password -> clean 502, no dangling code
  smtpGoodPass = 'something-else';
  r = await call('/auth/login', { email: 'gia@x.com', password: 'password123' }); assert.equal(r.s, 502);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM otp WHERE email=?').get('gia@x.com').c, 0);
  // Resend is preferred when both are configured
  process.env.RESEND_API_KEY = 'k_test'; process.env.MAIL_FROM = 'PB <no-reply@example.com>'; process.env.MAIL_API_BASE = `http://127.0.0.1:${mail.address().port}`;
  const s1 = sent.length, m1 = smtpMsgs.length; await call('/auth/login', { email: 'gia@x.com', password: 'password123' });
  assert.equal(sent.length, s1 + 1); assert.equal(smtpMsgs.length, m1);
  console.log('OTP TESTS PASSED'); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
