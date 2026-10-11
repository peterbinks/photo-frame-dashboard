// Core shell: router, clock, idle/ambient, toasts, sheets, helpers.
(function () {
  'use strict';
  var D = window.DATA;
  var App = window.App = { state: D, views: {}, current: null, mode: 'day' };
  var $ = App.$ = function (s, r) { return (r || document).querySelector(s); };
  App.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ------------------------------------------------------------ events
  var handlers = {};
  App.on = function (e, fn) { (handlers[e] = handlers[e] || []).push(fn); };
  App.emit = function (e, a) { (handlers[e] || []).forEach(function (fn) { fn(a); }); };

  // ------------------------------------------------------------ time
  App.now = function () { return new Date(); };
  App.dayStart = function (d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  App.addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  App.sameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  // Display settings (Settings → Display; js/sync.js fills them from /api/config)
  App.display = { clock24: false, nightFrom: 22, nightTo: 6, idleMinutes: 2, slideSeconds: 15 };
  // Night screen hours, e.g. 22 → 6 wraps midnight; equal hours = never.
  App.isNight = function () {
    var d = App.display, h = App.now().getHours();
    if (d.nightFrom === d.nightTo) return false;
    return d.nightFrom < d.nightTo ? h >= d.nightFrom && h < d.nightTo : h >= d.nightFrom || h < d.nightTo;
  };
  function two(n) { return (n < 10 ? '0' : '') + n; }

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  App.fmt = {
    // "3:45 PM" ("3:45" with ampm === false) or "15:45" on a 24-hour clock
    time: function (d, ampm) {
      var h = d.getHours(), m = d.getMinutes();
      if (App.display.clock24) return two(h) + ':' + two(m);
      var s = (h % 12 || 12) + ':' + two(m);
      return ampm === false ? s : s + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    // "4 PM", "3:45 PM" / "16:00", "15:45"
    hour: function (d) {
      var h = d.getHours(), m = d.getMinutes();
      if (App.display.clock24) return two(h) + ':' + two(m);
      return (h % 12 || 12) + (m ? ':' + two(m) : '') + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    ampm: function (d) { return App.display.clock24 ? '' : d.getHours() >= 12 ? 'PM' : 'AM'; },
    range: function (a, b) {
      var same = App.fmt.ampm(a) === App.fmt.ampm(b);
      return (same ? App.fmt.time(a, false) : App.fmt.time(a)) + ' – ' + App.fmt.time(b);
    },
    day: function (d) { return DAYS[d.getDay()]; },
    dayShort: function (d) { return DAYS[d.getDay()].slice(0, 3); },
    month: function (d) { return MONTHS[d.getMonth()]; },
    monthShort: function (d) { return MON_SHORT[d.getMonth()]; },
    mins: function (m) {
      m = Math.max(0, Math.round(m));
      if (m < 60) return m + ' min';
      var h = Math.floor(m / 60), r = m % 60;
      return h + ' hr' + (r ? ' ' + r + ' min' : '');
    },
    rel: function (d) {
      var t = App.dayStart(App.now()), x = App.dayStart(d), diff = Math.round((x - t) / 864e5);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
      return DAYS[d.getDay()];
    }
  };
  App.esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ------------------------------------------------------------ icons + people
  App.icon = function (name, size, cls) {
    size = size || 24;
    return '<svg class="i ' + (cls || '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (window.ICONS[name] || '') + '</svg>';
  };
  App.person = function (id) {
    if (id === 'family' || id === 'any') return D.family;
    for (var i = 0; i < D.people.length; i++) if (D.people[i].id === id) return D.people[i];
    return D.family;
  };
  App.pstyle = function (p) {
    if (typeof p === 'string') p = App.person(p);
    return '--c:' + p.color + ';--c-rgb:' + p.rgb + ';--c-ink:' + p.ink;
  };
  App.avatar = function (p, size, cls) {
    if (typeof p === 'string') p = App.person(p);
    size = size || 48;
    return '<span class="avatar ' + (cls || '') + '" style="' + App.pstyle(p) + ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.46) + 'px">' + (p.id === 'family' ? '★' : p.name[0]) + '</span>';
  };
  App.dots = function (ids, size) {
    return '<span class="dots">' + ids.map(function (id) { return '<i style="' + App.pstyle(id) + (size ? ';width:' + size + 'px;height:' + size + 'px' : '') + '"></i>'; }).join('') + '</span>';
  };

  // ------------------------------------------------------------ calendar helpers
  App.events = function () { return D.events; };
  App.isFamily = function (e) { return e.people.length >= D.people.length; };
  // A calendar with its own colour (config) paints its events in it; otherwise the person's colour.
  App.evColor = function (e) {
    if (e.color && !App.isFamily(e)) return calColor(e.color);
    return App.isFamily(e) ? D.family : App.person(e.people[0]);
  };
  var calColors = {};
  function calColor(hex) {
    if (!calColors[hex]) {
      var n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      calColors[hex] = { id: 'cal', name: '', color: hex, rgb: r + ' ' + g + ' ' + b, ink: 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#111111' : '#FFFFFF' };
    }
    return calColors[hex];
  }
  App.timedOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return !ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    }).sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  };
  App.allDayOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    });
  };
  App.leaveBy = function (e) { return e.travel ? new Date(+e.start - e.travel * 60000) : e.start; };
  // The next thing someone needs to act on: earliest upcoming "leave by" today.
  App.nextEvent = function () {
    var now = App.now();
    var list = App.timedOn(now).filter(function (e) { return e.start > now; });
    list.sort(function (a, b) { return App.leaveBy(a) - App.leaveBy(b); });
    return list[0] || null;
  };
  App.findEvent = function (id) {
    return App.events().filter(function (e) { return e.id === id; })[0];
  };

  // ------------------------------------------------------------ chores + weather helpers
  App.currentRoutine = function () {
    var h = App.now().getHours();
    for (var i = 0; i < D.routines.length; i++) if (h >= D.routines[i].from && h < D.routines[i].to) return D.routines[i];
    return D.routines[D.routines.length - 1];
  };
  // Weather arrays start at local midnight of W.day and run 48 hours (24–47 = tomorrow).
  function wxIndex(W) {
    var n = App.now(), h = n.getHours();
    var d = W.day.split('-'), day = new Date(+d[0], +d[1] - 1, +d[2]);
    return h + Math.round((App.dayStart(n) - day) / 864e5) * 24;
  }
  var WX_LABELS = { sun: 'Sunny', moon: 'Clear', partly: 'Partly cloudy', cloud: 'Overcast', rain: 'Rain', snow: 'Snow', storm: 'Thunderstorms' };
  App.weatherNow = function () {
    var W = D.weather;
    if (!W || !W.t || !W.t.length) {
      var msg = D.status.weather.state === 'loading' ? 'Loading weather' : 'Weather unavailable';
      return { temp: '–', cond: 'cloud', label: msg, hi: '–', lo: '–', summary: msg, advice: 'Check back soon', hour: App.now().getHours(), none: true };
    }
    var i0 = Math.min(wxIndex(W), W.t.length - 1), h = App.now().getHours();
    var end = Math.min(W.t.length, i0 + (24 - h));
    var wetAt = -1;
    for (var i = i0; i < end; i++) if (W.p[i] >= 50) { wetAt = i; break; }
    var cool = W.units === 'fahrenheit' ? 54 : 12;
    var temp = W.now != null && i0 === wxIndex(W) ? W.now : W.t[i0];
    var cond = W.now != null && i0 === wxIndex(W) && W.cond ? W.cond : W.c[i0];
    var summary, advice;
    if (wetAt > -1) {
      var word = W.c[wetAt] === 'snow' ? 'Snow' : W.c[wetAt] === 'storm' ? 'Storms' : 'Rain';
      if (wetAt === i0) {
        var stop = i0; while (stop < end && W.p[stop] >= 50) stop++;
        summary = stop >= end ? word + ' all day' : word + ' until ' + App.fmt.hour(new Date(2000, 0, 1, stop % 24));
      } else summary = word + ' from ' + App.fmt.hour(new Date(2000, 0, 1, wetAt % 24));
      advice = word === 'Snow' ? 'Boots and a warm coat' : 'Grab a rain jacket';
    } else {
      summary = temp < cool ? 'Dry and cool' : 'Dry all day';
      advice = temp < cool ? 'Jacket weather' : 'Light layers';
    }
    return { temp: temp, cond: cond, label: WX_LABELS[cond] || '', hi: W.hi, lo: W.lo, summary: summary, advice: advice, hour: h };
  };
  App.hourly = function (count) {
    var W = D.weather, out = [];
    if (!W || !W.t || !W.t.length) return out;
    var i0 = wxIndex(W);
    for (var i = 0; i < count && i0 + i < W.t.length; i++) {
      var x = (i0 + i) % 24, j = i0 + i;
      out.push({ h: x, t: W.t[j], c: W.c[j], p: W.p[j], label: i === 0 ? 'Now' : App.display.clock24 ? two(x) : ((x % 12 || 12) + (x >= 12 ? 'p' : 'a')) });
    }
    return out;
  };

  // ------------------------------------------------------------ router
  App.register = function (name, view) { App.views[name] = view; };
  // Views are built once and kept laid out (hidden with content-visibility), so switching tabs
  // only has to paint. A view is rebuilt when its data changed ('data'/'time' events) or, for
  // time-sensitive views (minutely: true), when the minute has rolled over since it was built.
  function minuteKey() { return Math.floor(App.now().getTime() / 60000); }
  function build(name, opts) {
    var view = App.views[name];
    view.show($('#view-' + name), opts || {});
    view._built = true; view._dirty = false; view._min = minuteKey();
  }
  App.go = function (name, opts) {
    opts = opts || {};
    if (!App.views[name]) name = 'home';
    if (App.current && App.current !== name && App.views[App.current].hide) App.views[App.current].hide();
    App.$$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
    App.$$('.rail-item').forEach(function (b) { b.classList.toggle('is-active', b.dataset.go === name); });
    App.current = name;
    $('#stage').setAttribute('data-view', name);
    fit();
    var view = App.views[name];
    if (!view._built || view._dirty || opts.rerender || (view.minutely && view._min !== minuteKey())) build(name, opts);
    else if (view.resume) view.resume($('#view-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  };
  // Build a hidden view and lay it out now (cached by content-visibility; no paint happens).
  function prebuild(name) {
    var el = $('#view-' + name), view = App.views[name];
    build(name);
    if (view.hide) view.hide();
    el.classList.add('is-warming');
    el.offsetHeight;
    el.classList.remove('is-warming');
  }
  // Pre-build (startup) and re-build (after data changes) hidden views in the background, one per
  // slot, so navigating to them never pays the rebuild cost. Lazy views (Settings) build on visit.
  var refreshTimer = null;
  function refreshStale(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function next() {
      var name = Object.keys(App.views).filter(function (k) {
        var v = App.views[k];
        return k !== App.current && !v.lazy && (!v._built || v._dirty);
      })[0];
      if (!name) return;
      prebuild(name);
      refreshTimer = setTimeout(next, 400);
    }, delay);
  }
  function markStale() {
    Object.keys(App.views).forEach(function (k) { if (k !== App.current) App.views[k]._dirty = true; });
    refreshStale(1500);
  }
  App.on('data', markStale);
  App.on('time', markStale);
  App.rerender = function () {
    if (App.current) App.views[App.current].show($('#view-' + App.current), { rerender: true });
  };

  // ------------------------------------------------------------ toasts (single, with undo)
  var toastTimer;
  App.toast = function (html, opts) {
    opts = opts || {};
    var box = $('#toasts');
    box.innerHTML = '';
    clearTimeout(toastTimer);
    var ms = opts.ms || 5000;
    var t = document.createElement('div');
    t.className = 'toast' + (opts.tone ? ' toast--' + opts.tone : '');
    t.style.setProperty('--ms', ms + 'ms');
    t.innerHTML = (opts.icon ? App.icon(opts.icon, 26) : '') + '<span class="toast-msg">' + html + '</span>' +
      (opts.undo ? '<button class="toast-undo">' + App.icon('undo', 22) + 'Undo</button>' : '');
    box.appendChild(t);
    t.classList.add('is-in');
    function kill() { t.remove(); }
    toastTimer = setTimeout(kill, ms);
    if (opts.undo) t.querySelector('.toast-undo').addEventListener('click', function () { clearTimeout(toastTimer); opts.undo(); kill(); });
  };

  // ------------------------------------------------------------ sheets (modal cards)
  App.sheet = function (html, opts) {
    opts = opts || {};
    var layer = $('#sheetLayer');
    layer.innerHTML = '<div class="sheet-scrim"></div><div class="sheet ' + (opts.cls || '') + '">' +
      '<button class="sheet-x" data-close aria-label="Close">' + App.icon('x', 28) + '</button>' + html + '</div>';
    layer.classList.add('is-open');
    function close() {
      if (!layer.classList.contains('is-open')) return;
      layer.classList.remove('is-open');
      if (opts.onClose) opts.onClose();
      layer.innerHTML = '';
    }
    App.closeSheet = close;
    layer.querySelector('.sheet-scrim').addEventListener('click', close);
    App.$$('[data-close]', layer).forEach(function (b) { b.addEventListener('click', close); });
    if (opts.onMount) opts.onMount(layer.querySelector('.sheet'), close);
    return close;
  };
  App.closeSheet = function () {};

  // Stage-local coordinates for an element's center (stage may be scaled on desktop)
  App.centerOf = function (el) {
    var stage = $('#stage').getBoundingClientRect(), r = el.getBoundingClientRect(), k = stage.width / 1280;
    return { x: (r.left + r.width / 2 - stage.left) / k, y: (r.top + r.height / 2 - stage.top) / k };
  };

  // ------------------------------------------------------------ press-and-hold
  App.hold = function (el, ms, cb) {
    var t = null;
    el.style.setProperty('--hold', ms + 'ms');
    el.addEventListener('pointerdown', function () {
      if (cb.enabled && !cb.enabled()) return;
      el.classList.add('is-holding');
      t = setTimeout(function () { t = null; el.classList.remove('is-holding'); cb.done(); }, ms);
    });
    function cancel(e) {
      if (!t) return;
      clearTimeout(t); t = null;
      el.classList.remove('is-holding');
      if (cb.cancel && e.type === 'pointerup') cb.cancel();
    }
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
  };

  // ------------------------------------------------------------ modes: day / ambient / night
  App.setMode = function (m) {
    var stage = $('#stage');
    App.mode = m;
    stage.dataset.mode = m;
    App.emit('mode', m);
  };

  // ------------------------------------------------------------ idle
  // Back to Today after a minute; ambient slideshow (or the night clock) after Settings → Display
  // "idle" minutes (0 = never). Never while someone is typing.
  App.idle = { home: 60 };
  var idleSec = 0;
  function typing() { var a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
  function onIdleTick() {
    idleSec++;
    var blocked = $('#takeover').classList.contains('is-open') || typing();
    if (App.mode === 'nightdash' && idleSec >= 20) { App.setMode('night'); return; }
    if (App.mode !== 'day' || blocked) return;
    var ambient = App.display.idleMinutes * 60;
    if (idleSec === App.idle.home && App.current !== 'home') { App.closeSheet(); App.go('home'); }
    if (ambient && idleSec >= Math.max(ambient, App.idle.home)) {
      App.closeSheet();
      App.go('home');
      App.setMode(App.isNight() ? 'night' : 'ambient');
    }
  }
  App.resetIdle = function () { idleSec = 0; };

  // ------------------------------------------------------------ stage scaling
  // The fixed 1280×800 stage is scaled to fit (desktop preview, phones). On a phone the Settings
  // view instead fills the screen at its natural size (index.html switches phones to a
  // device-width viewport), so long links can be pasted and read.
  App.phone = document.documentElement.classList.contains('is-phone');
  function fit() {
    var s = Math.min(window.innerWidth / 1280, window.innerHeight / 800);
    var page = App.phone && App.current === 'settings';
    $('#stage').style.transform = page || Math.abs(s - 1) < 0.01 ? '' : 'scale(' + s + ')';
  }

  // ------------------------------------------------------------ clock tick
  var lastMin = -1, lastDay = -1;
  App.repaintClock = function () { lastMin = -1; };
  function tick() {
    var n = App.now();
    App.emit('second', n);
    if (n.getMinutes() !== lastMin) {
      lastMin = n.getMinutes();
      $('#railClock').innerHTML = '<b>' + App.fmt.time(n, false) + '</b><span>' + App.fmt.ampm(n) + '</span>';
      // Midnight: views jump to the new day (calendar, routine) before the minute repaint
      if (lastDay !== -1 && n.getDate() !== lastDay) { App.emit('time'); App.rerender(); }
      lastDay = n.getDate();
      App.emit('minute', n);
    }
    onIdleTick();
  }

  // ------------------------------------------------------------ boot
  App.start = function () {
    // Switch tabs the instant a finger lands (pointerdown), not on release. Keyboard "clicks"
    // (detail === 0) still work.
    $('#rail').addEventListener('pointerdown', function (e) {
      var b = e.target.closest('[data-go]');
      if (b && e.button === 0) App.go(b.dataset.go);
    });
    $('#rail').addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]');
      if (b && e.detail === 0) App.go(b.dataset.go);
    });
    document.addEventListener('pointerdown', App.resetIdle, true);
    document.addEventListener('keydown', App.resetIdle, true);
    window.addEventListener('hashchange', function () { App.go(location.hash.slice(1)); });
    App.go(location.hash.slice(1) || 'home');
    tick();
    setInterval(tick, 1000);
    App.emit('ready');
    refreshStale(1500);
  };
  document.addEventListener('DOMContentLoaded', function () {
    fit();
    window.addEventListener('resize', fit);
    App.boot().then(App.start);
  });
})();
