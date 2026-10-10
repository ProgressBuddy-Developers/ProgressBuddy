// Runs on youtube.com. Reads playback of ONLY the videos the user added in ProgressBuddy.
let vid = null, lastT = null, lastState = 0, n = 0, askedAt = 0, acc = null;   // acc = running watch-time total for the current video
const ID = /^[\w-]{11}$/;

async function tick() {
  try {
    const id = location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
    if (id !== vid) { vid = id; lastT = null; acc = null; }
    if (!id || !ID.test(id)) return;
    const { tracked = {}, enabled = true } = await chrome.storage.local.get(['tracked', 'enabled']);
    if (!enabled) return;
    if (!tracked[id]) {                                           // not an added video: ignore (but refresh the list now and then)
      if (Date.now() - askedAt > 30000) { askedAt = Date.now(); chrome.runtime.sendMessage({ type: 'sync' }); }
      return;
    }
    if (document.querySelector('.html5-video-player.ad-showing')) { lastT = null; return; } // skip ads
    const v = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (!v || !v.duration || !isFinite(v.duration)) return;

    const cur = v.currentTime, playing = !v.paused && !v.ended;
    if (acc === null) acc = tracked[id].secs || 0;
    if (playing && lastT !== null && cur > lastT && cur - lastT < 3) acc += cur - lastT; // seeks are not counted
    acc = Math.max(acc, tracked[id].secs || 0); const secs = acc;
    lastT = cur;

    const state = playing ? 1 : (v.ended ? 0 : 2);
    if (state !== lastState || (playing && ++n % 2 === 0)) {
      lastState = state;
      chrome.runtime.sendMessage({
        type: 'progress', vid: id,
        rec: { pos: cur, dur: v.duration, secs, state,
               title: document.title.replace(/ - YouTube$/, ''), updated: Date.now() }
      });
    }
  } catch (e) { /* extension reloaded or page changing */ }
}
setInterval(tick, 1000);
