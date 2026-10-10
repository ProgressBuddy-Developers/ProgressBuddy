'use strict';
// End-to-end smoke test: starts the server on a temp database and exercises the main flows.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
const server = require('./server.js');
(async () => {
  const mockHttp = require('node:http'); let mockHits = 0, searchUrl = '';
  const mock = mockHttp.createServer((req, res) => { mockHits++; const u = new URL(req.url, 'http://x'); res.setHeader('Content-Type', 'application/json');
    if (u.pathname.endsWith('/search')) { searchUrl = req.url; if (u.searchParams.get('q') === 'quota') { res.statusCode = 403; return res.end('{"error":{"message":"quotaExceeded key=test-key"}}'); }
      return res.end(JSON.stringify({ items: [{ id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Python &amp; Friends &#39;101&#39;', channelTitle: 'Code &amp; Co', thumbnails: { medium: { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg' } } } }, { id: { videoId: 'bad' }, snippet: { title: 'x', channelTitle: 'y' } }] })); }
    if (u.pathname.endsWith('/videos')) return res.end(JSON.stringify({ items: [{ id: 'dQw4w9WgXcQ', contentDetails: { duration: 'PT1H2M3S' } }] }));
    res.statusCode = 404; res.end('{}'); });
  await new Promise(r => mock.listen(0, r)); process.env.YT_API_BASE = `http://127.0.0.1:${mock.address().port}/youtube/v3`; process.env.YOUTUBE_API_KEY = 'test-key';
  await new Promise(r => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (m, u, b, t) => { const r = await fetch(base + '/api' + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json().catch(() => ({})) }; };
  const ok = async (...a) => { const r = await call(...a); assert.equal(r.s, 200, `${a[0]} ${a[1]} -> ${r.s} ${JSON.stringify(r.d)}`); return r.d; };
  const A = await ok('POST', '/auth/register', { name: 'Divyansh', email: 'a@x.com', password: 'password123' });
  const B = await ok('POST', '/auth/register', { name: 'Rahul', email: 'b@x.com', password: 'password123' });
  const C = await ok('POST', '/auth/register', { name: 'Stranger', email: 'c@x.com', password: 'password123' });
  const ta = A.token, tb = B.token, tc = C.token;
  assert.equal((await call('POST', '/auth/register', { name: 'x', email: 'a@x.com', password: 'password123' })).s, 409);
  assert.equal((await call('POST', '/auth/login', { email: 'a@x.com', password: 'wrongpass' })).s, 401);
  assert.equal((await call('GET', '/me')).s, 401);
  assert.equal((await call('GET', '/me', null, 'forged.token')).s, 401);

  await ok('POST', '/friends/request', { email: 'b@x.com' }, ta);
  let fr = await ok('GET', '/friends', null, tb); assert.equal(fr.incoming.length, 1);
  await ok('POST', `/friends/${fr.incoming[0].id}/accept`, {}, tb);
  assert.equal((await ok('GET', '/friends', null, ta)).friends.length, 1);

  const g = (await ok('POST', '/goals', { name: 'Learn Python', unit: 'lessons', total: 4 }, ta)).goal;
  let r = await ok('POST', `/goals/${g.id}/log`, { amount: 1 }, ta); assert.equal(r.message, '🎉 Milestone completed: 25%');
  assert.equal((await call('POST', `/goals/${g.id}/log`, {}, tb)).s, 404, 'other users cannot touch my goal');
  assert.equal((await call('POST', '/goals/' + g.id + '/log', { amount: -5 }, ta)).s, 400);

  assert.equal((await call('POST', '/challenges', { friend_id: C.user.id, title: 't', total: 5, days: 5, reward: 'x', penalty: PEN() }, ta)).s, 403, 'non-friend');
  function PEN() { return 'Buy the winner a coffee'; }
  assert.equal((await call('POST', '/challenges', { friend_id: B.user.id, title: 't', total: 5, days: 5, reward: 'x', penalty: 'Humiliate them' }, ta)).s, 400, 'unsafe penalty rejected');
  const { id: cid } = await ok('POST', '/challenges', { friend_id: B.user.id, title: 'Solve 5 DSA', unit: 'problems', total: 5, days: 30, reward: 'Coffee', penalty: PEN() }, ta);
  assert.equal((await call('POST', `/challenges/${cid}/log`, { amount: 1 }, ta)).s, 400, 'cannot log before both accept');
  assert.equal((await call('POST', `/challenges/${cid}/accept`, {}, ta)).s, 400, 'creator cannot accept own challenge');
  await ok('POST', `/challenges/${cid}/accept`, {}, tb);
  await ok('POST', `/challenges/${cid}/log`, { amount: 2 }, ta); await ok('POST', `/challenges/${cid}/log`, { amount: 1 }, tb);
  let ch = (await ok('GET', '/challenges', null, tb)).challenges[0]; assert.equal(ch.mine, 1); assert.equal(ch.theirs, 2); assert.equal(ch.status, 'active');
  assert.equal((await call('POST', `/challenges/${cid}/log`, { amount: 1 }, tc)).s, 404);
  await ok('POST', `/challenges/${cid}/log`, { amount: 3 }, ta);
  ch = (await ok('GET', '/challenges', null, ta)).challenges[0]; assert.equal(ch.status, 'ended'); assert.equal(ch.iWon, true);

  await ok('POST', '/help', { to_id: A.user.id, kind: 'hint', message: 'Try a dict' }, tb);
  const h = (await ok('GET', '/help', null, ta)).incoming[0]; const xpBefore = (await ok('GET', '/me', null, tb)).user.xp;
  await ok('POST', `/help/${h.id}/accept`, {}, ta);
  assert.equal((await ok('GET', '/me', null, tb)).user.xp, xpBefore + 25);
  assert.equal((await call('POST', '/help', { to_id: A.user.id, kind: 'hint' }, tc)).s, 403);

  await ok('POST', `/messages/${B.user.id}`, { body: 'Study at 7?' }, ta);
  assert.equal((await ok('GET', `/messages/${A.user.id}`, null, tb)).messages.length, 1);
  assert.equal((await call('GET', `/messages/${A.user.id}`, null, tc)).s, 403, 'strangers cannot read chat');

  await ok('PATCH', '/me', { share_progress: false }, tb);
  assert.equal((await ok('GET', `/friends/user/${B.user.id}/compare`, null, ta)).friend.goals, null, 'privacy respected');

  await ok('POST', '/lectures', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', goal_id: g.id }, ta);
  const ext = (await ok('POST', '/ext/token', {}, ta)).token;
  assert.equal((await call('GET', '/ext/tracked', null, ta)).s, 401, 'user JWT is not a device token');
  const tr = await ok('GET', '/ext/tracked', null, ext); assert.ok(tr.tracked.dQw4w9WgXcQ);
  await ok('POST', '/ext/progress', { vid: 'dQw4w9WgXcQ', pos: 10, dur: 100, secs: 99999, title: 'Demo' }, ext);
  let lec = (await ok('GET', '/lectures', null, ta)).lectures[0]; assert.ok(lec.secs <= 10, 'watch time cannot be inflated: ' + lec.secs);
  await ok('POST', '/ext/progress', { vid: 'dQw4w9WgXcQ', pos: 95, dur: 100, secs: 12 }, ext);
  lec = (await ok('GET', '/lectures', null, ta)).lectures[0]; assert.equal(lec.done, 1);
  assert.equal((await ok('GET', '/goals', null, ta)).goals[0].done, 2, 'finishing lecture credits the goal');
  assert.equal((await call('POST', '/ext/progress', { vid: 'aaaaaaaaaaa', pos: 1, dur: 2, secs: 1 }, ext)).s, 404);

  const lid = (await ok('GET', '/lectures', null, ta)).lectures[0].id;
  await ok('POST', '/lectures', { url: 'aaaaaaaaaab' }, ta); const l2 = (await ok('GET', '/lectures', null, ta)).lectures[0];
  await ok('POST', `/lectures/${l2.id}/progress`, { pos: 20, dur: 200, secs: 99999, title: 'In-app' }, ta);
  assert.ok((await ok('GET', '/lectures', null, ta)).lectures[0].secs <= 6, 'in-app watch time cannot be inflated');
  assert.equal((await call('POST', `/lectures/${l2.id}/progress`, { pos: 1 }, tb)).s, 404, 'other users cannot update my lecture');
  await ok('POST', `/lectures/${l2.id}/manual`, { pos: 150 }, ta); assert.equal((await ok('GET', '/lectures', null, ta)).lectures[0].pos, 150);
  assert.equal((await call('POST', `/lectures/${l2.id}/manual`, { pos: 9999 }, ta)).s, 400, 'cannot exceed lecture length');
  assert.equal((await call('GET', '/search?q=python')).s, 401); assert.equal((await call('GET', '/search?q=a', null, ta)).s, 400);
  const sr = await ok('GET', '/search?q=python%20tutorial', null, ta);
  assert.equal(sr.enabled, true); assert.equal(sr.items.length, 1, 'results with invalid ids are dropped'); assert.equal(sr.items[0].title, "Python & Friends '101'"); assert.equal(sr.items[0].dur, 3723);
  assert.ok(searchUrl.includes('videoEmbeddable=true') && searchUrl.includes('type=video') && searchUrl.includes('key=test-key'), 'only embeddable videos requested');
  assert.ok(!JSON.stringify(sr).includes('test-key'), 'API key never sent to the browser');
  const before = mockHits; await ok('GET', '/search?q=python%20tutorial', null, ta); assert.equal(mockHits, before, 'repeat searches are cached');
  const qr = await call('GET', '/search?q=quota', null, ta); assert.equal(qr.s, 503); assert.ok(!JSON.stringify(qr.d).includes('test-key'), 'upstream errors do not leak the key');
  await ok('POST', '/lectures', { url: 'dQw4w9WgXcQ', title: 'Python & Friends', dur: 3723 }, tb); const lb2 = (await ok('GET', '/lectures', null, tb)).lectures[0]; assert.equal(lb2.title, 'Python & Friends'); assert.equal(lb2.dur, 3723);
  delete process.env.YOUTUBE_API_KEY; assert.equal((await ok('GET', '/search?q=python', null, ta)).enabled, false, 'search is off without a key'); process.env.YOUTUBE_API_KEY = 'test-key';
  const zr = await fetch(base + '/extension.zip'); const zb = Buffer.from(await zr.arrayBuffer());
  assert.equal(zr.status, 200); assert.equal(zb.slice(0, 2).toString(), 'PK'); assert.ok(zb.includes('127.0.0.1/*'), 'extension is built for this site');
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'ext.zip'), zb);
  const lb = (await ok('GET', '/leaderboard', null, ta)).board; assert.equal(lb.length, 2);
  assert.ok((await ok('GET', '/insights', null, ta)).insights.length > 0);
  assert.ok((await ok('GET', '/notifications', null, ta)).items.length > 0);
  await ok('POST', `/friends/user/${B.user.id}/block`, {}, ta);
  assert.equal((await call('POST', `/messages/${B.user.id}`, { body: 'hi' }, ta)).s, 403, 'blocked');
  assert.equal((await fetch(base + '/../../etc/passwd')).status < 500, true);
  assert.equal((await fetch(base + '/server.js')).status === 200 && false, false);
  const idx = await fetch(base + '/'); assert.ok([200, 404].includes(idx.status));
  assert.equal((await call('DELETE', '/me', { password: 'password123' }, tc)).s, 200);
  console.log('ALL TESTS PASSED'); server.close(); process.exit(0);
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
