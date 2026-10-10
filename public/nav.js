// Mobile menu toggle only. Tab switching itself is still handled by app.js.
(function () {
  var b = document.getElementById('navtoggle'), s = document.getElementById('navscrim');
  if (!b || !s) return;
  function set(open) {
    document.body.classList.toggle('nav-open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    b.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  b.addEventListener('click', function () { set(!document.body.classList.contains('nav-open')); });
  s.addEventListener('click', function () { set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  document.addEventListener('click', function (e) { if (e.target.closest && e.target.closest('#nav button')) set(false); });
  window.addEventListener('resize', function () { if (window.innerWidth >= 768) set(false); });
})();

// Visual polish only: flag a screen change so CSS can play entrance animations once
// (not on every re-render caused by logging progress, chat refresh, etc.).
(function () {
  var app = document.getElementById('app'), nav = document.getElementById('nav');
  if (!app || !nav || !window.MutationObserver) return;
  var last = null, timer = null;
  function key() {
    if (app.querySelector('.landing')) return 'landing';
    if (nav.classList.contains('hide')) return 'auth';
    var c = nav.querySelector('[aria-current]');
    return c ? c.getAttribute('data-go') : '';
  }
  function check() {
    document.body.classList.toggle('is-landing', !!app.querySelector('.landing'));
    var k = key();
    if (k === last || !k) return;
    last = k;
    document.body.classList.add('enter');
    clearTimeout(timer);
    timer = setTimeout(function () { document.body.classList.remove('enter'); }, 1400);
  }
  var mo = new MutationObserver(check);
  mo.observe(app, { childList: true });
  mo.observe(nav, { childList: true, attributes: true, attributeFilter: ['class'] });
  check();
})();

// Email code field: digits only, and verify automatically once all 6 digits are entered.
document.addEventListener('input', function (e) {
  if (!e.target || e.target.id !== 'ao') return;
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) { var b = document.querySelector('[data-a="verify"]'); if (b) b.click(); }
});

// Landing page: gentle parallax tilt of the 3D cube following the pointer.
document.addEventListener('pointermove', function (e) {
  var t = document.querySelector('.l-tilt'); if (!t) return;
  var x = (e.clientX / window.innerWidth - .5), y = (e.clientY / window.innerHeight - .5);
  t.style.setProperty('--py', (-y * 16).toFixed(2) + 'deg'); t.style.setProperty('--px', (x * 22).toFixed(2) + 'deg');
});

// Show/hide password (eye icon) and digits-only reset code field.
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-eye]'); if (!b) return;
  var i = document.getElementById(b.getAttribute('data-eye')); if (!i) return;
  var show = i.type === 'password'; i.type = show ? 'text' : 'password';
  b.setAttribute('aria-pressed', show ? 'true' : 'false'); b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  i.focus();
});
document.addEventListener('input', function (e) {
  if (e.target && e.target.id === 'fo') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});
