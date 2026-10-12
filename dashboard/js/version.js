// App version auto-reload: every 5 minutes ask the Worker which build is deployed (/api/version);
// when it differs from this page's <meta name="hq-build">, reload at a quiet moment
// (js/reload-policy.js). Ambient/night mode survives the reload so the screen doesn't light up.
import { reloadDecision } from './reload-policy.js';

(function () {
  'use strict';
  var RESUME = 'hq-resume-mode';
  var meta = document.querySelector('meta[name="hq-build"]');
  var lastTouch = Date.now();
  var V = App.version = { current: meta ? meta.content : 'dev', latest: null, checked: 0 };

  function touched() { lastTouch = Date.now(); }
  document.addEventListener('pointerdown', touched, true);
  document.addEventListener('keydown', touched, true);

  V.check = function () {
    return App.sync.api('/api/version').then(function (r) {
      if (!r.ok || typeof r.body.version !== 'string') return;
      V.latest = r.body.version;
      V.checked = Date.now();
      App.emit('version');
    }).catch(function () { /* offline: next time */ });
  };
  V.decision = function () {
    var a = document.activeElement;
    return reloadDecision({
      current: V.current, latest: V.latest, now: Date.now(), lastTouch: lastTouch,
      sheetOpen: !!document.querySelector('.sheet-layer.is-open'),
      typing: !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'),
      haLogin: !!(App.ha && App.ha.loggingIn()),
      takeover: App.$('#takeover').classList.contains('is-open')
    });
  };
  V.reload = function () {
    try { if (App.mode === 'ambient' || App.mode === 'night') sessionStorage.setItem(RESUME, App.mode); } catch (e) { /* storage off */ }
    location.reload();
  };
  // Asked for from another screen: reload now, unless someone is typing or mid Home Assistant login.
  V.remoteReload = function () {
    var a = document.activeElement;
    var busy = (App.ha && App.ha.loggingIn()) || (!!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
    if (busy) { setTimeout(V.remoteReload, 15000); return; }
    V.reload();
  };
  // Ask every screen (including this one) to reload.
  V.reloadAll = function () {
    return App.sync.api('/api/reload', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
      return r.body.reloadAt;
    });
  };

  App.on('ready', function () {
    var mode = null;
    try { mode = sessionStorage.getItem(RESUME); sessionStorage.removeItem(RESUME); } catch (e) { /* storage off */ }
    if (mode === 'ambient' || mode === 'night') App.setMode(mode);
    setTimeout(V.check, 30000);
    setInterval(V.check, 5 * 60000);
    setInterval(function () { if (V.decision() === 'reload') V.reload(); }, 15000);
  });
})();
