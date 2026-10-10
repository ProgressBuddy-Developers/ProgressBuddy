const $ = id => document.getElementById(id);
async function refresh() {
  const { enabled = true, server = '', status = '', tracked = {} } = await chrome.storage.local.get(['enabled', 'server', 'status', 'tracked']);
  $('on').checked = enabled; const ids = Object.keys(tracked);
  $('st').textContent = server ? `${status || 'Connecting...'} · ${ids.length} lecture${ids.length === 1 ? '' : 's'}` : 'Not connected yet.';
  $('list').textContent = '';
  for (const id of ids) { const r = tracked[id], p = r.dur ? Math.round(r.pos / r.dur * 100) : 0; const li = document.createElement('li'); li.textContent = `${r.title || id} (${p}%)`; $('list').append(li); }
}
$('on').onchange = e => chrome.storage.local.set({ enabled: e.target.checked });
refresh();
