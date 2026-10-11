// Settings: sync status, family, calendars, photo albums, display, Home Assistant, about.
// Reads and writes the household settings document (GET/PUT /api/settings). Every save is a
// function of the document it was based on, so a save that raced another screen (409) is re-applied
// to the newer copy instead of overwriting it.
import { PALETTE, LIMITS, cleanCalendarUrl, cleanAlbumUrl, cleanHaUrl } from '../../src/settings.js';

(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, tab: 'sync', doc: null, loading: null, error: null, paintTimer: null };
  var TABS = [
    ['sync', 'refresh', 'Sync'], ['family', 'person', 'Family'], ['calendars', 'calendar', 'Calendars'],
    ['photos', 'photo', 'Photo albums'], ['display', 'sun', 'Display'], ['ha', 'sliders', 'Home Assistant'], ['about', 'bell', 'About']
  ];
  var SOURCES = [['calendar', 'Calendar'], ['photos', 'Photos'], ['weather', 'Weather'], ['state', 'Chores & shopping']];
  var esc = App.esc;
  var LINK_ATTRS = ' type="url" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"';

  // ------------------------------------------------------------ helpers
  function ago(t) {
    if (!t) return 'not yet';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' hr ago' : Math.round(h / 24) + ' days ago';
  }
  function hourLabel(h) { return App.fmt.hour(new Date(2000, 0, 1, h)); }
  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function errOf(e) { return String((e && e.message) || e || 'Something went wrong'); }
  function personName(id) { var p = find(V.doc ? V.doc.family : [], id); return p ? p.name : id; }
  function whoText(people) {
    if (!people.length) return 'Everyone';
    return people.map(personName).join(', ');
  }
  function swatch(color) {
    return '<span class="st-swatch" style="background:' + esc(color) + '"></span>';
  }
  function btn(attrs, label, cls) { return '<button class="btn ' + (cls || 'btn--ghost') + '" ' + attrs + '>' + label + '</button>'; }
  function seg(name, options, value) {
    return '<div class="seg">' + options.map(function (o) {
      return '<button class="' + (o[0] === value ? 'is-on' : '') + '" data-' + name + '="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function chips(name, options, value) {
    return '<div class="chips">' + options.map(function (o) {
      return '<button class="chip' + (o[0] === value ? ' is-on' : '') + '" data-' + name + '="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function palette(value, allowNone) {
    return '<div class="st-palette">' + (allowNone ? '<button class="st-color st-color--none' + (value == null ? ' is-on' : '') + '" data-color="">Person colours</button>' : '') +
      PALETTE.map(function (c) {
        return '<button class="st-color' + (c === value ? ' is-on' : '') + '" data-color="' + c + '" style="--c:' + c + '" aria-label="Colour ' + c + '"></button>';
      }).join('') + '</div>';
  }
  function whoPicker(people) {
    var all = !people.length;
    return '<div class="add-who st-who">' + D.people.map(function (p) {
      return '<button class="who-btn' + (!all && people.indexOf(p.id) > -1 ? ' is-on' : '') + '" data-who="' + p.id + '" style="' + App.pstyle(p) + '">' + App.avatar(p, 48) + '<span>' + esc(p.name) + '</span></button>';
    }).join('') + '<button class="who-btn' + (all ? ' is-on' : '') + '" data-who="" style="' + App.pstyle(D.family) + '">' + App.avatar(D.family, 48) + '<span>Everyone</span></button></div>';
  }
  // Toggle a person in a whose list ('' = everyone); [] means everyone.
  function toggleWho(people, id) {
    if (!id) return [];
    var list = people.length ? people.slice() : [];
    var i = list.indexOf(id);
    if (i > -1) list.splice(i, 1); else list.push(id);
    return list.length === D.people.length ? [] : list;
  }
  function paintWho(s, people) {
    App.$$('[data-who]', s).forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.who ? people.indexOf(b.dataset.who) > -1 : !people.length);
    });
  }

  // ------------------------------------------------------------ load + save
  function load() {
    if (V.loading) return V.loading;
    V.loading = App.sync.api('/api/settings').then(function (r) {
      if (!r.ok) throw new Error(r.body.error || 'HTTP ' + r.status);
      V.doc = r.body;
      V.error = null;
    }).catch(function (e) {
      if (!(e instanceof App.sync.Unauthorized)) V.error = 'Couldn’t load settings: ' + errOf(e);
    }).then(function () { V.loading = null; paint(); });
    return V.loading;
  }

  /**
   * mutate(copyOfDoc) → the fields to PUT (computed from that copy), or null if the change no longer
   * applies. On 409 it runs again on the newer document. Resolves true when saved.
   */
  function save(mutate, msg) {
    if (!V.doc) return Promise.reject(new Error('Settings are still loading'));
    function attempt(doc, merged) {
      var patch = mutate(JSON.parse(JSON.stringify(doc)));
      if (!patch) {
        App.toast('That was changed on another screen — nothing saved', { icon: 'bolt' });
        paint();
        return Promise.resolve(false);
      }
      return App.sync.api('/api/settings', { method: 'PUT', body: JSON.stringify(Object.assign({ rev: doc.rev }, patch)) }).then(function (r) {
        if (r.ok) {
          V.doc = r.body;
          paint();
          App.sync.reloadConfig();
          App.toast(merged ? msg + ' · merged with a change from another screen' : msg, { icon: 'check', ms: 3000 });
          return true;
        }
        if (r.status === 409 && r.body.settings && !merged) { V.doc = r.body.settings; return attempt(V.doc, true); }
        if (r.status === 409) throw new Error('Settings keep changing on another screen — try again');
        throw new Error(r.body.error || 'HTTP ' + r.status);
      });
    }
    return attempt(V.doc, false);
  }
  function saveQuietly(mutate, msg) {
    return save(mutate, msg).catch(function (e) {
      if (!(e instanceof App.sync.Unauthorized)) App.toast(esc(errOf(e)), { tone: 'error', icon: 'bolt' });
      return false;
    });
  }

  function check(kind, value) {
    return App.sync.api('/api/settings/check', { method: 'POST', body: JSON.stringify({ kind: kind, value: value }) }).then(function (r) {
      if (!r.body || !r.body.ok) throw new Error((r.body && r.body.error) || 'HTTP ' + r.status);
      return r.body;
    });
  }

  // ------------------------------------------------------------ sections
  // "National Weather Service · KORD" (with the observing station) or "Open-Meteo"
  function weatherSource(W) {
    if (W.source === 'nws') return 'National Weather Service' + (W.station ? ' · ' + esc(W.station) : '');
    return W.source === 'open-meteo' ? 'Open-Meteo' : esc(W.source);
  }
  function syncSection() {
    var st = App.sync.status, v = App.version;
    var rows = SOURCES.map(function (s) {
      var x = st[s[0]], tone = x.loading ? 'busy' : x.lastError ? 'bad' : x.lastOk ? 'ok' : 'idle';
      var sub = x.lastError
        ? '<span class="st-bad">' + esc(x.lastError) + '</span>' + (x.lastOk ? ' · last good ' + ago(x.lastOk) : '')
        : x.lastOk ? 'Updated ' + ago(x.lastOk) : x.loading ? 'Loading…' : 'Not loaded yet';
      if (s[0] === 'weather' && D.weather && D.weather.source) sub += ' · ' + weatherSource(D.weather);
      return '<div class="st-row"><i class="st-dot st-dot--' + tone + '"></i><div class="st-main"><b>' + s[1] + '</b><small>' + sub + '</small></div>' +
        '<button class="icon-btn st-refresh' + (x.loading ? ' is-busy' : '') + '" data-refresh="' + s[0] + '" aria-label="Refresh ' + s[1] + '">' + App.icon('refresh', 26) + '</button></div>';
    }).join('');
    var any = SOURCES.some(function (s) { return st[s[0]].loading; });
    var newer = v.latest && v.latest !== v.current;
    return head('Sync', 'Screens refresh on their own: calendar every 5 min, weather 15, photos 30, chores and shopping every minute.') +
      '<div class="card st-list">' + rows + '</div>' +
      '<div class="st-actions">' + btn('data-refresh="all"' + (any ? ' disabled' : ''), App.icon('refresh', 22) + 'Refresh everything', 'btn--solid') +
      btn('data-reload', 'Reload app') + '</div>' +
      '<p class="st-note">Version <b>' + esc(v.current) + '</b>' + (newer ? ' · a new version is ready and loads when the screen is idle' : v.checked ? ' · up to date' : '') + '</p>';
  }

  function familySection() {
    var fam = V.doc.family;
    var rows = fam.map(function (m) {
      var look = { id: m.id, name: m.name, color: m.color, rgb: hexRgb(m.color), ink: inkOf(m.color) };
      return '<button class="st-row st-row--tap" data-member="' + m.id + '">' + App.avatar(look, 52) +
        '<div class="st-main"><b>' + esc(m.name) + '</b><small>' + (m.kid ? 'Kid · earns stars' : 'Grown-up') + '</small></div>' +
        swatch(m.color) + App.icon('edit', 24, 'st-chev') + '</button>';
    }).join('');
    return head('Family', 'Everyone gets a lane on Today, the calendar and chores. Renaming keeps their chores and stars.') +
      '<div class="card st-list">' + (rows || '<div class="st-empty serif"><i>No one yet</i></div>') + '</div>' +
      '<div class="st-actions">' + btn('data-add-member' + (fam.length >= LIMITS.members ? ' disabled' : ''), App.icon('plus', 22) + 'Add person', 'btn--solid') +
      (fam.length >= LIMITS.members ? '<span class="st-note">' + LIMITS.members + ' people fit on the screen</span>' : '') + '</div>';
  }

  function calendarsSection() {
    var cals = V.doc.calendars;
    var rows = cals.map(function (c) {
      var stat = find(D.calStats || [], c.id);
      var sub = stat && stat.error ? '<span class="st-bad">' + esc(stat.error) + '</span>' : esc(whoText(c.people)) + (stat ? ' · ' + stat.events + ' events' : '');
      return '<button class="st-row st-row--tap" data-cal="' + c.id + '">' +
        (c.color ? swatch(c.color) : App.dots(c.people.length ? c.people : D.ALL, 14)) +
        '<div class="st-main"><b>' + esc(c.name) + '</b><small>' + sub + '</small></div>' + App.icon('edit', 24, 'st-chev') + '</button>';
    }).join('');
    return head('Calendars', 'Google Calendar on a computer: ⚙ Settings → click the calendar → Integrate calendar → copy “Secret address in iCal format”.') +
      '<div class="card st-list">' + (rows || '<div class="st-empty serif"><i>No calendars yet</i></div>') + '</div>' +
      '<div class="st-actions">' + btn('data-add-cal' + (cals.length >= LIMITS.calendars ? ' disabled' : ''), App.icon('plus', 22) + 'Add calendar', 'btn--solid') + '</div>';
  }

  function photosSection() {
    var albums = V.doc.albums;
    var rows = albums.map(function (a) {
      var stat = find(D.albumStats || [], a.id);
      var name = (stat && stat.name) || a.name || 'Shared album';
      var sub = stat ? (stat.ok ? stat.count + ' photos' + (stat.partial ? ' (first part)' : '') : '<span class="st-bad">' + esc(stat.error || 'Unavailable') + '</span>') : 'Loading…';
      return '<div class="st-row">' + App.icon('photo', 30, 'st-ico') + '<div class="st-main"><b>' + esc(name) + '</b><small>' + sub + '</small></div>' +
        '<button class="icon-btn" data-del-album="' + a.id + '" aria-label="Remove ' + esc(name) + '">' + App.icon('trash', 24) + '</button></div>';
    }).join('');
    return head('Photo albums', 'In Photos on iPhone: open the shared album → People → turn on “Public Website” → Share Link.') +
      '<div class="card st-list">' + (rows || '<div class="st-empty serif"><i>No albums yet</i></div>') + '</div>' +
      '<div class="st-actions">' + btn('data-add-album' + (albums.length >= LIMITS.albums ? ' disabled' : ''), App.icon('plus', 22) + 'Add album', 'btn--solid') + '</div>';
  }

  function displaySection() {
    var d = V.doc, nightOn = d.nightFrom !== d.nightTo, loc = d.location, cfgLoc = (D.config && D.config.location) || {};
    return head('Display', '') +
      '<div class="card st-form">' +
      field('Temperature', seg('units', [['fahrenheit', '°F'], ['celsius', '°C']], d.units)) +
      field('Clock', seg('clock', [['12', '12-hour'], ['24', '24-hour']], d.clock24 ? '24' : '12')) +
      field('Night clock', seg('night', [['on', 'On'], ['off', 'Off']], nightOn ? 'on' : 'off') +
        (nightOn ? '<div class="st-steppers">' + stepper('nightFrom', 'From', d.nightFrom) + stepper('nightTo', 'Until', d.nightTo) + '</div>' : ''),
        'When the screen is idle in these hours it shows a dim clock instead of photos.') +
      field('Slideshow after', chips('idle', [[1, '1 min'], [2, '2 min'], [5, '5 min'], [10, '10 min'], [30, '30 min'], [0, 'Never']], d.idleMinutes), 'Untouched this long, the screen turns into a photo frame.') +
      field('Each photo for', chips('slide', [[8, '8 s'], [15, '15 s'], [30, '30 s'], [60, '1 min']], d.slideSeconds)) +
      field('Weather location', '<div class="st-inline"><div class="st-main"><b>' + (loc ? esc(loc.city || loc.lat + ', ' + loc.lon) : 'Automatic') + '</b><small>' +
        (loc ? loc.lat + ', ' + loc.lon : 'From this internet connection' + (cfgLoc.city ? ' · ' + esc(cfgLoc.city) : '')) + '</small></div>' +
        btn('data-city', 'Change') + (loc ? btn('data-city-auto', 'Automatic') : '') + '</div>') +
      '</div>';
  }
  function field(label, body, note) {
    return '<div class="st-field"><div class="label">' + label + '</div><div class="st-field-body">' + body + (note ? '<p class="st-note">' + note + '</p>' : '') + '</div></div>';
  }
  function stepper(key, label, h) {
    return '<div class="st-stepper"><span class="label">' + label + '</span><button class="icon-btn" data-step="' + key + '" data-by="-1" aria-label="Earlier">' + App.icon('minus', 24) + '</button>' +
      '<b class="num">' + hourLabel(h) + '</b><button class="icon-btn" data-step="' + key + '" data-by="1" aria-label="Later">' + App.icon('plus', 24) + '</button></div>';
  }

  function haSection() {
    var st = D.status.ha, url = V.doc.haUrl, signed = App.ha.signedIn();
    var tone = st.state === 'ok' ? 'ok' : st.state === 'connecting' ? 'busy' : st.state === 'error' ? 'bad' : 'idle';
    var text = st.state === 'ok' ? 'Connected' : st.state === 'connecting' ? 'Connecting…' : st.state === 'error' ? 'Can’t connect' : 'Not connected';
    return head('Home Assistant', 'This screen talks to Home Assistant directly over your Wi-Fi, and each screen signs in once.') +
      '<div class="card st-list">' +
      '<div class="st-row"><i class="st-dot st-dot--' + tone + '"></i><div class="st-main"><b>' + text + '</b>' + (st.message ? '<small class="st-pre">' + esc(st.message) + '</small>' : '') + '</div></div>' +
      '<div class="st-row">' + App.icon('link', 28, 'st-ico') + '<div class="st-main"><b>' + (url ? esc(url) : 'No address yet') + '</b><small>Address as this screen reaches it</small></div>' + btn('data-ha-url', 'Change') + '</div>' +
      '</div>' +
      '<div class="st-actions">' + (url && st.state !== 'ok' && st.state !== 'connecting' ? btn('data-ha-connect', 'Connect', 'btn--solid') : '') +
      (signed || st.state === 'ok' ? btn('data-ha-disconnect', 'Disconnect') : '') + '</div>';
  }

  function aboutSection() {
    var v = App.version;
    return head('About', '') +
      '<div class="card st-list">' +
      '<div class="st-row"><div class="st-main"><b>Version ' + esc(v.current) + '</b><small>' + (v.latest ? (v.latest === v.current ? 'Up to date' : 'Version ' + esc(v.latest) + ' is ready — this screen reloads when idle') : 'Checks for updates every 5 minutes') + '</small></div>' + btn('data-reload', 'Reload app') + '</div>' +
      '<div class="st-row"><div class="st-main"><b>' + esc(location.host) + '</b><small>Dashboard address</small></div></div>' +
      '<div class="st-row"><div class="st-main"><b>Settings saved ' + (V.doc.updated ? ago(V.doc.updated) : '') + '</b><small>Revision ' + V.doc.rev + ' · shared by every screen</small></div></div>' +
      '</div>' +
      '<p class="st-note st-note--big">The private link that opened this dashboard also works on phones: open it once on a phone to check the calendar, tick chores, add shopping or change these settings. Anyone with the link can see and change everything here, so share it only with family.</p>';
  }

  function head(title, note) {
    return '<header class="st-sec-head"><h2 class="serif">' + title + '</h2>' + (note ? '<p class="st-note">' + note + '</p>' : '') + '</header>';
  }

  // Colours for a member preview (palette entries are fixed, but be safe with any hex).
  function hexRgb(hex) { var n = parseInt(hex.slice(1), 16); return ((n >> 16) & 255) + ' ' + ((n >> 8) & 255) + ' ' + (n & 255); }
  function inkOf(hex) { var n = parseInt(hex.slice(1), 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170 ? '#111111' : '#FFFFFF'; }

  var SECTIONS = { sync: syncSection, family: familySection, calendars: calendarsSection, photos: photosSection, display: displaySection, ha: haSection, about: aboutSection };

  // ------------------------------------------------------------ paint
  function frame() {
    V.html = null;
    V.el.innerHTML = '<div class="st">' +
      '<nav class="st-nav"><header class="st-head"><div class="label">Home HQ</div><h1 class="serif">Settings</h1></header>' +
      TABS.map(function (t) { return '<button class="st-tab" data-tab="' + t[0] + '">' + App.icon(t[1], 26) + '<span>' + t[2] + '</span></button>'; }).join('') +
      '<button class="st-tab st-back" data-home>' + App.icon('left', 26) + '<span>Dashboard</span></button>' +
      '</nav><section class="st-body"></section></div>';
  }
  function paint() {
    if (!V.el || App.current !== 'settings') return;
    if (!V.el.querySelector('.st')) frame();
    App.$$('.st-tab[data-tab]', V.el).forEach(function (b) { b.classList.toggle('is-on', b.dataset.tab === V.tab); });
    var body = V.el.querySelector('.st-body'), top = body.scrollTop, html;
    if (V.tab === 'sync') html = syncSection();
    else if (!V.doc) html = '<div class="st-empty serif"><i>' + (V.error ? esc(V.error) : 'Loading settings…') + '</i></div>' + (V.error ? '<div class="st-actions">' + btn('data-retry', 'Try again') + '</div>' : '');
    else html = SECTIONS[V.tab]();
    // Only touch the DOM when something changed, so a tap is never lost to a no-op repaint.
    if (html === V.html && body.firstChild) return;
    V.html = html;
    body.innerHTML = html;
    body.scrollTop = top;
  }
  function paintSoon() { clearTimeout(V.paintTimer); V.paintTimer = setTimeout(paint, 60); }

  // ------------------------------------------------------------ sheets
  // Form sheets sit at the top of the screen so the on-screen keyboard never covers the input.
  function formSheet(html, onMount) {
    return App.sheet('<div class="sheet-pad st-sheet">' + html + '</div>', { cls: 'sheet--form', onMount: onMount });
  }
  function sheetError(s, msg) {
    var e = s.querySelector('.st-err');
    e.textContent = msg || '';
    e.style.display = msg ? '' : 'none';
  }
  function busy(b, on, label) {
    if (!b) return;
    b.disabled = on;
    if (label) b.innerHTML = on ? '<i class="st-spin"></i>' + label : label;
  }
  function confirmSheet(title, text, action, onYes) {
    App.sheet('<div class="sheet-pad"><div class="label">Are you sure?</div><h2 class="serif sheet-h">' + title + '</h2><p class="sheet-p st-confirm">' + text + '</p>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid st-danger" data-yes>' + action + '</button></div></div>', {
      onMount: function (s, close) {
        s.querySelector('[data-yes]').addEventListener('click', function () {
          var b = this;
          busy(b, true, action);
          Promise.resolve(onYes()).then(function (ok) { if (ok !== false) close(); else busy(b, false, action); }, function () { busy(b, false, action); });
        });
      }
    });
  }

  // Family ---------------------------------------------------------------------------
  function memberSheet(id) {
    var m = id ? find(V.doc.family, id) : null;
    if (id && !m) return;
    var used = V.doc.family.map(function (x) { return x.color; });
    var st = { color: m ? m.color : PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[0], kid: m ? m.kid : false };
    formSheet('<div class="label">Family</div><h2 class="serif sheet-h">' + (m ? esc(m.name) : 'Add a person') + '</h2>' +
      '<input class="st-input" data-f="name" maxlength="' + LIMITS.memberName + '" placeholder="Name" autocomplete="off" enterkeyhint="done" value="' + (m ? esc(m.name) : '') + '">' +
      '<div class="label">Colour</div>' + palette(st.color) +
      '<div class="label">Stars for chores</div>' + seg('kid', [['0', 'Grown-up'], ['1', 'Kid · earns stars']], st.kid ? '1' : '0') +
      '<p class="st-err" style="display:none"></p>' +
      '<div class="sheet-actions">' + (m ? '<button class="btn btn--ghost st-danger-ghost st-left" data-remove>' + App.icon('trash', 22) + 'Remove</button>' : '') +
      '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save>' + (m ? 'Save' : 'Add') + '</button></div>',
    function (s, close) {
      var input = s.querySelector('[data-f=name]');
      if (!m) input.focus();
      s.addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.dataset.color) { st.color = t.dataset.color; App.$$('[data-color]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); }); }
        if (t.dataset.kid) { st.kid = t.dataset.kid === '1'; App.$$('[data-kid]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); }); }
        if (t.hasAttribute('data-remove')) { close(); removeMember(m); }
        if (t.hasAttribute('data-save')) submit(t);
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(s.querySelector('[data-save]')); });
      function submit(b) {
        var name = input.value.replace(/\s+/g, ' ').trim();
        if (!name) { sheetError(s, 'Type a name'); input.focus(); return; }
        sheetError(s, '');
        busy(b, true, m ? 'Save' : 'Add');
        save(function (d) {
          if (m) {
            var x = find(d.family, m.id);
            if (!x) return null;
            x.name = name; x.color = st.color; x.kid = st.kid;
          } else {
            if (d.family.length >= LIMITS.members) return null;
            d.family.push({ name: name, color: st.color, kid: st.kid });
          }
          return { family: d.family };
        }, m ? 'Saved ' + esc(name) : 'Added ' + esc(name)).then(function () { input.blur(); close(); }, function (err) {
          busy(b, false, m ? 'Save' : 'Add');
          sheetError(s, errOf(err));
        });
      }
    });
  }
  function removeMember(m) {
    var only = V.doc.calendars.filter(function (c) { return c.people.length === 1 && c.people[0] === m.id; }).map(function (c) { return c.name; });
    confirmSheet('Remove ' + esc(m.name) + '?',
      'Their chores move to <b>Anyone</b>' + (m.kid ? ', and their stars and this week’s progress are cleared' : '') + '.' +
      (only.length ? ' ' + esc(only.join(', ')) + (only.length > 1 ? ' show' : ' shows') + ' for everyone until you pick someone else.' : '') +
      ' Events and shopping stay.', 'Remove',
      function () {
        return saveQuietly(function (d) {
          if (!find(d.family, m.id)) return null;
          return { family: d.family.filter(function (x) { return x.id !== m.id; }) };
        }, 'Removed ' + esc(m.name));
      });
  }

  // Calendars ------------------------------------------------------------------------
  function calendarSheet(id) {
    var c = id ? find(V.doc.calendars, id) : null;
    if (id && !c) return;
    var st = { url: c ? c.url : '', checked: !!c, name: c ? c.name : '', people: c ? c.people.slice() : [], color: c ? c.color : null };
    formSheet('<div class="label">Calendar</div><h2 class="serif sheet-h">' + (c ? esc(c.name) : 'Add a calendar') + '</h2>' +
      (c ? '<p class="st-link">' + App.icon('link', 20) + esc(shortUrl(c.url)) + '</p>'
        : '<p class="sheet-p">Paste the calendar’s <b>secret address in iCal format</b> (ends in .ics).</p>' +
          '<div class="st-input-row"><input class="st-input st-input--link" data-f="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"' + LINK_ATTRS + '>' +
          '<button class="btn btn--solid" data-check>Check</button></div>' +
          '<p class="st-ok" style="display:none"></p>') +
      '<div class="st-details"' + (c ? '' : ' style="display:none"') + '>' +
      '<div class="label">Name</div><input class="st-input" data-f="name" maxlength="' + LIMITS.calendarName + '" autocomplete="off" enterkeyhint="done" value="' + esc(st.name) + '">' +
      '<div class="label">Whose calendar</div>' + whoPicker(st.people) +
      '<div class="label">Colour</div>' + palette(st.color, true) +
      '</div>' +
      '<p class="st-err" style="display:none"></p>' +
      '<div class="sheet-actions">' + (c ? '<button class="btn btn--ghost st-danger-ghost st-left" data-remove>' + App.icon('trash', 22) + 'Remove</button>' : '') +
      '<button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save' + (c ? '' : ' disabled') + '>' + (c ? 'Save' : 'Add calendar') + '</button></div>',
    function (s, close) {
      var urlIn = s.querySelector('[data-f=url]'), nameIn = s.querySelector('[data-f=name]');
      if (urlIn) {
        urlIn.focus();
        urlIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') runCheck(); });
        urlIn.addEventListener('input', function () { if (st.checked) { st.checked = false; s.querySelector('[data-save]').disabled = true; } });
      }
      s.addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-check')) return runCheck();
        if (t.dataset.who !== undefined) { st.people = toggleWho(st.people, t.dataset.who); paintWho(s, st.people); }
        if (t.dataset.color !== undefined) { st.color = t.dataset.color || null; App.$$('[data-color]', s).forEach(function (b) { b.classList.toggle('is-on', b === t); }); }
        if (t.hasAttribute('data-remove')) { close(); removeCalendar(c); }
        if (t.hasAttribute('data-save')) submit(t);
      });
      function runCheck() {
        var b = s.querySelector('[data-check]'), okLine = s.querySelector('.st-ok');
        var url;
        try { url = cleanCalendarUrl(urlIn.value); } catch (err) { sheetError(s, errOf(err)); return; }
        sheetError(s, '');
        okLine.style.display = 'none';
        busy(b, true, 'Check');
        check('calendar', url).then(function (r) {
          st.url = r.url; st.checked = true;
          okLine.innerHTML = App.icon('check', 22) + (r.name ? '<b>' + esc(r.name) + '</b> · ' : '') + r.events + ' events in the feed';
          okLine.style.display = '';
          if (!nameIn.value) nameIn.value = (r.name || 'Calendar ' + (V.doc.calendars.length + 1)).slice(0, LIMITS.calendarName);
          s.querySelector('.st-details').style.display = '';
          s.querySelector('[data-save]').disabled = false;
          urlIn.blur();
        }, function (err) { sheetError(s, errOf(err)); }).then(function () { busy(b, false, 'Check'); });
      }
      function submit(b) {
        var name = nameIn.value.replace(/\s+/g, ' ').trim();
        if (!st.checked) { sheetError(s, 'Check the link first'); return; }
        if (!name) { sheetError(s, 'Give the calendar a name'); nameIn.focus(); return; }
        sheetError(s, '');
        var label = c ? 'Save' : 'Add calendar';
        busy(b, true, label);
        save(function (d) {
          var known = d.family.map(function (m) { return m.id; });
          var people = st.people.filter(function (p) { return known.indexOf(p) > -1; });
          if (c) {
            var x = find(d.calendars, c.id);
            if (!x) return null;
            x.name = name; x.people = people; x.color = st.color;
          } else {
            d.calendars.push({ url: st.url, name: name, people: people, color: st.color });
          }
          return { calendars: d.calendars };
        }, (c ? 'Saved ' : 'Added ') + esc(name)).then(function () {
          close();
          App.sync.refresh('calendar');
        }, function (err) { busy(b, false, label); sheetError(s, errOf(err)); });
      }
    });
  }
  function shortUrl(u) { return u.length > 64 ? u.slice(0, 40) + '…' + u.slice(-16) : u; }
  function removeCalendar(c) {
    confirmSheet('Remove ' + esc(c.name) + '?', 'Its events disappear from the dashboard. The calendar itself isn’t touched; you can add it again with its link.', 'Remove', function () {
      return saveQuietly(function (d) {
        if (!find(d.calendars, c.id)) return null;
        return { calendars: d.calendars.filter(function (x) { return x.id !== c.id; }) };
      }, 'Removed ' + esc(c.name));
    });
  }

  // Albums ---------------------------------------------------------------------------
  function albumSheet() {
    var st = { url: '', name: '', checked: false };
    formSheet('<div class="label">Photo album</div><h2 class="serif sheet-h">Add an album</h2>' +
      '<p class="sheet-p">Paste the shared album’s public link: <b>photos.icloud.com/shared/album/…</b> or <b>icloud.com/sharedalbum/#…</b></p>' +
      '<div class="st-input-row"><input class="st-input st-input--link" data-f="url" placeholder="https://photos.icloud.com/shared/album/…"' + LINK_ATTRS + '>' +
      '<button class="btn btn--solid" data-check>Check</button></div>' +
      '<p class="st-ok" style="display:none"></p><p class="st-err" style="display:none"></p>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save disabled>Add album</button></div>',
    function (s, close) {
      var urlIn = s.querySelector('[data-f=url]');
      urlIn.focus();
      urlIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') runCheck(); });
      urlIn.addEventListener('input', function () { if (st.checked) { st.checked = false; s.querySelector('[data-save]').disabled = true; } });
      s.addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-check')) runCheck();
        if (t.hasAttribute('data-save')) submit(t);
      });
      function runCheck() {
        var b = s.querySelector('[data-check]'), okLine = s.querySelector('.st-ok'), link;
        try { link = cleanAlbumUrl(urlIn.value); } catch (err) { sheetError(s, errOf(err)); return; }
        sheetError(s, '');
        okLine.style.display = 'none';
        busy(b, true, 'Check');
        check('album', link.url).then(function (r) {
          st.url = r.url; st.name = (r.name || '').slice(0, LIMITS.albumName); st.checked = true;
          okLine.innerHTML = App.icon('check', 22) + '<b>' + esc(r.name || 'Shared album') + '</b> · ' + r.count + (r.partial ? '+' : '') + ' photos';
          okLine.style.display = '';
          s.querySelector('[data-save]').disabled = false;
          urlIn.blur();
        }, function (err) { sheetError(s, errOf(err)); }).then(function () { busy(b, false, 'Check'); });
      }
      function submit(b) {
        if (!st.checked) { sheetError(s, 'Check the link first'); return; }
        busy(b, true, 'Add album');
        save(function (d) {
          var a = { url: st.url };
          if (st.name && !/[<>\u0000-\u001f]/.test(st.name)) a.name = st.name;
          d.albums.push(a);
          return { albums: d.albums };
        }, 'Added ' + esc(st.name || 'the album')).then(function () {
          close();
          App.sync.refresh('photos');
        }, function (err) { busy(b, false, 'Add album'); sheetError(s, errOf(err)); });
      }
    });
  }
  function removeAlbum(id) {
    var a = find(V.doc.albums, id);
    if (!a) return;
    var stat = find(D.albumStats || [], id), name = (stat && stat.name) || a.name || 'this album';
    confirmSheet('Remove ' + esc(name) + '?', 'Its photos stop showing on the dashboard. The album in iCloud isn’t touched.', 'Remove', function () {
      return saveQuietly(function (d) {
        if (!find(d.albums, id)) return null;
        return { albums: d.albums.filter(function (x) { return x.id !== id; }) };
      }, 'Removed ' + esc(name));
    });
  }

  // Display --------------------------------------------------------------------------
  function citySheet() {
    formSheet('<div class="label">Weather</div><h2 class="serif sheet-h">Weather location</h2>' +
      '<div class="st-input-row"><input class="st-input" data-f="city" placeholder="City or US ZIP code" autocomplete="off" enterkeyhint="search">' +
      '<button class="btn btn--solid" data-search>Search</button></div>' +
      '<p class="st-err" style="display:none"></p><div class="st-places"></div>',
    function (s, close) {
      var input = s.querySelector('[data-f=city]'), places = [];
      input.focus();
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') search(); });
      s.addEventListener('click', function (e) {
        var t = e.target.closest('button');
        if (!t) return;
        if (t.hasAttribute('data-search')) search();
        if (t.dataset.place) {
          var p = places[+t.dataset.place];
          busy(t, true);
          save(function () { return { location: { city: p.name, lat: p.lat, lon: p.lon } }; }, 'Weather for ' + esc(p.name)).then(close, function (err) { busy(t, false); sheetError(s, errOf(err)); });
        }
      });
      function search() {
        var q = input.value.trim(), b = s.querySelector('[data-search]');
        if (q.length < 2) { sheetError(s, 'Type a city name or US ZIP code'); return; }
        sheetError(s, '');
        busy(b, true, 'Search');
        check('city', q).then(function (r) {
          places = r.places;
          input.blur();
          s.querySelector('.st-places').innerHTML = places.map(function (p, i) {
            return '<button class="st-row st-row--tap" data-place="' + i + '">' + App.icon('pin', 26, 'st-ico') + '<div class="st-main"><b>' + esc(p.name) + '</b><small>' + esc(p.region) + '</small></div></button>';
          }).join('');
        }, function (err) { sheetError(s, errOf(err)); }).then(function () { busy(b, false, 'Search'); });
      }
    });
  }
  // Steppers save after a pause so tapping + five times is one save.
  var stepTimer = null, stepPending = {};
  function step(key, by) {
    var d = V.doc;
    var h = ((stepPending[key] != null ? stepPending[key] : d[key]) + by + 24) % 24;
    var other = key === 'nightFrom' ? 'nightTo' : 'nightFrom';
    var otherVal = stepPending[other] != null ? stepPending[other] : d[other];
    if (h === otherVal) h = (h + by + 24) % 24; // equal hours would mean "off"
    stepPending[key] = h;
    d[key] = h; // show it now
    paint();
    clearTimeout(stepTimer);
    stepTimer = setTimeout(function () {
      var patch = stepPending;
      stepPending = {};
      saveQuietly(function () { return patch; }, 'Night clock ' + hourLabel(V.doc.nightFrom) + ' – ' + hourLabel(V.doc.nightTo)).then(function (ok) { if (!ok) load(); });
    }, 900);
  }

  // Home Assistant ---------------------------------------------------------------------
  function haUrlSheet() {
    formSheet('<div class="label">Home Assistant</div><h2 class="serif sheet-h">Address</h2>' +
      '<p class="sheet-p">As this screen reaches it on your Wi-Fi, e.g. <b>http://192.168.1.20:8123</b></p>' +
      '<input class="st-input st-input--link" data-f="url" placeholder="http://homeassistant.local:8123"' + LINK_ATTRS + ' value="' + esc(V.doc.haUrl || '') + '">' +
      '<p class="st-err" style="display:none"></p>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save>Save</button></div>',
    function (s, close) {
      var input = s.querySelector('[data-f=url]');
      input.focus();
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(s.querySelector('[data-save]')); });
      s.querySelector('[data-save]').addEventListener('click', function () { submit(this); });
      function submit(b) {
        var url;
        try { url = cleanHaUrl(input.value); } catch (err) { sheetError(s, errOf(err)); return; }
        busy(b, true, 'Save');
        save(function () { return { haUrl: url }; }, 'Home Assistant address saved').then(function () { input.blur(); close(); }, function (err) { busy(b, false, 'Save'); sheetError(s, errOf(err)); });
      }
    });
  }

  // ------------------------------------------------------------ clicks
  function onClick(e) {
    var t = e.target.closest('button');
    if (!t || t.disabled) return;
    var ds = t.dataset;
    if (ds.tab) { V.tab = ds.tab; V.el.querySelector('.st-body').scrollTop = 0; return paint(); }
    if (t.hasAttribute('data-home')) return App.go('home');
    if (t.hasAttribute('data-retry')) return load();
    if (ds.refresh) {
      App.sync.refresh(ds.refresh).then(function () {
        var srcs = ds.refresh === 'all' ? SOURCES.map(function (s) { return s[0]; }) : [ds.refresh];
        var bad = srcs.filter(function (s) { return App.sync.status[s].lastError; });
        if (bad.length) App.toast(esc(App.sync.status[bad[0]].lastError), { tone: 'error', icon: 'bolt' });
        else App.toast(ds.refresh === 'all' ? 'Everything is up to date' : 'Up to date', { icon: 'check', ms: 2500 });
      });
      return paint();
    }
    if (t.hasAttribute('data-reload')) return App.version.reload();
    if (!V.doc) return;
    if (ds.member) return memberSheet(ds.member);
    if (t.hasAttribute('data-add-member')) return memberSheet(null);
    if (ds.cal) return calendarSheet(ds.cal);
    if (t.hasAttribute('data-add-cal')) return calendarSheet(null);
    if (t.hasAttribute('data-add-album')) return albumSheet();
    if (ds.delAlbum) return removeAlbum(ds.delAlbum);
    if (ds.units) return saveQuietly(function () { return { units: ds.units }; }, ds.units === 'celsius' ? 'Temperatures in °C' : 'Temperatures in °F');
    if (ds.clock) return saveQuietly(function () { return { clock24: ds.clock === '24' }; }, ds.clock + '-hour clock');
    if (ds.night) {
      return saveQuietly(function () { return ds.night === 'on' ? { nightFrom: 22, nightTo: 6 } : { nightFrom: 0, nightTo: 0 }; }, ds.night === 'on' ? 'Night clock on' : 'Night clock off');
    }
    if (ds.step) return step(ds.step, +ds.by);
    if (ds.idle) return saveQuietly(function () { return { idleMinutes: +ds.idle }; }, +ds.idle ? 'Slideshow after ' + ds.idle + ' min' : 'No automatic slideshow');
    if (ds.slide) return saveQuietly(function () { return { slideSeconds: +ds.slide }; }, ds.slide + ' seconds per photo');
    if (t.hasAttribute('data-city')) return citySheet();
    if (t.hasAttribute('data-city-auto')) return saveQuietly(function () { return { location: null }; }, 'Weather location: automatic');
    if (t.hasAttribute('data-ha-url')) return haUrlSheet();
    if (t.hasAttribute('data-ha-connect')) return App.ha.login();
    if (t.hasAttribute('data-ha-disconnect')) {
      return confirmSheet('Disconnect Home Assistant?', 'This screen forgets its sign-in. Lights, locks and cameras stay hidden here until you connect again.', 'Disconnect', function () { App.ha.logout(); paint(); });
    }
  }

  // ------------------------------------------------------------ live updates
  App.on('sync', paintSoon);
  App.on('ha', paintSoon);
  App.on('version', paintSoon);
  App.on('minute', paintSoon);
  App.on('photos', paintSoon);
  App.on('data', function () { if (V.tab === 'calendars' || V.tab === 'photos') paintSoon(); });
  // Settings saved on another screen: fetch the new document.
  App.on('config', function (c) {
    if (V.doc && c.cfg.settingsRev !== V.doc.rev && App.current === 'settings') load();
    else paintSoon();
  });

  App.register('settings', {
    lazy: true,
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      frame();
      paint();
      load();
    },
    resume: function () { paint(); load(); }
  });
})();
