// Syncs the list of added lectures from your ProgressBuddy server and sends progress back.
const get = k => chrome.storage.local.get(k);
const last = {};

async function sync() {
  const { server, token } = await get(['server', 'token']);
  if (!server || !token) return;
  try {
    const r = await fetch(server + '/api/ext/tracked', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) { await chrome.storage.local.set({ status: 'Device token rejected. Create a new one in ProgressBuddy.' }); return; }
    if (!r.ok) return;
    const { tracked: remote, name } = await r.json();
    const { tracked = {} } = await get('tracked');
    const merged = {};
    for (const [v, x] of Object.entries(remote)) { const l = tracked[v]; merged[v] = l && (l.secs || 0) > x.secs ? { ...x, ...l } : x; } // keep unsent local progress
    await chrome.storage.local.set({ tracked: merged, status: 'Connected as ' + name, synced: Date.now() });
  } catch { await chrome.storage.local.set({ status: 'Offline. Will retry.' }); }
}
chrome.alarms.create('sync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'sync') sync(); });
chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m && m.type === 'sync') { sync().then(() => reply({})); return true; }
  if (!m || m.type !== 'progress' || !/^[\w-]{11}$/.test(m.vid)) return;
  get(['tracked', 'server', 'token']).then(async ({ tracked = {}, server, token }) => {
    if (!tracked[m.vid]) return;
    tracked[m.vid] = { ...tracked[m.vid], ...m.rec };
    await chrome.storage.local.set({ tracked });
    if (!server || !token) return;
    const now = Date.now(), L = last[m.vid] || { t: 0, s: -1 };
    if (now - L.t < 10000 && L.s === m.rec.state) return;      // at most one update per 10s unless play/pause changed
    last[m.vid] = { t: now, s: m.rec.state };
    try {
      await fetch(server + '/api/ext/progress', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ vid: m.vid, pos: m.rec.pos, dur: m.rec.dur, secs: m.rec.secs, title: m.rec.title }) });
    } catch { /* retried on the next update */ }
  });
});
