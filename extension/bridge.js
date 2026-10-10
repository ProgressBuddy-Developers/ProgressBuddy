// Runs only on your ProgressBuddy site (the address is added to the manifest when you download the extension).
// It lets the page connect the extension with one click, so nothing has to be typed or pasted.
const ORIGIN = location.origin;
const post = (type, extra) => window.postMessage({ source: 'pb-ext', type, ...extra }, ORIGIN);
async function hello() {
  const { token, server } = await chrome.storage.local.get(['token', 'server']);
  post('ready', { paired: !!token && server === ORIGIN });
}
window.addEventListener('message', async e => {
  const d = e.data;
  if (e.source !== window || e.origin !== ORIGIN || !d || d.source !== 'pb-page') return;
  if (d.type === 'hello') return hello();
  if (d.type === 'pair' && typeof d.token === 'string' && d.token.startsWith('pbx_')) {
    await chrome.storage.local.set({ server: ORIGIN, token: d.token, status: 'Connecting...' });
    await chrome.runtime.sendMessage({ type: 'sync' });
    post('ready', { paired: true });
  }
  if (d.type === 'unpair') { await chrome.storage.local.remove(['server', 'token', 'tracked', 'status']); post('ready', { paired: false }); }
});
hello();
