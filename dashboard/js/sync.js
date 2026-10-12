// Loads everything from the Worker and keeps it fresh:
//   config + shared state before the app starts, then calendar (5 min), weather (15 min),
//   photos (30 min) and state (60 s + on focus). State edits are saved after every change.
// Settings changes (this screen or another) arrive through the state poll's settingsRev and are
// applied without a reload. App.sync.refresh() forces a source past the Worker caches.
(function () {
  'use strict';
  var D = window.DATA;
  var FIELDS = ['routines', 'chores', 'stars', 'week', 'stores', 'catOrder', 'groceries', 'catalog', 'usuals', 'events', 'favs'];
  var MIN = 60000;

  // ------------------------------------------------------------ fetch
  function Unauthorized() {}
  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({ Accept: 'application/json' }, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { gate(); throw new Unauthorized(); }
      return res.json().catch(function () { return {}; }).then(function (body) {
        return { status: res.status, ok: res.ok, body: body, etag: res.headers.get('ETag'), fresh: res.headers.get('X-Fresh') };
      });
    });
  }

  // Full-screen notice when the access cookie is missing (open the link with ?k=… once).
  var gated = false;
  function gate() {
    if (gated) return;
    gated = true;
    var el = document.createElement('div');
    el.className = 'gate';
    el.innerHTML = '<div class="gate-card"><div class="label">Home HQ</div><h1 class="display">Not authorized</h1>' +
      '<p>Open the dashboard link that ends in <b>?k=&lt;access key&gt;</b> once on this device.<br>' +
      'Run <b>npm run setup</b> on your computer to see the link again.</p></div>';
    document.getElementById('stage').appendChild(el);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function key(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateOf(k) { return new Date(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
  function retryIn(fn, ms) { setTimeout(fn, ms); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  // ------------------------------------------------------------ per-source sync status (Settings → Sync)
  var SOURCES = ['calendar', 'photos', 'weather', 'state'];
  var status = {};
  SOURCES.forEach(function (s) { status[s] = { lastOk: 0, lastError: null, loading: false }; });
  function begin(src) { status[src].loading = true; App.emit('sync', src); }
  function ok(src) { var s = status[src]; s.loading = false; s.lastOk = Date.now(); s.lastError = null; App.emit('sync', src); }
  function failed(src, msg) { var s = status[src]; s.loading = false; s.lastError = msg; App.emit('sync', src); }
  function errMsg(e) { return e instanceof Unauthorized ? 'Not authorized' : String((e && e.message) || e || 'Failed'); }

  // ------------------------------------------------------------ config
  // Re-runnable: family, colours, display settings and calendar names can change while running.
  function applyConfig(cfg) {
    var prev = {};
    D.people.forEach(function (p) { prev[p.id] = p; });
    D.config = cfg;
    D.people.length = 0;
    (cfg.family || []).forEach(function (m) {
      var old = prev[m.id];
      D.people.push(Object.assign({ home: old ? old.home : null, status: old ? old.status : '' }, m));
    });
    // Per-person columns (calendar lanes, home lanes, chores) follow the family size
    var stage = document.getElementById('stage');
    stage.style.setProperty('--people', Math.max(1, D.people.length));
    stage.style.setProperty('--lanes', D.people.length + 1);
    D.ALL = D.people.map(function (p) { return p.id; });
    if (cfg.display) Object.assign(App.display, cfg.display);
    if (App.repaintClock) App.repaintClock();
  }

  // Another screen (or Settings here) saved settings: fetch the new config, apply it, and refetch
  // only what it affects.
  var configLoading = null;
  function reloadConfig() {
    if (configLoading) return configLoading;
    configLoading = api('/api/config').then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      var old = D.config || {}, cfg = r.body;
      applyConfig(cfg);
      var famIds = function (c) { return (c.family || []).map(function (m) { return m.id; }); };
      if (!same(old.calendars, cfg.calendars) || !same(famIds(old), famIds(cfg))) loadCalendar();
      if (!same(old.location, cfg.location) || old.units !== cfg.units) loadWeather();
      if (!same(old.albumIds, cfg.albumIds)) loadPhotos();
      if (!same(famIds(old), famIds(cfg))) pullState(true);
      App.emit('config', { old: old, cfg: cfg });
      App.emit('data');
      if (App.current) rerenderIf(App.current);
    }).catch(function (e) {
      if (!(e instanceof Unauthorized)) retryIn(function () { checkSettingsRev(-1); }, 30000);
    }).then(function () { configLoading = null; });
    return configLoading;
  }
  function checkSettingsRev(r) {
    if (D.config && typeof r === 'number' && r !== D.config.settingsRev) reloadConfig();
  }
  // "Reload all screens": the first value seen is this page's baseline; a newer one reloads it.
  var reloadBase = null;
  function checkReload(at) {
    if (typeof at !== 'number') return;
    if (reloadBase === null) { reloadBase = at; return; }
    if (at > reloadBase && App.version) { reloadBase = at; App.version.remoteReload(); }
  }

  // ------------------------------------------------------------ calendar
  function rebuildEvents() {
    var local = (D.localEvents || []).map(function (e) {
      return { id: e.id, title: e.title, people: e.people || [], start: new Date(e.start), end: new Date(e.end), local: true };
    });
    D.events = (D._calEvents || []).concat(local);
  }
  App.rebuildEvents = rebuildEvents;

  // The Worker sends the (trimmed) feeds; parsing + RRULE expansion runs here, in a Web Worker so
  // the frame's slow CPU never freezes the UI. Unchanged feeds come back as 304 and are skipped.
  var cal = { etag: null, query: null, worker: null, seq: 0, run: 0 };
  function expandFeeds(msg) {
    function inline() { return import('../src/calendar.js').then(function (m) { return m.expandFeeds(msg); }); }
    if (cal.worker === null) {
      try { cal.worker = new Worker(new URL('./calendar-worker.js', import.meta.url), { type: 'module' }); } catch (e) { cal.worker = false; }
    }
    if (!cal.worker) return inline();
    var w = cal.worker, id = ++cal.seq;
    return new Promise(function (resolve) {
      function done(e) { w.removeEventListener('message', onMsg); w.removeEventListener('error', onErr); resolve(e); }
      function onMsg(e) { if (e.data.id === id) done(e.data); }
      function onErr(e) { e.preventDefault(); w.terminate(); cal.worker = false; done(inline()); }
      w.addEventListener('message', onMsg);
      w.addEventListener('error', onErr);
      w.postMessage({ id: id, calendars: msg.calendars, win: msg.win, order: msg.order });
    });
  }

  // Per-calendar results for Settings: [{id, name, events, error}]
  D.calStats = [];
  function loadCalendar(fresh) {
    var today = App.dayStart(new Date()), run = ++cal.run;
    var q = '?from=' + key(App.addDays(today, -35)) + '&to=' + key(App.addDays(today, 120));
    var headers = q === cal.query && cal.etag ? { 'If-None-Match': cal.etag } : {};
    begin('calendar');
    return api('/api/calendar' + q + (fresh ? '&fresh=1' : ''), { headers: headers }).then(function (r) {
      if (r.status === 304) { ok('calendar'); return; }
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      var b = r.body, cals = b.calendars || [];
      return expandFeeds({ calendars: cals, win: { from: b.from, to: b.to, tz: b.tz }, order: D.ALL }).then(function (res) {
        if (run !== cal.run) return; // a newer load is in flight
        D._calEvents = res.events.map(function (e) {
          var x = Object.assign({}, e);
          if (e.allDay) { x.start = dateOf(e.start); x.end = dateOf(e.end); }
          else { x.start = new Date(e.start); x.end = new Date(e.end); }
          return x;
        });
        rebuildEvents();
        cal.etag = r.etag; cal.query = q;
        var counts = cals.map(function () { return 0; });
        res.events.forEach(function (e) { if (e.cal != null) counts[e.cal]++; });
        D.calStats = cals.map(function (c, i) { return { id: c.id, name: c.name, events: counts[i], error: res.errors[i] }; });
        var bad = D.calStats.filter(function (c) { return c.error; });
        D.status.calendar = !b.configured ? { state: 'empty', message: 'No calendars yet' }
          : bad.length === cals.length ? { state: 'error', message: 'Couldn’t load ' + bad.map(function (c) { return c.name; }).join(', ') }
          : { state: 'ok', failed: bad };
        if (b.configured && bad.length === cals.length) failed('calendar', bad[0].error); else ok('calendar');
        App.emit('data');
        rerenderIf('calendar');
      });
    }).catch(function (e) {
      if (e instanceof Unauthorized) return;
      failed('calendar', errMsg(e));
      if (D.status.calendar.state === 'ok') return; // keep showing what we have; retry next tick
      D.status.calendar = { state: 'error', message: 'Calendar unavailable' };
      App.emit('data');
      rerenderIf('calendar');
    });
  }
  // The visible view isn't rebuilt on 'data' (hidden ones are). Refresh it now, or once the person
  // using it is done (input blurred / sheet closed) so typing and open sheets aren't disturbed.
  var deferred = false;
  function rerenderIf(name) {
    if (App.current !== name) return;
    if (document.querySelector('.sheet-layer.is-open') || (document.activeElement && document.activeElement.tagName === 'INPUT')) { deferred = true; return; }
    deferred = false;
    App.rerender();
  }
  function flushDeferred() { if (deferred) setTimeout(function () { rerenderIf(App.current); }, 300); }
  document.addEventListener('focusout', flushDeferred);
  document.addEventListener('pointerup', flushDeferred);

  // ------------------------------------------------------------ weather
  function loadWeather(fresh) {
    begin('weather');
    return api('/api/weather' + (fresh ? '?fresh=1' : '')).then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      D.weather = r.body;
      D.status.weather = { state: 'ok' };
      ok('weather');
      App.emit('data');
    }).catch(function (e) {
      if (e instanceof Unauthorized) return;
      D.status.weather = { state: 'error', message: errMsg(e) };
      failed('weather', errMsg(e));
      App.emit('data');
    });
  }

  // ------------------------------------------------------------ photos
  function applyFavs() {
    D.photos.forEach(function (p) { p.fav = D.favs.indexOf(p.id) > -1; });
  }
  App.toggleFav = function (p) {
    var i = D.favs.indexOf(p.id);
    if (i > -1) D.favs.splice(i, 1); else D.favs.push(p.id);
    p.fav = i < 0;
    App.emit('data');
  };
  // Per-album results for Settings: [{id, name, count, ok, error}]
  D.albumStats = [];
  function loadPhotos(fresh) {
    begin('photos');
    return api('/api/photos' + (fresh ? '?fresh=1' : '')).then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      var b = r.body, bad = (b.albums || []).filter(function (a) { return !a.ok; });
      D.photos = b.photos || [];
      D.albumStats = b.albums || [];
      applyFavs();
      D.status.photos = !b.configured ? { state: 'empty', message: 'No iCloud album yet' }
        : !D.photos.length ? { state: bad.length ? 'error' : 'empty', message: bad.length ? bad[0].error : 'The shared album has no photos yet' }
        : { state: 'ok' };
      if (b.configured && bad.length === b.albums.length) failed('photos', bad[0].error); else ok('photos');
      App.emit('photos');
      App.emit('data');
    }).catch(function (e) {
      if (e instanceof Unauthorized) return;
      if (!D.photos.length) D.status.photos = { state: 'error', message: 'Photos unavailable' };
      failed('photos', errMsg(e));
      App.emit('data');
    });
  }

  // ------------------------------------------------------------ shared state
  var rev = 0, baseStr = '', baseObj = null, saving = false, again = false, saveTimer = null, lastTouch = 0;

  function fieldsOf(doc) {
    var o = {};
    FIELDS.forEach(function (f) { o[f] = doc[f]; });
    return o;
  }
  function serialize() {
    var o = {};
    FIELDS.forEach(function (f) { o[f] = f === 'events' ? D.localEvents : D[f]; });
    return o;
  }
  function setBase(doc) {
    rev = doc.rev;
    baseObj = JSON.parse(JSON.stringify(fieldsOf(doc)));
    baseStr = JSON.stringify(baseObj);
  }
  function applyDoc(fields) {
    FIELDS.forEach(function (f) {
      if (fields[f] === undefined) return;
      var v = JSON.parse(JSON.stringify(fields[f]));
      if (f === 'events') D.localEvents = v; else D[f] = v;
    });
    if (!D.catOrder.all) D.catOrder.all = [];
    rebuildEvents();
    applyFavs();
  }

  // Three-way merge for a save that raced another device: keep every change made here since the
  // last sync, take the server's version of everything else. Lists of {id} merge per item.
  function byId(list) { var m = {}; (list || []).forEach(function (x) { if (x && x.id != null) m[x.id] = x; }); return m; }
  function isIdList(v) { return Array.isArray(v) && v.length > 0 && v.every(function (x) { return x && typeof x === 'object' && x.id != null; }); }
  function mergeValue(base, local, server) {
    if (same(local, base)) return server;
    if (same(server, base)) return local;
    if ((isIdList(local) || isIdList(base)) && Array.isArray(server)) {
      var b = byId(base), l = byId(local), out = [];
      server.forEach(function (s) {
        if (b[s.id] && !l[s.id]) return; // deleted here
        out.push(l[s.id] && !same(l[s.id], b[s.id]) ? l[s.id] : s);
      });
      (local || []).forEach(function (x) { if (!b[x.id] && !out.some(function (o) { return o.id === x.id; })) out.push(x); });
      return out;
    }
    if (local && server && typeof local === 'object' && !Array.isArray(local) && typeof server === 'object') {
      var o = Object.assign({}, server);
      Object.keys(Object.assign({}, base, local)).forEach(function (k) {
        if (!same((local || {})[k], (base || {})[k])) { if (local[k] === undefined) delete o[k]; else o[k] = local[k]; }
      });
      return o;
    }
    return local;
  }
  function merge(base, local, server) {
    var o = {};
    FIELDS.forEach(function (f) { o[f] = mergeValue(base[f], local[f], server[f]); });
    return o;
  }

  function remoteChanged() {
    App.emit('data');
    if (App.current && App.current !== 'photos') rerenderIf(App.current);
  }

  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
  function save() {
    if (!baseObj) return;
    var cur = serialize(), str = JSON.stringify(cur);
    if (str === baseStr) return;
    if (saving) { again = true; return; }
    saving = true;
    api('/api/state', { method: 'PUT', body: JSON.stringify(Object.assign({ rev: rev }, cur)) }).then(function (r) {
      if (r.ok) {
        var mine = JSON.stringify(serialize());
        setBase(r.body);
        if (mine === str && JSON.stringify(fieldsOf(r.body)) !== str) { applyDoc(fieldsOf(r.body)); remoteChanged(); }
        ok('state');
        checkSettingsRev(r.body.settingsRev);
        checkReload(r.body.reloadAt);
      } else if (r.status === 409 && r.body.state) {
        var server = r.body.state, merged = merge(baseObj, serialize(), fieldsOf(server));
        setBase(server);
        applyDoc(merged);
        remoteChanged();
        again = true;
        checkSettingsRev(server.settingsRev);
        checkReload(server.reloadAt);
      } else {
        throw new Error(r.body.error || 'HTTP ' + r.status);
      }
    }).catch(function (e) {
      if (e instanceof Unauthorized) return;
      failed('state', 'Couldn’t save: ' + errMsg(e));
      App.toast('Couldn’t save — will retry', { tone: 'error', icon: 'bolt', ms: 3000 });
      retryIn(scheduleSave, 15000);
    }).then(function () {
      saving = false;
      if (again) { again = false; scheduleSave(); }
    });
  }

  function loadState() {
    return api('/api/state').then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      setBase(r.body);
      applyDoc(fieldsOf(r.body));
      ok('state');
      checkReload(r.body.reloadAt);
    });
  }
  // Pull edits made on other devices. Local edits in flight go through save() (which merges).
  // `force` (Refresh button, settings change) skips the "someone is touching the screen" wait.
  function pullState(force) {
    if (!baseObj || gated) return Promise.resolve();
    if (saving || JSON.stringify(serialize()) !== baseStr) { scheduleSave(); return Promise.resolve(); }
    if (!force && Date.now() - lastTouch < 4000) { retryIn(pullState, 5000); return Promise.resolve(); }
    begin('state');
    return api('/api/state').then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      ok('state');
      checkSettingsRev(r.body.settingsRev);
      checkReload(r.body.reloadAt);
      if (r.body.rev === rev || saving || JSON.stringify(serialize()) !== baseStr) return;
      setBase(r.body);
      applyDoc(fieldsOf(r.body));
      remoteChanged();
    }).catch(function (e) {
      if (!(e instanceof Unauthorized)) failed('state', errMsg(e)); // offline: try again next tick
    });
  }
  function refreshState() { pullState(false); }

  // ------------------------------------------------------------ public
  var LOADERS = { calendar: loadCalendar, photos: loadPhotos, weather: loadWeather, state: function () { return pullState(true); } };
  App.sync = {
    api: api,
    Unauthorized: Unauthorized,
    status: status,
    /** Force a source ('calendar' | 'photos' | 'weather' | 'state' | 'all') past the Worker caches. */
    refresh: function (src) {
      if (src === 'all') return Promise.all(SOURCES.map(function (s) { return LOADERS[s](true); }));
      return LOADERS[src] ? LOADERS[src](true) : Promise.reject(new Error('unknown source ' + src));
    },
    reloadConfig: reloadConfig
  };

  // ------------------------------------------------------------ boot
  // Config + state must be there before the first render; everything else streams in.
  App.boot = function () {
    return new Promise(function (resolve) {
      var tries = 0;
      (function attempt() {
        api('/api/config').then(function (r) {
          if (!r.ok) throw new Error('config ' + r.status);
          applyConfig(r.body);
          return loadState();
        }).then(resolve).catch(function (e) {
          if (e instanceof Unauthorized) return;
          tries++;
          var s = document.getElementById('stage');
          s.setAttribute('data-booting', tries > 1 ? 'Can’t reach the dashboard server — retrying…' : 'Loading…');
          retryIn(attempt, Math.min(30000, 2000 * tries));
        });
      })();
    }).then(function () { document.getElementById('stage').removeAttribute('data-booting'); });
  };

  App.on('ready', function () {
    App.on('data', scheduleSave);
    document.addEventListener('pointerdown', function () { lastTouch = Date.now(); }, true);
    loadCalendar(); loadWeather(); loadPhotos();
    setInterval(loadCalendar, 5 * MIN);
    setInterval(loadWeather, 15 * MIN);
    setInterval(loadPhotos, 30 * MIN);
    setInterval(refreshState, MIN);
    window.addEventListener('focus', refreshState);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { refreshState(); } });
    if (!D.people.length || !(D.config.calendars || []).length || !D.config.albums) {
      var missing = [!D.people.length && 'family', !(D.config.calendars || []).length && 'calendars', !D.config.albums && 'photo albums'].filter(Boolean);
      App.banner({ tone: 'ink', icon: 'bolt', title: 'Finish setting up Home HQ', sub: 'Not added yet: ' + missing.join(', '), action: 'Settings', onAction: function () { App.go('settings'); }, dismiss: 'Later', ms: 30000 });
    }
  });
  // New day: the Worker un-ticks chores and records the week strip; pull that and fresh events.
  App.on('time', function () { refreshState(); loadCalendar(); loadWeather(); });
})();
