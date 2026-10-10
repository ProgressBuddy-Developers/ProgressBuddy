'use strict';
const $ = s => document.querySelector(s), val = id => ($('#' + id) || {}).value || '';
const EYE = '<svg class="eye-on" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg><svg class="eye-off" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.5 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
const pwField = (id, ac) => `<div class="pw"><input id="${id}" type="password" autocomplete="${ac}"><button type="button" class="eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">${EYE}</button></div>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pc = (a, b) => b ? Math.min(100, Math.round(a / b * 100)) : 0;
const fmt = s => { s = Math.floor(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), c = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${c}` : `${m}:${c}`; };
const tm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const HELP = { notes: 'Share notes', resources: 'Share resources', hint: 'Send a hint', explain: 'Explain a topic', encourage: 'Send encouragement', smaller_target: 'Suggest a smaller target', study_session: 'Study together', solution: 'Share a solution' };
let SR = null, SQ = '', EXT = null, T = localStorage.getItem('pb_token'), tab = 'home', D = {}, CFG = { penalties: [] }, mode = 'login', chatWith = null, msgs = [], helpTo = null, cmp = null, newTok = null, err = '', otpEmail = '', otpAt = 0, otpTick = null, landing = true, fgStep = 0, fgEmail = '';

const toast = m => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200); };
async function api(method, url, body) {
  const r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && T) { logout(); throw new Error('Please sign in again'); }
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}
function logout() { landing = true; T = null; localStorage.removeItem('pb_token'); D = {}; renderAuth(); }
async function load() {
  const g = u => api('GET', u);
  const [me, goals, fr, ch, help, lect, nt, lb, ins, un] = await Promise.all([g('/me'), g('/goals'), g('/friends'), g('/challenges'), g('/help'), g('/lectures'), g('/notifications'), g('/leaderboard'), g('/insights'), g('/messages/unread')]);
  D = { me: me.user, st: me.stats, goals: goals.goals, fr, ch: ch.challenges, help, lect: lect.lectures, nt, lb: lb.board, ins: ins.insights, unread: un.unread };
  if (!chatWith || !fr.friends.some(f => f.id === chatWith)) chatWith = fr.friends[0]?.id || null;
}

// ---------- components ----------
const ini = n => esc((n || '?')[0].toUpperCase());
const lane = (name, p, color) => `<div class="lane"><b>${esc(name)}</b><div class="track" role="img" aria-label="${esc(name)} ${p} percent"><div class="fill" style="width:${p}%;background:${color}"></div><div class="dot" style="left:${Math.max(4, Math.min(96, p))}%;background:${color}">${ini(name)}</div></div><span>${p}%</span></div>`;
const cmpMsg = (d, n) => d > 0 ? `${esc(n)} is currently ${d}% behind you. A little help goes a long way.` : d < 0 ? `${esc(n)} is currently ${-d}% ahead. Today's small target helps you catch up.` : `You and ${esc(n)} are level. Keep going together.`;
const bar = p => `<div class="bar" role="img" aria-label="${p} percent"><i style="width:${p}%"></i></div>`;
const card = (h, inner, cls = '') => `<section class="card ${cls}">${h ? `<h2>${h}</h2>` : ''}${inner}</section>`;
const opts = (arr, sel) => arr.map(([v, t]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(t)}</option>`).join('');

function chCard(c) {
  const mp = pc(c.mine, c.total), tp = pc(c.theirs, c.total), d = mp - tp, o = c.other.name;
  const head = `<h2>${esc(c.title)}</h2><div class="tag">with ${esc(o)} · ${c.total} ${esc(c.unit)} · ${c.days} days</div><p><b>Reward:</b> ${esc(c.reward)}<br><b>Agreed penalty:</b> ${esc(c.penalty)}</p>`;
  if (c.needsMyAccept) return card('', head + `<div class="note">${esc(o)} invited you. The challenge starts only when you accept the reward and penalty.</div><p><button data-a="chacc" data-id="${c.id}">Accept</button> <button class="ghost" data-a="chdec" data-id="${c.id}">Decline</button></p>`);
  if (c.status === 'pending') return card('', head + `<div class="note">⏳ Waiting for ${esc(o)} to accept.</div><p><button class="ghost sm" data-a="chleave" data-id="${c.id}">Cancel</button></p>`);
  if (c.status === 'active') return card('', head + lane('You', mp, 'var(--me)') + lane(o, tp, 'var(--fr)') + `<div class="note">${cmpMsg(d, o)}</div><div class="row" style="margin-top:10px"><input id="cl${c.id}" type="number" min="1" value="1" style="width:80px" aria-label="Amount to log"><button data-a="chlog" data-id="${c.id}">Log progress</button><button class="ghost sm" data-a="chleave" data-id="${c.id}">Leave</button></div><p class="tag">Ends ${new Date(c.end_at).toLocaleDateString()}</p>`);
  if (c.status === 'ended') return card('', head + `<div class="note">🏁 Finished. ${c.iWon ? 'You reached the finish first. Enjoy the reward, and consider helping your friend finish too.' : c.theyWon ? `${esc(o)} got there first. You both made progress. Time for the agreed reward.` : 'It finished level.'}</div>`);
  return '';
}
const goalCard = g => { const p = pc(g.done, g.total), late = g.deadline && g.deadline < new Date().toISOString().slice(0, 10) && g.done < g.total;
  return card('', `<div class="row"><h2>${esc(g.name)}</h2><button class="sm" data-a="log" data-id="${g.id}" ${g.done >= g.total ? 'disabled' : ''}>+1</button></div>${bar(p)}<div class="row tag" style="margin-top:6px"><span>${g.done} of ${g.total} ${esc(g.unit)} · ${p}%</span><span>${g.deadline ? 'Due ' + esc(g.deadline) : ''}</span></div><div class="tag">Milestones: ${[25, 50, 75, 100].map(m => p >= m ? '✅' + m : '⬜' + m).join(' ')}</div>${late ? `<div class="note">⚠️ Goal missed. Don't give up. ${g.total - g.done} ${esc(g.unit)} left: set a new date and split it into small daily steps.</div>` : ''}<p><button class="ghost sm" data-a="delgoal" data-id="${g.id}">Delete</button></p>`); };
const lectList = () => D.lect.length ? D.lect.map(l => { const p = pc(l.pos, l.dur); return `<div style="margin:14px 0"><div>${esc(l.title || 'YouTube lecture (title appears once you play it)')}${l.done ? ' ✅' : ''}</div>${bar(p)}<div class="tag" style="margin:6px 0">${fmt(l.pos)} of ${fmt(l.dur)} · ${p}% · ${fmt(l.secs)} actually watched</div><button class="sm" data-a="watchhere" data-id="${l.id}">${l.pos > 5 && !l.done ? '▶ Resume here' : '▶ Watch here'}</button> <button class="ghost sm" data-a="manual" data-id="${l.id}">Log manually</button> <button class="ghost sm" data-a="dellect" data-id="${l.id}">Remove</button></div>`; }).join('') : '<p>No lectures yet. Add a YouTube link above.</p>';
const srList = () => SR === null ? '' : SR.length ? SR.map(r => { const added = D.lect.some(l => l.vid === r.vid); return `<div class="res">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : ''}<div><b>${esc(r.title)}</b><span class="tag">${esc(r.channel)}${r.dur ? ' · ' + fmt(r.dur) : ''}</span><div style="margin-top:6px"><button class="sm" data-a="addwatch" data-v="${esc(r.vid)}">▶ Watch</button> <button class="ghost sm" data-a="addonly" data-v="${esc(r.vid)}" ${added ? 'disabled' : ''}>${added ? '✓ Added' : '+ Add'}</button></div></div></div>`; }).join('') : '<p>No results. Try different words.</p>';

// ---------- views ----------
const V = {
  home() {
    const act = D.ch.filter(c => c.status === 'active'), c = act[0]; let h = '';
    if (c) {
      const mp = pc(c.mine, c.total), tp = pc(c.theirs, c.total), d = mp - tp;
      h += card(esc(c.title), `<div class="tag">${esc(c.other.name)} · Reward: ${esc(c.reward)}</div>${lane('You', mp, 'var(--me)')}${lane(c.other.name, tp, 'var(--fr)')}<div class="note">${cmpMsg(d, c.other.name)}</div>`, 'hero');
      if (d < 0) { const n = c.theirs - c.mine, t = Math.ceil(n / 2); h += card('Catch-up plan', `<p>You are ${n} ${esc(c.unit)} behind. Don't worry.</p><p><b>Today:</b> ${t} ${esc(c.unit)}<br><b>Tomorrow:</b> ${n - t} ${esc(c.unit)}<br><b>Estimated recovery:</b> ${n > 1 ? 2 : 1} day${n > 1 ? 's' : ''}</p><button data-go="duel">Log progress</button>`); }
      if (d >= 10) h += card('🤝 Help ' + esc(c.other.name), `<p>${esc(c.other.name)} is ${d}% behind you. Would you like to help them catch up?</p><button data-a="helpfor" data-id="${c.other.id}">See ways to help</button>`);
    } else h += card('Ready for a buddy challenge?', '<p>Add a friend, agree on a reward and penalty together, and start.</p><button data-go="friends">Find a friend</button>', 'hero');
    const inv = D.ch.filter(x => x.needsMyAccept).length; if (inv) h += card('Challenge invitations', `<p>You have ${inv} waiting.</p><button data-go="duel">Review</button>`);
    h += card('Goals today', D.goals.length ? D.goals.slice(0, 5).map(g => `<div class="row" style="margin:10px 0"><span>${esc(g.name)}<br><small class="tag">${g.done}/${g.total} ${esc(g.unit)}</small></span><button class="sm" data-a="log" data-id="${g.id}" ${g.done >= g.total ? 'disabled' : ''}>+1 done</button></div>`).join('') : '<p>No goals yet. Add one in Goals.</p>');
    h += card('💡 Suggestions', D.ins.map(i => `<div class="note">${esc(i.text)}</div>`).join(''));
    h += card('Updates', D.nt.items.length ? D.nt.items.slice(0, 6).map(n => `<div class="note">🔔 ${esc(n.text)}</div>`).join('') : '<p>Nothing yet.</p>');
    return h;
  },
  goals() {
    return D.goals.map(goalCard).join('') + card('Add a goal', `<label for="gn">Goal name</label><input id="gn" maxlength="100" placeholder="Learn Java"><label for="gd0">Description (optional)</label><input id="gd0" maxlength="500"><label for="gt">Total target</label><input id="gt" type="number" min="1" value="20"><label for="gu">Unit</label><select id="gu">${opts(['lessons', 'problems', 'chapters', 'hours', 'projects', 'tasks'].map(x => [x, x]))}</select><label for="gp">Priority</label><select id="gp">${opts([['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'medium')}</select><label for="gd">Deadline (optional)</label><input id="gd" type="date"><p><button data-a="addgoal">Save goal</button></p>`);
  },
  duel() {
    const fr = D.fr.friends; let h = D.ch.map(chCard).join('');
    h += card('New challenge', fr.length ? `<p class="tag">Reward and penalty are agreed up front and the challenge starts only after your friend accepts.</p><label for="cf">Friend</label><select id="cf">${opts(fr.map(f => [f.id, f.name]))}</select><label for="ct">Title</label><input id="ct" maxlength="100" placeholder="Solve 50 DSA problems"><label for="cn">Target</label><input id="cn" type="number" min="1" value="30"><label for="cu">Unit</label><select id="cu">${opts(['problems', 'lessons', 'chapters', 'hours', 'tasks'].map(x => [x, x]))}</select><label for="cd">Days</label><input id="cd" type="number" min="1" max="365" value="30"><label for="cr">Winner reward</label><input id="cr" maxlength="100" value="A coffee treat"><label for="cp">Penalty (agreed)</label><select id="cp">${opts(CFG.penalties.map(x => [x, x]))}</select><p><button data-a="mkch">Send challenge</button></p>` : '<p>Add a friend first.</p><button data-go="friends">Go to Friends</button>');
    return h;
  },
  friends() {
    const f = D.fr; let h = card('Add a friend', `<label for="fe">Their email</label><input id="fe" type="email" placeholder="friend@example.com"><p><button data-a="frreq">Send request</button></p>`);
    if (f.incoming.length) h += card('Requests', f.incoming.map(r => `<div class="row" style="margin:8px 0"><span>${esc(r.from.name)}</span><span><button class="sm" data-a="fracc" data-id="${r.id}">Accept</button> <button class="ghost sm" data-a="frdec" data-id="${r.id}">Decline</button></span></div>`).join(''));
    if (f.outgoing.length) h += card('Sent', f.outgoing.map(r => `<div>⏳ ${esc(r.to.name)}</div>`).join(''));
    h += card('Friends', f.friends.length ? f.friends.map(x => `<div style="margin:10px 0"><div class="row"><b>${esc(x.name)}</b><span class="tag">${x.streak}d streak</span></div><button class="ghost sm" data-a="cmp" data-id="${x.id}">Compare</button> <button class="ghost sm" data-a="frrm" data-id="${x.id}">Remove</button> <button class="ghost sm" data-a="frblk" data-id="${x.id}">Block</button> <button class="ghost sm" data-a="frrep" data-id="${x.id}">Report</button></div>`).join('') : '<p>No friends yet.</p>');
    if (cmp) { const m = cmp.me, o = cmp.friend, rows = m.goals.map(g => { const og = (o.goals || []).find(x => x.name.toLowerCase() === g.name.toLowerCase()); return `<tr><td>${esc(g.name)}</td><td>${pc(g.done, g.total)}%</td><td>${o.goals ? (og ? pc(og.done, og.total) + '%' : '-') : 'Private'}</td></tr>`; }).join('');
      h += card(`You and ${esc(o.name)}`, `<table><tr><th></th><th>You</th><th>${esc(o.name)}</th></tr>${rows}<tr><td>Streak</td><td>${m.streak}d</td><td>${o.streak ?? 'Private'}${o.streak != null ? 'd' : ''}</td></tr><tr><td>Study hours</td><td>${m.hours}h</td><td>${o.hours ?? 'Private'}${o.hours != null ? 'h' : ''}</td></tr></table><p class="tag">Only what each person chooses to share is shown.</p>`); }
    if (f.friends.length) { const hs = D.help;
      h += card('🤝 Help a friend', `<p class="tag">They can accept or decline. If they accept, you earn +25 XP.</p><label for="ht">Friend</label><select id="ht">${opts(f.friends.map(x => [x.id, x.name]), String(helpTo))}</select><label for="hk">How would you like to help?</label><select id="hk">${opts(Object.entries(HELP))}</select><label for="hm">Message (optional)</label><input id="hm" maxlength="500"><p><button data-a="helpsend">Send offer</button></p>`);
      if (hs.incoming.length) h += card('Help offers for you', hs.incoming.map(x => `<div class="row" style="margin:8px 0"><span>${esc(x.uname)}: ${esc(HELP[x.kind] || x.kind)}${x.message ? '<br><small class="tag">' + esc(x.message) + '</small>' : ''}</span>${x.status === 'pending' ? `<span><button class="sm" data-a="helpacc" data-id="${x.id}">Accept</button> <button class="ghost sm" data-a="helpdec" data-id="${x.id}">No thanks</button></span>` : `<span class="pill">${esc(x.status)}</span>`}</div>`).join('')); }
    return h;
  },
  chat() {
    const f = D.fr.friends; if (!f.length) return card('Chat', '<p>Add a friend to start chatting.</p>');
    return card('Chat', `<label for="cw">With</label><select id="cw" data-c="cw">${opts(f.map(x => [x.id, x.name]), String(chatWith))}</select><div class="msgs" id="msgs" aria-live="polite" style="margin-top:10px"></div><div class="chips">${['Nice work! 👏', 'Study together at 7?', 'Need a hint?', 'Small steps today 🙂'].map(q => `<button class="ghost sm" data-a="quick" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div><div class="send"><label for="ci" style="position:absolute;left:-9999px">Message</label><input id="ci" maxlength="1000" placeholder="Write a message" autocomplete="off"><button data-a="send">Send</button></div>`);
  },
  watch() {
    return card('Find a lecture', `<label for="sq">Search for a lecture</label><div class="send"><input id="sq" placeholder="e.g. Java collections tutorial" maxlength="100" value="${esc(SQ)}"><button data-a="search">Search</button></div>${CFG.search ? '' : '<p class="tag">In-app results are not switched on for this site yet, so Search opens YouTube. Copy the link of the lecture you like and paste it below.</p>'}<label for="yg">Credit a goal when I finish</label><select id="yg"><option value="">None</option>${opts(D.goals.map(g => [g.id, g.name]))}</select><div id="sr">${srList()}</div><details style="margin-top:12px" ${CFG.search ? '' : 'open'}><summary>Or paste a link</summary><label for="yl">YouTube link</label><input id="yl" placeholder="https://www.youtube.com/watch?v=..."><p><button data-a="addlect">Add lecture</button></p></details>`)
      + card('My lectures', `<div id="player"></div><div id="ll">${lectList()}</div>`)
      + `<div id="extcard">${extCard()}</div>`;
  },
  rewards() {
    const m = D.me, s = D.st, lvl = m.level, B = [['🔥', '7-Day Streak', m.streak >= 7], ['🤝', 'Helpful Friend', s.helps >= 1], ['🧑‍🏫', 'Mentor', s.helps >= 3], ['🏆', 'Challenge Winner', s.wins >= 1], ['📚', 'Study Champion', s.lectures_done >= 1], ['🚀', 'Goal Getter', s.goals_done >= 1], ['💎', 'Consistency Master', m.streak >= 30], ['🌟', 'Level 5', lvl >= 5]];
    return card(`Level ${lvl}`, `<p>${m.xp} XP · ${100 - (m.xp % 100)} XP to next level</p>${bar(m.xp % 100)}`, 'hero')
      + card('Badges', `<div class="badges">${B.map(b => `<div class="badge ${b[2] ? '' : 'off'}"><span>${b[0]}</span>${b[1]}</div>`).join('')}</div>`)
      + card('Friends leaderboard', `<p class="tag">Helping friends earns XP too, so it's not only about speed.</p><table><tr><th>#</th><th>Name</th><th>XP</th><th>Helps</th><th>Wins</th></tr>${D.lb.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}${r.you ? ' (you)' : ''}</td><td>${r.xp}</td><td>${r.helps}</td><td>${r.wins}</td></tr>`).join('')}</table>`);
  },
  me() {
    const m = D.me, sw = (k, t) => `<label class="sw"><input type="checkbox" data-c="priv" data-k="${k}" ${m[k] ? 'checked' : ''}>${t}</label>`;
    return card('Profile', `<label for="pn">Name</label><input id="pn" maxlength="60" value="${esc(m.name)}"><label for="pc">My circumstances and goals</label><textarea id="pc" maxlength="1000" placeholder="e.g. College 9-4, 2 hours free on weekdays, exams next month">${esc(m.circumstances)}</textarea><p><button data-a="saveprof">Save</button></p>`)
      + card('Privacy', sw('share_progress', 'Friends can see my goals, XP and streak') + sw('share_hours', 'Friends can see my study hours') + sw('share_ach', 'Show me on friends\' leaderboards') + `<p class="tag">Blocked: ${D.fr.blocked.length ? D.fr.blocked.map(b => `${esc(b.name)} <button class="ghost sm" data-a="unblk" data-id="${b.id}">Unblock</button>`).join(', ') : 'nobody'}</p>`)
      + card('Account', `<p>${esc(m.email)}</p><button class="ghost" data-a="logout">Sign out</button> <button class="ghost" data-a="delacct">Delete my account</button>`);
  }
};
const TABS = [['home', '🏠', 'Home'], ['goals', '🎯', 'Goals'], ['duel', '⚔️', 'Duel'], ['friends', '🤝', 'Friends'], ['chat', '💬', 'Chat'], ['watch', '▶️', 'Watch'], ['rewards', '🏅', 'Rewards']];

function renderOtp() {
  $('#nav').classList.add('hide'); clearInterval(otpTick);
  $('#app').innerHTML = `<div class="auth card"><h1 style="font-size:28px;font-weight:800">Check your email</h1><p class="tag">We sent a 6-digit code to <b>${esc(otpEmail)}</b>. It expires in 10 minutes.</p><label for="ao">Verification code</label><input id="ao" class="otp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000" aria-describedby="aerr"><div class="err" id="aerr">${esc(err)}</div><button data-a="verify">Verify and continue</button><div class="row" style="margin-top:12px"><button class="ghost sm" id="rsd" data-a="resend">Resend code</button><button class="ghost sm" data-a="otpback">Use a different email</button></div></div>`;
  const b = $('#rsd'), ao = $('#ao'); if (ao) ao.focus();
  otpTick = setInterval(() => { const x = $('#rsd'); if (!x) return clearInterval(otpTick); const w = Math.ceil((otpAt + 30000 - Date.now()) / 1000); x.disabled = w > 0; x.textContent = w > 0 ? `Resend in ${w}s` : 'Resend code'; }, 500);
  if (b) { b.disabled = true; }
}
function renderLanding() {
  $('#nav').classList.add('hide'); clearInterval(otpTick);
  const face = c => `<div class="l-face ${c}">${'<i></i>'.repeat(9)}</div>`;
  const item = (t, s) => `<button class="l-di" data-a="start"><b>${t}</b><span>${s}</span></button>`;
  $('#app').innerHTML = `<div class="landing"><div class="l-glow"></div>
  <div class="l-top"><button class="l-logo" data-a="home" aria-label="ProgressBuddy home"><img src="/icon.svg" alt="" width="26" height="26"><span>ProgressBuddy</span></button>
  <div class="l-menu" role="navigation" aria-label="Site">
    <div class="l-item"><button class="l-link" aria-haspopup="true">Features <em>⌄</em></button><div class="l-drop">${item('Goals', 'Set targets and log every small step')}${item('Duels', 'Challenge a friend with an agreed reward')}${item('Chat', 'Cheer each other on in real time')}${item('Watch', 'Study from YouTube lectures with progress tracking')}</div></div>
    <div class="l-item"><button class="l-link" aria-haspopup="true">How it works <em>⌄</em></button><div class="l-drop">${item('1 · Add a friend', 'Send a request and connect')}${item('2 · Agree on stakes', 'Pick a reward and a friendly penalty')}${item('3 · Grow together', 'Log progress and watch the race')}</div></div>
    <div class="l-item"><button class="l-link" aria-haspopup="true">Why buddies <em>⌄</em></button><div class="l-drop">${item('Streaks and badges', 'Earn XP, levels and rewards')}${item('Catch-up plans', 'Fall behind? Get a small, kind plan')}${item('You stay in control', 'Choose exactly what friends can see')}</div></div>
  </div>
  <div class="l-cta"><button class="l-text" data-a="signin">Sign in</button><button class="l-btn" data-a="start">Get started</button></div></div>
  <div class="l-hero"><div class="l-copy"><div class="l-pill">Study smarter, together</div><h1>Goals are better with a buddy.</h1><p>Set goals, challenge a friend, track every lecture and cheer each other on. Compete with your friend, not against your friend.</p><div class="l-actions"><button class="l-btn big" data-a="start">Get started</button><button class="l-ghost" data-a="signin">Sign in</button></div></div>
  <div class="l-scene" aria-hidden="true"><div class="l-tilt"><div class="l-cube">${['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(face).join('')}</div></div><div class="l-floor"></div></div></div></div>`;
}
function renderForgot() {
  $('#nav').classList.add('hide'); clearInterval(otpTick);
  const body = fgStep === 1
    ? `<p class="tag">Enter your account email and we will send you a 6-digit code.</p><label for="fe">Email</label><input id="fe" type="email" autocomplete="email" value="${esc(fgEmail)}"><div class="err" id="aerr">${esc(err)}</div><button data-a="fsend">Send code</button>`
    : `<p class="tag">We sent a code to <b>${esc(fgEmail)}</b> if an account exists. It expires in 10 minutes.</p><label for="fo">Verification code</label><input id="fo" class="otp" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="000000"><label for="fp">New password (8+ characters)</label>${pwField('fp', 'new-password')}<div class="err" id="aerr">${esc(err)}</div><button data-a="freset">Update password</button><p style="margin:12px 0 0"><button class="ghost sm" data-a="fsend">Resend code</button></p>`;
  $('#app').innerHTML = `<div class="auth card"><p style="margin:0 0 10px"><button class="ghost sm" data-a="fback">← Back to sign in</button></p><h1 style="font-size:28px;font-weight:800">Reset password</h1>${body}</div>`;
  const f = $(fgStep === 1 ? '#fe' : '#fo'); if (f) f.focus();
}
function renderAuth() {
  if (otpEmail) return renderOtp();
  if (landing) return renderLanding();
  if (fgStep) return renderForgot();
  clearInterval(otpTick);
  $('#nav').classList.add('hide');
  $('#app').innerHTML = `<div class="auth card"><p style="margin:0 0 10px"><button class="ghost sm" data-a="home">← Back</button></p><h1 style="font-size:28px;font-weight:800">ProgressBuddy</h1><p class="tag">Grow together. Compete together. Never give up.</p><div class="tabs"><button class="${mode === 'login' ? '' : 'ghost'}" data-a="mode" data-m="login">Sign in</button><button class="${mode === 'register' ? '' : 'ghost'}" data-a="mode" data-m="register">Create account</button></div>${mode === 'register' ? '<label for="an">Name</label><input id="an" maxlength="60" autocomplete="name">' : ''}<label for="ae">Email</label><input id="ae" type="email" autocomplete="email"><label for="ap">Password (8+ characters)</label>${pwField('ap', mode === 'login' ? 'current-password' : 'new-password')}${mode === 'login' && CFG.otp ? '<p class="forgot"><button type="button" class="linkbtn" data-a="forgot">Forgot password?</button></p>' : ''}<div class="err" id="aerr">${esc(err)}</div><button data-a="${mode}">${mode === 'login' ? 'Sign in' : 'Create account'}</button></div>`;
}
function render() {
  $('#app').innerHTML = `<header><div><h1>ProgressBuddy</h1><div class="tag">Hi ${esc(D.me.name)} · Level ${D.me.level} · 🔥 ${D.me.streak}d · ${D.me.xp} XP</div></div><div class="row"><button class="ghost sm bell" data-a="bell" aria-label="Notifications">🔔${D.nt.unread ? `<b>${D.nt.unread}</b>` : ''}</button><button class="ghost sm" data-go="me" aria-label="Profile">⚙️</button><button class="ghost sm" data-a="theme" aria-label="Toggle theme">◐</button></div></header><div id="view">${V[tab]()}</div>`;
  const un = D.unread.reduce((a, x) => a + x.c, 0);
  $('#nav').classList.remove('hide');
  $('#nav').innerHTML = TABS.map(t => `<button data-go="${t[0]}" ${t[0] === tab ? 'aria-current="page"' : ''}><span>${t[1]}${t[0] === 'chat' && un ? '•' : ''}</span>${t[2]}</button>`).join('');
  if (tab === 'chat') loadMsgs();
  if (tab === 'watch') { EXT = null; window.postMessage({ source: 'pb-page', type: 'hello' }, location.origin); }
}
async function loadMsgs(scroll = true) {
  if (!chatWith) return; const m = $('#msgs'); if (!m) return;
  try { msgs = (await api('GET', '/messages/' + chatWith)).messages; } catch { return; }
  const box = $('#msgs'); if (!box) return;
  box.innerHTML = msgs.length ? msgs.map(x => `<div class="msg ${x.from_id === D.me.id ? 'me' : 'fr'}">${esc(x.body)}<small>${tm(x.created_at)}</small></div>`).join('') : '<p class="tag">No messages yet. Say hi!</p>';
  if (scroll) box.scrollTop = box.scrollHeight;
}
async function go(t) { stopPlayer(); tab = t; try { await load(); } catch (e) { toast(e.message); return; } render(); scrollTo(0, 0); }
async function refresh() { await load(); if (tab === 'watch' && player) { const l = $('#ll'); if (l) l.innerHTML = lectList(); const s = $('#sr'); if (s) s.innerHTML = srList(); return; } render(); }

// ---------- in-app lecture player (works on phones and computers, no extension) ----------
let YTp = null, player = null, pl = null, tickT = null, lastPos = null, lastSent = 0, lastState = -1;
const extCard = () => card('Optional: watch on youtube.com (computer only)', EXT === null
  ? `<p class="tag">Prefer YouTube's own site? Add our small Chrome extension. It connects with one click. Phones don't support extensions, but <b>Watch here</b> works everywhere.</p><p><a class="pill" href="/extension.zip">Download extension</a> <button class="ghost sm" data-a="extcheck">Check again</button></p><p class="tag">One-time setup: unzip the <b>downloaded</b> file, open chrome://extensions, turn on Developer mode, press Load unpacked and choose the folder that directly contains <b>manifest.json</b>. Then reload this page.</p><p class="tag">Already installed but not detected? Reload this page (tabs opened before the install can't see it), make sure the extension was loaded from the file downloaded here, and that you're using the same address you downloaded it from.</p>`
  : EXT.paired ? `<p>✅ Extension connected. Lectures you add here are tracked when you play them on youtube.com.</p><button class="ghost sm" data-a="unpair">Disconnect</button>`
  : `<p>🧩 Extension detected on this browser.</p><button data-a="pair">Connect extension</button>`);
const loadYT = () => YTp || (YTp = new Promise(res => { if (window.YT && YT.Player) return res(); const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => { YTp = null; res(); }; window.onYouTubeIframeAPIReady = res; document.head.append(s); }));
function sendProgress(keep) {
  if (!pl || !player || !player.getCurrentTime || !T) return;
  const body = { pos: player.getCurrentTime(), dur: player.getDuration(), secs: pl.base, title: (player.getVideoData() || {}).title };
  fetch('/api/lectures/' + pl.id + '/progress', { method: 'POST', keepalive: !!keep, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T }, body: JSON.stringify(body) }).catch(() => {});
  lastSent = Date.now();
}
function stopPlayer() { if (player) { sendProgress(true); clearInterval(tickT); try { player.destroy(); } catch {} } player = null; pl = null; lastPos = null; lastState = -1; }
function tickPlayer() {
  if (!player || !player.getPlayerState) return;
  const st = player.getPlayerState(), cur = player.getCurrentTime(), dur = player.getDuration();
  if (st === 1 && lastPos !== null && cur > lastPos && cur - lastPos < 3) pl.base += cur - lastPos;   // seeking never counts as watching
  lastPos = cur;
  const el = $('#pstat'); if (el) el.textContent = `${st === 1 ? '🟢 Watching' : st === 0 ? '✅ Finished' : '⏸ Paused'} · ${fmt(cur)} / ${fmt(dur)} (${pc(cur, dur)}%) · progress saves automatically`;
  if ((st === 1 && Date.now() - lastSent > 10000) || (st !== lastState && lastState !== -1 && st !== 3)) sendProgress();
  lastState = st;
}
async function addFromSearch(vid) { const r = (SR || []).find(x => x.vid === vid); if (!r) return; await api('POST', '/lectures', { url: vid, title: r.title, dur: r.dur, goal_id: val('yg') || null }); }
async function watchHere(id) {
  const l = D.lect.find(x => x.id == id); if (!l) return; stopPlayer();
  $('#player').innerHTML = '<div id="ytp"></div><div class="note" id="pstat">Loading player...</div>';
  await loadYT(); if (!window.YT || !YT.Player) { $('#player').innerHTML = ''; toast('Could not load the YouTube player. Check your connection and try again.'); return; }
  pl = { id: l.id, base: l.secs };
  player = new YT.Player('ytp', { width: '100%', height: '100%', videoId: l.vid, playerVars: { playsinline: 1, rel: 0, start: Math.floor(l.pos) }, events: {
    onReady: () => { tickT = setInterval(tickPlayer, 1000); },
    onError: c => { const el = $('#pstat'); if (el) el.textContent = [101, 150].includes(c) ? 'The owner of this video does not allow playing it here. Open it on YouTube and use "Log manually", or use the desktop extension.' : 'This video could not be played. Check the link.'; } } });
  $('#player').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
addEventListener('pagehide', () => sendProgress(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) sendProgress(true); });
addEventListener('message', e => {
  const d = e.data; if (e.source !== window || !d || d.source !== 'pb-ext') return;
  EXT = { paired: !!d.paired }; const x = $('#extcard'); if (x) x.innerHTML = extCard();
});

// ---------- actions ----------
const A = {
  mode: el => { mode = el.dataset.m; err = ''; renderAuth(); },
  async login() { try { const r = await api('POST', '/auth/login', { email: val('ae'), password: val('ap') }); if (r.otp) { otpEmail = r.email; otpAt = Date.now(); err = ''; return renderAuth(); } T = r.token; localStorage.setItem('pb_token', T); err = ''; await go('home'); } catch (e) { err = e.message; $('#aerr').textContent = err; } },
  async register() { try { const r = await api('POST', '/auth/register', { name: val('an'), email: val('ae'), password: val('ap') }); if (r.otp) { otpEmail = r.email; otpAt = Date.now(); err = ''; return renderAuth(); } T = r.token; localStorage.setItem('pb_token', T); err = ''; await go('home'); } catch (e) { err = e.message; $('#aerr').textContent = err; } },
  start() { fgStep = 0; mode = 'register'; landing = false; err = ''; renderAuth(); },
  signin() { fgStep = 0; mode = 'login'; landing = false; err = ''; renderAuth(); },
  home() { landing = true; err = ''; renderAuth(); },
  forgot() { fgStep = 1; fgEmail = val('ae'); err = ''; renderAuth(); },
  fback() { fgStep = 0; err = ''; renderAuth(); },
  async fsend() { try { const em = fgStep === 1 ? val('fe') : fgEmail; await api('POST', '/auth/forgot', { email: em }); fgEmail = em.trim().toLowerCase(); fgStep = 2; err = ''; renderAuth(); toast('If that email has an account, a code is on its way'); } catch (e) { err = e.message; const x = $('#aerr'); if (x) x.textContent = err; } },
  async freset() { try { await api('POST', '/auth/reset', { email: fgEmail, code: val('fo'), password: val('fp') }); fgStep = 0; mode = 'login'; err = ''; renderAuth(); toast('Password updated. Please sign in.'); } catch (e) { err = e.message; const x = $('#aerr'); if (x) x.textContent = err; } },
  async verify() { try { const r = await api('POST', '/auth/verify', { email: otpEmail, code: val('ao') }); T = r.token; localStorage.setItem('pb_token', T); otpEmail = ''; err = ''; await go('home'); } catch (e) { err = e.message; const x = $('#aerr'); if (x) x.textContent = err; } },
  async resend() { try { await api('POST', '/auth/resend', { email: otpEmail }); otpAt = Date.now(); err = ''; renderAuth(); toast('A new code is on its way'); } catch (e) { err = e.message; const x = $('#aerr'); if (x) x.textContent = err; } },
  otpback() { otpEmail = ''; err = ''; renderAuth(); },
  logout, theme() { const r = document.documentElement; const dark = (r.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light')) === 'dark'; r.dataset.theme = dark ? 'light' : 'dark'; },
  async bell() { await api('POST', '/notifications/read'); tab = 'home'; await refresh(); },
  async log(el) { const r = await api('POST', `/goals/${el.dataset.id}/log`, { amount: 1 }); toast(r.message ? `${r.message} +${r.xp} XP` : `Small progress is still progress. +${r.xp} XP`); await refresh(); },
  async addgoal() { await api('POST', '/goals', { name: val('gn'), description: val('gd0'), total: val('gt'), unit: val('gu'), priority: val('gp'), deadline: val('gd') || null }); toast('Goal saved'); await refresh(); },
  async delgoal(el) { if (confirm('Delete this goal?')) { await api('DELETE', '/goals/' + el.dataset.id); await refresh(); } },
  async mkch() { await api('POST', '/challenges', { friend_id: val('cf'), title: val('ct'), total: val('cn'), unit: val('cu'), days: val('cd'), reward: val('cr'), penalty: val('cp') }); toast('Challenge sent. It starts when your friend accepts.'); await refresh(); },
  async chacc(el) { await api('POST', `/challenges/${el.dataset.id}/accept`); toast('Challenge started!'); await refresh(); },
  async chdec(el) { await api('POST', `/challenges/${el.dataset.id}/decline`); await refresh(); },
  async chleave(el) { if (confirm('Leave this challenge? No penalty applies.')) { await api('POST', `/challenges/${el.dataset.id}/leave`); await refresh(); } },
  async chlog(el) { const r = await api('POST', `/challenges/${el.dataset.id}/log`, { amount: val('cl' + el.dataset.id) || 1 }); toast(r.message || 'Progress logged. +5 XP'); await refresh(); },
  async frreq() { const r = await api('POST', '/friends/request', { email: val('fe') }); toast(r.message); await refresh(); },
  async fracc(el) { await api('POST', `/friends/${el.dataset.id}/accept`); await refresh(); },
  async frdec(el) { await api('POST', `/friends/${el.dataset.id}/decline`); await refresh(); },
  async frrm(el) { if (confirm('Remove this friend?')) { await api('DELETE', '/friends/user/' + el.dataset.id); cmp = null; await refresh(); } },
  async frblk(el) { if (confirm('Block this person? They will no longer be able to contact you.')) { await api('POST', `/friends/user/${el.dataset.id}/block`); cmp = null; await refresh(); } },
  async unblk(el) { await api('POST', `/friends/user/${el.dataset.id}/unblock`); await refresh(); },
  async frrep(el) { const r = prompt('What happened? (shared only with the app owner)'); if (r) toast((await api('POST', '/report', { user_id: +el.dataset.id, reason: r })).message); },
  async cmp(el) { cmp = await api('GET', `/friends/user/${el.dataset.id}/compare`); render(); },
  async helpfor(el) { helpTo = +el.dataset.id; await go('friends'); },
  async helpsend() { await api('POST', '/help', { to_id: val('ht'), kind: val('hk'), message: val('hm') }); toast('Offer sent. They can accept or decline.'); await refresh(); },
  async helpacc(el) { await api('POST', `/help/${el.dataset.id}/accept`); await refresh(); },
  async helpdec(el) { await api('POST', `/help/${el.dataset.id}/decline`); await refresh(); },
  async send() { const b = val('ci').trim(); if (!b) return; await api('POST', '/messages/' + chatWith, { body: b }); $('#ci').value = ''; $('#ci').focus(); await loadMsgs(); },
  async quick(el) { await api('POST', '/messages/' + chatWith, { body: el.dataset.q }); await loadMsgs(); },
  async addlect() { await api('POST', '/lectures', { url: val('yl'), goal_id: val('yg') || null }); toast('Added. Press Watch here to start.'); await refresh(); },
  async dellect(el) { await api('DELETE', '/lectures/' + el.dataset.id); await refresh(); },
  extcheck() { window.postMessage({ source: 'pb-page', type: 'hello' }, location.origin); setTimeout(() => { if (EXT === null) toast('Still not detected. Reload this page, or re-download and load the extension from this site.'); }, 800); },
  async search() {
    const q = val('sq').trim(); SQ = q;
    if (!CFG.search) { window.open('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), '_blank', 'noopener'); toast('Copy the link of the lecture you like, then paste it under "Or paste a link".'); return; }
    if (q.length < 2) { toast('Type at least 2 letters'); return; }
    $('#sr').innerHTML = '<p class="tag">Searching...</p>';
    try { SR = (await api('GET', '/search?q=' + encodeURIComponent(q))).items; } catch (e) { SR = null; $('#sr').innerHTML = ''; throw e; }
    $('#sr').innerHTML = srList();
  },
  async addonly(el) { await addFromSearch(el.dataset.v); toast('Added to your lectures'); await refresh(); },
  async addwatch(el) { await addFromSearch(el.dataset.v); await refresh(); const l = D.lect.find(x => x.vid === el.dataset.v); if (l) watchHere(l.id); },
  watchhere: el => watchHere(el.dataset.id),
  async manual(el) { const l = D.lect.find(x => x.id == el.dataset.id); const m = prompt('Up to which minute have you watched? (e.g. 25)'); if (!m) return; const body = { pos: Math.round(parseFloat(m) * 60) };
    if (!l.dur) { const t = prompt('Total length of the lecture in minutes?'); if (t) body.dur = Math.round(parseFloat(t) * 60); } await api('POST', `/lectures/${el.dataset.id}/manual`, body); toast('Saved'); await refresh(); },
  async pair() { const t = (await api('POST', '/ext/token')).token; window.postMessage({ source: 'pb-page', type: 'pair', token: t }, location.origin); toast('Connecting the extension...'); },
  unpair() { window.postMessage({ source: 'pb-page', type: 'unpair' }, location.origin); },
  async saveprof() { await api('PATCH', '/me', { name: val('pn'), circumstances: val('pc') }); toast('Saved'); await refresh(); },
  async delacct() { const p = prompt('Type your password to permanently delete your account and all data.'); if (p) { await api('DELETE', '/me', { password: p }); logout(); } }
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a],[data-go]'); if (!el) return;
  if (el.dataset.go) return go(el.dataset.go);
  const fn = A[el.dataset.a]; if (fn) Promise.resolve(fn(el)).catch(x => toast(x.message));
});
document.addEventListener('change', async e => {
  const el = e.target; if (!el.dataset.c) return;
  try { if (el.dataset.c === 'cw') { chatWith = +el.value; loadMsgs(); } else if (el.dataset.c === 'priv') { await api('PATCH', '/me', { [el.dataset.k]: el.checked }); toast('Privacy updated'); await load(); } } catch (x) { toast(x.message); }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'sq') A.search().catch(x => toast(x.message)); if (e.key === 'Enter' && e.target.id === 'ci') A.send().catch(x => toast(x.message)); if (e.key === 'Enter' && ['ae', 'ap', 'an'].includes(e.target.id)) A[mode]().catch(() => {}); if (e.key === 'Enter' && e.target.id === 'ao') A.verify().catch(() => {}); if (e.key === 'Enter' && e.target.id === 'fe') A.fsend().catch(() => {}); if (e.key === 'Enter' && ['fo', 'fp'].includes(e.target.id)) A.freset().catch(() => {}); });
setInterval(() => { if (!T || document.hidden) return; if (tab === 'chat') loadMsgs(false); if (tab === 'watch') api('GET', '/lectures').then(r => { D.lect = r.lectures; const l = $('#ll'); if (l) l.innerHTML = lectList(); }).catch(() => {}); }, 5000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => { try { CFG = await api('GET', '/config'); } catch {} if (T) { try { await go('home'); return; } catch {} } renderAuth(); })();
