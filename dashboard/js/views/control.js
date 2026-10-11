// Home control (Home Assistant): status summary, scenes, rooms of tiles, climate, cameras, media.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, pending: {}, scene: null, camTimer: null, camAge: 0, sig: '', tempTimer: null };

  function dev(id) { return D.devices.filter(function (d) { return d.id === id; })[0]; }
  function fail(name, err) {
    App.toast('Couldn’t reach <b>' + App.esc(name) + '</b>' + (err && err.message ? ' · ' + App.esc(err.message) : ''), { tone: 'error', icon: 'bolt' });
  }

  // Patch → Home Assistant service call
  function serviceFor(d, patch) {
    var t = { entity_id: d.id };
    if (d.type === 'light') {
      if (!patch.on) return ['light', 'turn_off', t];
      return ['light', 'turn_on', d.dim && patch.level ? Object.assign(t, { brightness_pct: patch.level }) : t];
    }
    if (d.type === 'switch') return ['homeassistant', patch.on ? 'turn_on' : 'turn_off', t];
    if (d.type === 'blind') {
      if (d.canPos) return ['cover', 'set_cover_position', Object.assign(t, { position: patch.pos })];
      return ['cover', patch.pos > 0 ? 'open_cover' : 'close_cover', t];
    }
    if (d.type === 'lock') return ['lock', patch.locked ? 'lock' : 'unlock', t];
    if (d.type === 'garage') return ['cover', patch.state === 'opening' ? 'open_cover' : 'close_cover', t];
    return null;
  }

  // Optimistic device update: flip immediately, call Home Assistant; live state confirms (or the
  // call fails and we revert).
  App.setDevice = function (id, patch) {
    var d = dev(id), before = {};
    if (!d) return;
    var svc = serviceFor(d, patch);
    Object.keys(patch).forEach(function (k) { before[k] = d[k]; d[k] = patch[k]; });
    V.pending[id] = Date.now();
    changed([id]);
    App.ha.call(svc[0], svc[1], svc[2]).then(function () {
      setTimeout(function () { if (V.pending[id]) { delete V.pending[id]; paintTile(id); } }, 4000);
    }, function (err) {
      delete V.pending[id];
      Object.keys(before).forEach(function (k) { d[k] = before[k]; });
      fail(d.name, err);
      changed([id]);
    });
  };

  // ------------------------------------------------------------ tiles
  function tile(d) {
    var pend = V.pending[d.id] ? '<i class="pend"></i>' : '';
    var na = d.unavailable ? ' is-na' : '';
    if (d.type === 'light' || d.type === 'switch') {
      var lvl = d.on ? (d.type === 'light' && d.dim ? d.level : 100) : 0;
      var icon = d.type === 'light' ? 'bulb' : d.kind === 'fan' ? 'fan' : 'power';
      return '<div class="tile tile--light' + (d.on ? ' is-on' : '') + na + '" data-dev="' + d.id + '" style="--lvl:' + lvl + '%">' +
        '<span class="tile-fill"></span>' + pend +
        '<span class="tile-icon">' + App.icon(icon, 28) + '</span>' +
        '<span class="tile-name">' + App.esc(d.name) + '</span>' +
        '<span class="tile-state num">' + (d.unavailable ? 'Offline' : d.on ? (d.type === 'light' && d.dim ? d.level + '%' : 'On') : 'Off') + '</span></div>';
    }
    if (d.type === 'blind') {
      return '<div class="tile tile--blind' + (d.pos > 0 ? ' is-on' : '') + na + '" data-dev="' + d.id + '" style="--lvl:' + d.pos + '%">' +
        '<span class="tile-fill"></span>' + pend +
        '<span class="tile-icon">' + App.icon('blinds', 28) + '</span>' +
        '<span class="tile-name">' + App.esc(d.name) + '</span>' +
        '<span class="tile-state num">' + (d.pos === 0 ? 'Closed' : d.pos === 100 ? 'Open' : d.pos + '% open') + '</span></div>';
    }
    if (d.type === 'lock') {
      return '<div class="tile tile--lock' + (d.locked ? '' : ' is-warn') + na + '" data-dev="' + d.id + '">' + pend +
        '<span class="tile-icon">' + App.icon(d.locked ? 'lock' : 'unlock', 28) + '</span>' +
        '<span class="tile-name">' + App.esc(d.name) + '</span>' +
        '<span class="tile-state">' + (d.locked ? 'Locked<small>Hold to unlock</small>' : 'Unlocked<small>Tap to lock</small>') + '</span>' +
        '<svg class="hold-ring" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17"/></svg></div>';
    }
    if (d.type === 'garage') {
      var label = { closed: 'Closed', open: 'Open', opening: 'Opening…', closing: 'Closing…' }[d.state] || d.state;
      return '<div class="tile tile--garage' + (d.state !== 'closed' ? ' is-warn' : '') + (/ing$/.test(d.state) ? ' is-moving' : '') + na + '" data-dev="' + d.id + '">' + pend +
        '<span class="tile-icon">' + App.icon('garage', 28) + '</span>' +
        '<span class="tile-name">' + App.esc(d.name) + '</span>' +
        '<span class="tile-state">' + label + '</span></div>';
    }
    return '';
  }

  function summary() {
    var lights = D.devices.filter(function (d) { return d.type === 'light' && d.on; });
    var unlocked = D.devices.filter(function (d) { return d.type === 'lock' && !d.locked; });
    var garages = D.devices.filter(function (d) { return d.type === 'garage' && d.state !== 'closed'; });
    var openNames = garages.map(function (g) { return g.name + ' ' + g.state; }).concat(unlocked.map(function (u) { return u.name; }));
    var secure = !openNames.length;
    var c = D.climate, m = D.media;
    return '<button class="sum' + (lights.length ? ' sum--warm' : '') + '" data-sum="lights"><span class="label">Lights</span><b class="num">' + lights.length + '</b><small>on in ' + unique(lights.map(function (l) { return l.room; })).length + ' rooms</small></button>' +
      '<button class="sum' + (secure ? '' : ' sum--warn') + '" data-sum="security"><span class="label">Security</span><b class="num">' + (secure ? 'Locked' : openNames.length) + '</b><small>' + (secure ? 'All doors + garage' : App.esc(openNames.join(', ')) + ' open') + '</small></button>' +
      '<button class="sum" data-sum="climate"><span class="label">Climate</span><b class="num">' + (c && c.current != null ? c.current + '°' : '–') + '</b><small>' + (!c ? 'No thermostat' : c.mode === 'off' ? 'System off' : verb(c) + (c.set != null ? ' to ' + c.set + '°' : '')) + '</small></button>' +
      '<button class="sum" data-sum="media"><span class="label">Media</span><b class="num">' + (!m ? '–' : m.playing ? 'Playing' : 'Paused') + '</b><small>' + (m ? App.esc(m.room) : 'No speaker') + '</small></button>';
  }
  function unique(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function verb(c) {
    if (c.mode === 'off') return 'Off';
    if (c.action) return { heating: 'Heating', cooling: 'Cooling', idle: 'Holding', off: 'Off', fan: 'Fan', drying: 'Drying' }[c.action] || 'Holding';
    return c.set > c.current ? 'Heating' : c.set < c.current ? 'Cooling' : 'Holding';
  }

  function scenes() {
    if (!D.scenes.length) return '';
    return D.scenes.map(function (s) {
      return '<button class="scene' + (V.scene === s.id ? ' is-on' : '') + '" data-scene="' + s.id + '">' + App.icon(s.icon, 26) + '<span>' + App.esc(s.name) + '</span></button>';
    }).join('');
  }

  function roomCount(room) {
    var on = D.devices.filter(function (d) { return d.room === room && d.type === 'light' && d.on; }).length;
    return on ? on + ' on' : 'All off';
  }
  function rooms() {
    if (!D.rooms.length) return '<div class="hc-none serif"><i>No lights, switches, covers or locks found in Home Assistant.</i></div>';
    return D.rooms.map(function (r) {
      var list = D.devices.filter(function (d) { return d.room === r.id; });
      return '<section class="room"><div class="room-h"><h3 class="serif">' + App.esc(r.name) + '</h3><span class="label" data-room-count="' + r.id + '">' + roomCount(r.id) + '</span></div>' +
        '<div class="tiles">' + list.map(tile).join('') + '</div></section>';
    }).join('');
  }

  var MODE_LABELS = { heat: 'Heat', cool: 'Cool', heat_cool: 'Auto', auto: 'Auto', off: 'Off', fan_only: 'Fan', dry: 'Dry' };
  function climate() {
    var c = D.climate;
    if (!c) return '<div class="label label--light">Climate</div><div class="hc-none hc-none--dark serif"><i>No thermostat in Home Assistant</i></div>';
    var v = verb(c);
    var modes = ['heat', 'cool', 'heat_cool', 'auto', 'off'].filter(function (m) { return c.modes.indexOf(m) > -1; }).slice(0, 4);
    return '<div class="label label--light">Climate · ' + App.esc(c.name) + '</div>' +
      '<div class="th-main"><button class="th-btn" data-temp="-1" aria-label="Cooler">' + App.icon('minus', 36) + '</button>' +
      '<div class="th-set"><span class="num">' + (c.set != null ? (+c.set).toFixed(1).replace('.0', '') + '°' : '–') + '</span><small>Set to</small></div>' +
      '<button class="th-btn" data-temp="1" aria-label="Warmer">' + App.icon('plus', 36) + '</button></div>' +
      '<div class="th-now"><span><b class="num">' + (c.current != null ? c.current + '°' : '–') + '</b> inside</span><span class="th-verb th-verb--' + v.toLowerCase() + '">' + v + '</span>' +
      (c.humidity != null ? '<span><b class="num">' + c.humidity + '%</b> humidity</span>' : '<span></span>') + '</div>' +
      (modes.length ? '<div class="seg seg--dark">' + modes.map(function (m) {
        return '<button class="' + (c.mode === m ? 'is-on' : '') + '" data-tmode="' + m + '">' + MODE_LABELS[m] + '</button>';
      }).join('') + '</div>' : '');
  }

  function cams() {
    if (!D.cameras.length) return '';
    return '<div class="label">Cameras · snapshots every 20s</div><div class="cams">' + D.cameras.slice(0, 2).map(function (c) {
      return '<button class="cam" data-cam="' + c.id + '"><img src="' + App.ha.cameraSrc(c) + '" alt=""><span class="cam-name">' + App.esc(c.name) + '</span><span class="cam-age">' + V.camAge + 's ago</span></button>';
    }).join('') + '</div>';
  }

  function media() {
    var m = D.media;
    if (!m) return '<div class="np-art">' + App.icon('music', 30) + '</div><div class="np-text"><span class="label">Media</span><b>No speaker found</b><span>Add a media player to Home Assistant</span></div>';
    return (m.art ? '<img class="np-art" src="' + App.esc(m.art) + '" alt="">' : '') +
      '<div class="np-text"><span class="label">' + App.esc(m.room) + '</span><b>' + App.esc(m.title) + '</b><span>' + App.esc(m.artist) + '</span></div>' +
      (m.volume != null ? '<button class="np-btn np-btn--ghost" data-vol="-5" aria-label="Volume down">' + App.icon('minus', 24) + '</button>' +
        '<button class="np-btn np-btn--ghost" data-vol="5" aria-label="Volume up">' + App.icon('plus', 24) + '</button>' : '') +
      '<button class="np-btn" data-play aria-label="Play/Pause">' + App.icon(m.playing ? 'pause' : 'play', 30) + '</button>';
  }

  // Granular updates: an action repaints only what it touched (full paint() rebuilds ~270 nodes,
  // which costs ~350ms on the wall tablet).
  function paintTile(id) {
    var d = dev(id);
    if (!d) return;
    [V.el && V.el.querySelector('.hc-rooms'), V.sheetBox].forEach(function (root) {
      var old = root && root.querySelector('[data-dev="' + id + '"]');
      if (!old) return;
      var tmp = document.createElement('div');
      tmp.innerHTML = tile(d);
      var nt = tmp.firstChild;
      old.parentNode.replaceChild(nt, old);
      bindTile(nt);
    });
    var c = V.el && V.el.querySelector('[data-room-count="' + d.room + '"]');
    if (c) c.textContent = roomCount(d.room);
  }
  function paintPart(sel, html) { var x = V.el && V.el.querySelector(sel); if (x) x.innerHTML = html; }
  function changed(ids) {
    ids.forEach(paintTile);
    paintPart('.hc-sum', summary());
    App.emit('ha');
  }

  function paint() {
    if (!V.el || !V.el.querySelector('.hc')) return;
    var el = V.el;
    el.querySelector('.hc-sum').innerHTML = summary();
    el.querySelector('.hc-scenes').innerHTML = scenes();
    var rs = el.querySelector('.hc-rooms'), st = rs.scrollTop;
    rs.innerHTML = rooms();
    rs.scrollTop = st;
    bindTiles(rs);
    el.querySelector('.hc-climate').innerHTML = climate();
    el.querySelector('.hc-cams').innerHTML = cams();
    el.querySelector('.hc-media').innerHTML = media();
    V.sig = structure();
  }
  function structure() { return D.rooms.map(function (r) { return r.id; }).join() + '|' + D.devices.map(function (d) { return d.id + d.room; }).join() + '|' + D.scenes.map(function (s) { return s.id; }).join() + '|' + D.cameras.map(function (c) { return c.id; }).join(); }
  function tileKey(d) { return JSON.stringify([d.on, d.level, d.pos, d.locked, d.state, d.unavailable, d.name]); }

  // ------------------------------------------------------------ not connected
  function connectHTML() {
    var st = D.status.ha, url = D.config ? D.config.haUrl : '';
    var connecting = st.state === 'connecting';
    return '<div class="hc-connect"><div class="hc-connect-card">' +
      '<div class="label">Home Assistant · ' + App.esc(url) + '</div>' +
      '<h1 class="serif">' + (connecting ? 'Connecting…' : 'Connect Home Assistant') + '</h1>' +
      (st.message ? '<pre class="hc-connect-msg">' + App.esc(st.message) + '</pre>' : '<p>Sign in once to control lights, locks, climate, cameras and scenes from here.</p>') +
      (connecting ? '' : '<div class="sheet-actions">' + (st.state === 'error' ? '<button class="btn btn--ghost" data-ha-retry>Try again</button>' : '') +
        '<button class="btn btn--solid" data-ha-login>Connect Home Assistant</button></div>') +
      '</div></div>';
  }

  function layout() {
    if (!V.el) return;
    if (D.status.ha.state !== 'ok') {
      clearInterval(V.camTimer);
      V.el.innerHTML = connectHTML();
      return;
    }
    if (!V.el.querySelector('.hc')) {
      V.el.innerHTML = '<div class="hc">' +
        '<div class="hc-left"><div class="hc-sum"></div><div class="hc-scenes"></div><div class="hc-rooms"></div></div>' +
        '<div class="hc-right"><div class="hc-climate"></div><div class="hc-cams"></div><div class="hc-media card"></div></div>' +
        '</div>';
    }
    paint();
  }

  // ------------------------------------------------------------ tile gestures
  // Lights + blinds: tap toggles, horizontal drag sets level (whole tile is the slider).
  function sliderTile(t, d) {
    var sx, startLvl, dragging = false, w;
    var canDrag = (d.type === 'light' && d.dim) || (d.type === 'blind' && d.canPos);
    t.addEventListener('pointerdown', function (e) {
      sx = e.clientX; dragging = false; w = t.getBoundingClientRect().width;
      startLvl = d.type === 'light' ? (d.on ? d.level : 0) : d.pos;
      try { t.setPointerCapture(e.pointerId); } catch (err) {}
    });
    t.addEventListener('pointermove', function (e) {
      if (sx == null || !canDrag) return;
      var dx = e.clientX - sx;
      if (!dragging && Math.abs(dx) > 10) { dragging = true; t.classList.add('is-drag'); }
      if (!dragging) return;
      var lvl = Math.max(0, Math.min(100, Math.round(startLvl + dx / w * 100)));
      t.style.setProperty('--lvl', lvl + '%');
      t.classList.toggle('is-on', lvl > 0);
      t.querySelector('.tile-state').textContent = d.type === 'light' ? (lvl ? lvl + '%' : 'Off') : (lvl === 0 ? 'Closed' : lvl === 100 ? 'Open' : lvl + '% open');
      t._lvl = lvl;
    });
    t.addEventListener('pointerup', function () {
      if (sx == null) return;
      sx = null;
      t.classList.remove('is-drag');
      V.scene = null;
      if (dragging) {
        var lvl = t._lvl;
        if (d.type === 'light') App.setDevice(d.id, lvl ? { on: true, level: lvl } : { on: false });
        else App.setDevice(d.id, { pos: lvl });
      } else if (d.type === 'light' || d.type === 'switch') App.setDevice(d.id, { on: !d.on, level: d.level || 100 });
      else App.setDevice(d.id, { pos: d.pos > 0 ? 0 : 100 });
    });
    t.addEventListener('pointercancel', function () { sx = null; t.classList.remove('is-drag'); paintTile(d.id); });
  }

  function bindTiles(root) { App.$$('[data-dev]', root).forEach(bindTile); }
  function bindTile(t) {
    var d = dev(t.dataset.dev);
    if (!d) return;
    if (d.type === 'light' || d.type === 'switch' || d.type === 'blind') sliderTile(t, d);
    if (d.type === 'lock') {
      App.hold(t, 1000, {
        enabled: function () { return d.locked; },
        done: function () { V.lastHold = Date.now(); App.setDevice(d.id, { locked: false }); App.toast('<b>' + App.esc(d.name) + '</b> unlocking', { icon: 'unlock' }); },
        cancel: function () { App.toast('Hold for a second to unlock <b>' + App.esc(d.name) + '</b>', { icon: 'lock', ms: 2200 }); }
      });
      t.addEventListener('click', function () { if (!d.locked && Date.now() - (V.lastHold || 0) > 800) App.setDevice(d.id, { locked: true }); });
    }
    if (d.type === 'garage') t.addEventListener('click', function () { App.openGarageSheet(d.id); });
  }

  // Slide-to-confirm for the garage
  App.openGarageSheet = function (id) {
    var g = dev(id);
    if (!g) return;
    var opening = g.state === 'closed' || g.state === 'closing';
    App.sheet('<div class="sheet-pad"><div class="label">' + App.esc(g.name) + ' · currently ' + g.state + '</div><h2 class="serif sheet-h">' + (opening ? 'Open' : 'Close') + ' the ' + App.esc(g.name.toLowerCase()) + '?</h2>' +
      '<p class="sheet-p">' + (opening ? 'Make sure the driveway is clear.' : 'The door will stop and reverse if anything is in the way.') + '</p>' +
      '<div class="slide-confirm"><span class="sc-label">Slide to ' + (opening ? 'open' : 'close') + ' →</span><span class="sc-fill"></span><span class="sc-knob">' + App.icon('garage', 30) + '</span></div></div>', {
      onMount: function (s, close) {
        var track = s.querySelector('.slide-confirm'), knob = s.querySelector('.sc-knob'), fill = s.querySelector('.sc-fill');
        var sx = null, max;
        knob.addEventListener('pointerdown', function (e) {
          sx = e.clientX; max = track.getBoundingClientRect().width - knob.getBoundingClientRect().width - 8;
          knob.setPointerCapture(e.pointerId);
        });
        knob.addEventListener('pointermove', function (e) {
          if (sx == null) return;
          var k = App.$('#stage').getBoundingClientRect().width / 1280;
          var x = Math.max(0, Math.min(max / k, (e.clientX - sx) / k));
          knob.style.transform = 'translateX(' + x + 'px)';
          fill.style.width = (x + 76) + 'px';
          knob._x = x; knob._max = max / k;
        });
        knob.addEventListener('pointerup', function () {
          if (sx == null) return;
          sx = null;
          if (knob._x >= knob._max - 6) {
            close();
            V.scene = null;
            App.setDevice(g.id, { state: opening ? 'opening' : 'closing' });
          } else { knob.style.transform = ''; fill.style.width = ''; }
        });
      }
    });
  };

  App.cameraSheet = function (c) {
    if (!c) return;
    App.sheet('<div class="cam-big"><img src="' + App.ha.cameraSrc(c) + '" alt=""><div class="cam-big-bar"><span class="tk-live"><i></i>' + App.esc(c.name) + '</span><span class="label label--light">Snapshot · just now</span></div></div>', { cls: 'sheet--cam' });
  };

  function listSheet(kind) {
    var list = D.devices.filter(function (d) { return kind === 'lights' ? d.type === 'light' : (d.type === 'lock' || d.type === 'garage'); });
    if (kind === 'lights') list.sort(function (a, b) { return b.on - a.on; });
    App.sheet('<div class="sheet-pad"><div class="label">' + (kind === 'lights' ? 'Every light in the house' : 'Doors + garage') + '</div>' +
      '<h2 class="serif sheet-h">' + (kind === 'lights' ? 'Lights' : 'Security') + '</h2>' +
      '<div class="tiles tiles--sheet">' + (list.length ? list.map(tile).join('') : '<div class="hc-none serif"><i>None in Home Assistant</i></div>') + '</div>' +
      '<div class="sheet-actions">' + (kind === 'lights' ? '<button class="btn btn--solid" data-alloff>Turn everything off</button>' : '<button class="btn btn--solid" data-lockall>Lock all doors</button>') + '</div></div>', {
      cls: 'sheet--wide',
      onClose: function () { V.sheetBox = null; },
      onMount: function (s, close) {
        var box = s.querySelector('.tiles--sheet');
        V.sheetBox = box;
        bindTiles(box);
        var off = s.querySelector('[data-alloff]'), lk = s.querySelector('[data-lockall]');
        if (off) off.onclick = function () {
          var on = D.devices.filter(function (d) { return d.type === 'light' && d.on; });
          close();
          if (!on.length) return;
          App.ha.call('light', 'turn_off', { entity_id: on.map(function (d) { return d.id; }) }).then(function () {
            App.toast('Turned off ' + on.length + ' lights', { icon: 'bulb' });
          }, function (err) { fail('the lights', err); });
        };
        if (lk) lk.onclick = function () {
          var open = D.devices.filter(function (d) { return d.type === 'lock' && !d.locked; });
          close();
          if (!open.length) return App.toast('All doors are already locked', { icon: 'lock' });
          App.ha.call('lock', 'lock', { entity_id: open.map(function (d) { return d.id; }) }).then(function () {
            App.toast('Locking ' + open.length + (open.length === 1 ? ' door' : ' doors'), { icon: 'lock' });
          }, function (err) { fail('the locks', err); });
        };
      }
    });
  }

  function applyScene(id) {
    var s = D.scenes.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    V.scene = id;
    paintPart('.hc-scenes', scenes());
    App.ha.call('scene', 'turn_on', { entity_id: id }).then(function () {
      App.toast('<b>' + App.esc(s.name) + '</b> scene on', { icon: s.icon });
    }, function (err) { V.scene = null; paintPart('.hc-scenes', scenes()); fail(s.name, err); });
  }

  function setTemp(delta) {
    var c = D.climate;
    if (!c || c.set == null) return;
    var next = Math.max(c.min, Math.min(c.max, Math.round((c.set + delta * c.step) * 10) / 10));
    if (c.range && c.high != null) c.high = Math.round((c.high + (next - c.set)) * 10) / 10;
    c.set = next;
    climateChanged();
    // Debounce taps into one service call
    clearTimeout(V.tempTimer);
    V.tempTimer = setTimeout(function () {
      V.tempTimer = null;
      var data = { entity_id: c.id };
      if (c.range) { data.target_temp_low = c.set; data.target_temp_high = c.high; } else data.temperature = c.set;
      App.ha.call('climate', 'set_temperature', data).catch(function (err) { fail(c.name, err); });
    }, 800);
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-ha-login]'))) return App.ha.login();
    if ((t = e.target.closest('[data-ha-retry]'))) return App.ha.retry();
    if ((t = e.target.closest('[data-scene]'))) return applyScene(t.dataset.scene);
    if ((t = e.target.closest('[data-sum]'))) {
      var k = t.dataset.sum;
      if (k === 'lights' || k === 'security') return listSheet(k);
      var target = V.el.querySelector(k === 'climate' ? '.hc-climate' : '.hc-media');
      target.classList.add('is-pulse'); setTimeout(function () { target.classList.remove('is-pulse'); }, 900);
      return;
    }
    if ((t = e.target.closest('[data-temp]'))) return setTemp(+t.dataset.temp);
    if ((t = e.target.closest('[data-tmode]'))) {
      var c = D.climate, mode = t.dataset.tmode;
      c.mode = mode;
      climateChanged();
      return App.ha.call('climate', 'set_hvac_mode', { entity_id: c.id, hvac_mode: mode }).catch(function (err) { fail(c.name, err); });
    }
    if ((t = e.target.closest('[data-cam]'))) return App.cameraSheet(D.cameras.filter(function (c) { return c.id === t.dataset.cam; })[0]);
    var m = D.media;
    if ((t = e.target.closest('[data-play]')) && m) {
      m.playing = !m.playing;
      paintPart('.hc-media', media()); paintPart('.hc-sum', summary());
      return App.ha.call('media_player', 'media_play_pause', { entity_id: m.id }).catch(function (err) { fail(m.room, err); });
    }
    if ((t = e.target.closest('[data-vol]')) && m && m.volume != null) {
      m.volume = Math.max(0, Math.min(100, m.volume + +t.dataset.vol));
      App.toast('Volume ' + m.volume + '%', { icon: 'music', ms: 1200 });
      return App.ha.call('media_player', 'volume_set', { entity_id: m.id, volume_level: m.volume / 100 }).catch(function (err) { fail(m.room, err); });
    }
  }
  function climateChanged() { paintPart('.hc-climate', climate()); paintPart('.hc-sum', summary()); App.emit('ha'); }

  function camTimer() {
    clearInterval(V.camTimer);
    if (!D.cameras.length) return;
    V.camTimer = setInterval(function () {
      V.camAge++;
      if (V.camAge >= 20) { V.camAge = 0; paintPart('.hc-cams', cams()); return; }
      App.$$('.cam-age', V.el).forEach(function (a) { a.textContent = V.camAge + 's ago'; });
    }, 1000);
  }

  // Live Home Assistant updates: rebuild on structural changes, else repaint only what moved.
  var lastStatus = '', keys = {};
  App.on('ha', function () {
    if (!V.el) return;
    var st = D.status.ha.state + D.status.ha.message;
    if (st !== lastStatus || D.status.ha.state !== 'ok' || !V.el.querySelector('.hc')) {
      lastStatus = st;
      if (App.current === 'control' || D.status.ha.state !== 'ok') { layout(); camTimer(); keys = {}; }
      return;
    }
    if (structure() !== V.sig) { paint(); keys = {}; return; }
    D.devices.forEach(function (d) {
      var k = tileKey(d);
      if (keys[d.id] !== undefined && keys[d.id] !== k) { if (V.pending[d.id]) delete V.pending[d.id]; paintTile(d.id); }
      keys[d.id] = k;
    });
    paintPart('.hc-sum', summary());
    if (!V.el.querySelector('.hc-climate').contains(document.activeElement) && !V.tempTimer) paintPart('.hc-climate', climate());
    paintPart('.hc-media', media());
  });

  App.register('control', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      lastStatus = D.status.ha.state + D.status.ha.message;
      layout();
      camTimer();
    },
    resume: function () { camTimer(); },
    hide: function () { clearInterval(V.camTimer); }
  });
})();
