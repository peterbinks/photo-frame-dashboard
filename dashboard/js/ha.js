// Home Assistant, straight from the frame to the LAN (the Worker can't reach it).
// OAuth login via home-assistant-js-websocket's getAuth; tokens live in localStorage. Areas +
// device/entity registries map entities onto the control view's rooms/devices; live updates come
// from subscribeEntities. Nothing here blocks the rest of the app.
import {
  getAuth, createConnection, createLongLivedTokenAuth, subscribeEntities, callService,
  ERR_INVALID_AUTH,
} from 'home-assistant-js-websocket';

var D = window.DATA;
var TOKENS = 'hq-ha-tokens';
var HA = { conn: null, url: '', entities: {}, areas: {}, areaOrder: [], deviceArea: {}, reg: {}, retry: null };

function loadTokens() { try { return JSON.parse(localStorage.getItem(TOKENS)); } catch (e) { return null; } }
function saveTokens(t) { try { if (t) localStorage.setItem(TOKENS, JSON.stringify(t)); else localStorage.removeItem(TOKENS); } catch (e) { /* storage full/disabled */ } }

function setStatus(state, message) {
  D.status.ha = { state: state, message: message || '' };
  App.emit('ha');
}

// The library refuses token requests from an https page to an http Home Assistant (a browser
// mixed-content guard). The kiosk WebView allows mixed content, so we make those two calls here.
function CorsError() {}
function tokenRequest(hassUrl, clientId, data) {
  var body = new URLSearchParams(Object.assign({ client_id: clientId }, data));
  return fetch(hassUrl + '/auth/token', { method: 'POST', body: body }).then(function (res) {
    if (res.status === 400 || res.status === 403) throw ERR_INVALID_AUTH;
    if (!res.ok) throw new Error('Home Assistant token request failed (' + res.status + ')');
    return res.json();
  }, function () { throw new CorsError(); }).then(function (t) {
    t.hassUrl = hassUrl;
    t.clientId = clientId;
    t.expires = Date.now() + t.expires_in * 1000;
    return t;
  });
}
function withRefresh(auth) {
  auth.refreshAccessToken = function () {
    var self = this;
    return tokenRequest(self.data.hassUrl, self.data.clientId, { grant_type: 'refresh_token', refresh_token: self.data.refresh_token }).then(function (d) {
      d.refresh_token = self.data.refresh_token;
      self.data = d;
      saveTokens(d);
    });
  };
  return auth;
}

// Back from the Home Assistant login page: ?auth_callback=1&code=…&state=…
var RETURN = 'hq-ha-return';
var loggingIn = false;
var callback = (function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('auth_callback')) return null;
  var code = q.get('code'), state = null, back = 'control';
  try { state = JSON.parse(atob(q.get('state'))); } catch (e) { /* bad state */ }
  try { back = sessionStorage.getItem(RETURN) || back; sessionStorage.removeItem(RETURN); } catch (e) { /* storage off */ }
  ['auth_callback', 'code', 'state'].forEach(function (k) { q.delete(k); });
  var rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + '#' + back);
  if (!code || !state || !state.hassUrl) return Promise.reject(new Error('Home Assistant login was cancelled'));
  loggingIn = true;
  return tokenRequest(state.hassUrl, state.clientId, { grant_type: 'authorization_code', code: code }).then(function (t) { saveTokens(t); })
    .finally(function () { loggingIn = false; });
})();

// The token request failed at the network level: Home Assistant unreachable from this screen, or
// (older Home Assistant versions) a CORS block on /auth/token.
function corsHelp() {
  return 'Couldn’t finish signing in: this screen can’t reach ' + (HA.url || D.config.haUrl) + '/auth/token.\n' +
    'Check the frame is on the home Wi-Fi. If it is, add this to Home Assistant’s configuration.yaml and restart it:\n\n' +
    'http:\n  cors_allowed_origins:\n    - ' + location.origin;
}

App.ha = {
  login: function () {
    // Redirects to Home Assistant's login page; it sends us back with ?auth_callback=1
    loggingIn = true;
    try { sessionStorage.setItem(RETURN, App.current || 'control'); } catch (e) { /* storage off */ }
    getAuth({ hassUrl: HA.url || D.config.haUrl, saveTokens: saveTokens, loadTokens: function () { return Promise.resolve(null); }, redirectUrl: location.origin + location.pathname });
  },
  // Forget this screen's sign-in (stored tokens) and disconnect.
  logout: function () { saveTokens(null); if (HA.conn) HA.conn.close(); HA.conn = null; setStatus('off'); },
  retry: function () { connect(); },
  /** True while a Home Assistant sign-in is in progress (don't reload the page then). */
  loggingIn: function () { return loggingIn; },
  signedIn: function () { var t = loadTokens(); return !!(t && t.hassUrl === HA.url); },
  call: function (domain, service, data) {
    if (!HA.conn) return Promise.reject(new Error('Home Assistant is not connected'));
    return callService(HA.conn, domain, service, data);
  },
  cameraSrc: function (c) {
    return HA.url + '/api/camera_proxy/' + encodeURIComponent(c.id) + '?token=' + encodeURIComponent(c.token || '') + '&_=' + Date.now();
  }
};

function connect() {
  clearTimeout(HA.retry);
  var cfg = D.config;
  HA.url = String(cfg.haUrl || '').replace(/\/+$/, '');
  var t = loadTokens(), authP;
  if (!HA.url) {
    setStatus('off', 'Add your Home Assistant address in Settings → Home Assistant.');
    return;
  }
  if (t && t.hassUrl === HA.url) {
    authP = getAuth({ hassUrl: HA.url, saveTokens: saveTokens, loadTokens: function () { return Promise.resolve(t); } }).then(withRefresh);
  } else if (cfg.haToken) {
    authP = Promise.resolve(createLongLivedTokenAuth(HA.url, cfg.haToken));
  } else {
    setStatus('off');
    return;
  }
  setStatus('connecting');
  authP.then(function (auth) { return createConnection({ auth: auth }); }).then(onConnected, onError);
}

function onError(err) {
  if (err === ERR_INVALID_AUTH) { saveTokens(null); setStatus('off', 'Your Home Assistant login expired — connect again.'); return; }
  if (err instanceof CorsError) { setStatus('error', corsHelp()); return; }
  setStatus('error', 'Can’t reach Home Assistant at ' + HA.url + '. Retrying every minute.');
  HA.retry = setTimeout(connect, 60000);
}

function onConnected(conn) {
  HA.conn = conn;
  conn.addEventListener('ready', function () { loadRegistries().then(function () { setStatus('ok'); scheduleBuild(); }); });
  conn.addEventListener('disconnected', function () { setStatus('connecting', 'Reconnecting to Home Assistant…'); });
  conn.addEventListener('reconnect-error', function (c, err) {
    if (err === ERR_INVALID_AUTH) { saveTokens(null); conn.close(); HA.conn = null; setStatus('off', 'Your Home Assistant login expired — connect again.'); }
  });
  loadRegistries().then(function () {
    subscribeEntities(conn, function (ents) { HA.entities = ents; scheduleBuild(); });
  });
}

function loadRegistries() {
  var c = HA.conn;
  function ask(type) { return c.sendMessagePromise({ type: type }).catch(function () { return null; }); }
  return Promise.all([ask('config/area_registry/list'), ask('config/device_registry/list'), ask('config/entity_registry/list')]).then(function (r) {
    HA.areas = {};
    HA.areaOrder = [];
    (r[0] || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (a) { HA.areas[a.area_id] = a.name; HA.areaOrder.push(a.area_id); });
    HA.deviceArea = {};
    (r[1] || []).forEach(function (d) { if (d.area_id) HA.deviceArea[d.id] = d.area_id; });
    HA.reg = {};
    (r[2] || []).forEach(function (e) {
      HA.reg[e.entity_id] = { area: e.area_id || HA.deviceArea[e.device_id] || null, skip: !!(e.entity_category || e.hidden_by || e.disabled_by) };
    });
  });
}

// ------------------------------------------------------------------ entities → view model
var buildTimer = null;
function scheduleBuild() { if (!buildTimer) buildTimer = setTimeout(function () { buildTimer = null; build(); }, 300); }

var SCENE_ICONS = [[/morn|wake|sunrise/i, 'sunrise'], [/dinner|eat|meal|kitchen/i, 'utensils'], [/movie|tv|film|cinema/i, 'film'], [/away|leave|vacation/i, 'away'], [/night|sleep|bed/i, 'moon']];
function sceneIcon(name) { for (var i = 0; i < SCENE_ICONS.length; i++) if (SCENE_ICONS[i][0].test(name)) return SCENE_ICONS[i][1]; return 'bolt'; }
function shortName(name, room) {
  var r = HA.areas[room];
  if (r && name.toLowerCase().indexOf(r.toLowerCase() + ' ') === 0 && name.length > r.length + 1) name = name.slice(r.length + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function build() {
  var E = HA.entities, list = [], climates = [], players = [], cameras = [], scenes = [];
  Object.keys(E).sort().forEach(function (id) {
    var s = E[id], a = s.attributes || {}, dom = id.split('.')[0], reg = HA.reg[id] || {};
    if (reg.skip) return;
    var room = reg.area || 'other', name = shortName(a.friendly_name || id, room), off = s.state === 'unavailable' || s.state === 'unknown';
    var base = { id: id, room: room, name: name, unavailable: off };
    if (dom === 'light') {
      var modes = a.supported_color_modes || [];
      var dim = modes.length ? !(modes.length === 1 && modes[0] === 'onoff') : a.brightness != null;
      list.push(Object.assign(base, { type: 'light', on: s.state === 'on', dim: dim, level: a.brightness != null ? Math.max(1, Math.round(a.brightness / 2.55)) : 100 }));
    } else if (dom === 'switch' || dom === 'fan' || dom === 'input_boolean') {
      list.push(Object.assign(base, { type: 'switch', kind: dom === 'fan' ? 'fan' : 'power', on: s.state === 'on' }));
    } else if (dom === 'cover') {
      if (a.device_class === 'garage' || a.device_class === 'gate') list.push(Object.assign(base, { type: 'garage', state: off ? 'closed' : s.state }));
      else list.push(Object.assign(base, { type: 'blind', pos: a.current_position != null ? a.current_position : s.state === 'closed' ? 0 : 100, canPos: !!((a.supported_features || 0) & 4) }));
    } else if (dom === 'lock') {
      list.push(Object.assign(base, { type: 'lock', locked: s.state === 'locked' || s.state === 'locking' }));
    } else if (dom === 'climate' && !off) {
      climates.push(s);
    } else if (dom === 'media_player' && !off) {
      players.push(s);
    } else if (dom === 'camera' && !off) {
      cameras.push({ id: id, name: name, token: a.access_token });
    } else if (dom === 'scene') {
      scenes.push({ id: id, name: name, icon: sceneIcon(name) });
    } else if (dom === 'person') {
      presence(a.friendly_name || id, s.state);
    }
  });

  // Keep object identity for devices the view already holds (tiles keep references).
  var prev = {};
  D.devices.forEach(function (d) { prev[d.id] = d; });
  D.devices = list.map(function (d) { var p = prev[d.id]; return p ? Object.assign(p, d) : d; });
  var used = {};
  D.devices.forEach(function (d) { used[d.room] = true; });
  D.rooms = HA.areaOrder.filter(function (r) { return used[r]; }).map(function (r) { return { id: r, name: HA.areas[r] }; });
  if (used.other) D.rooms.push({ id: 'other', name: D.rooms.length ? 'Other' : 'Devices' });

  var c = climates[0];
  if (c) {
    var ca = c.attributes, range = ca.temperature == null && ca.target_temp_low != null;
    D.climate = {
      id: c.entity_id, name: ca.friendly_name || 'Thermostat',
      current: ca.current_temperature != null ? Math.round(ca.current_temperature * 10) / 10 : null,
      set: range ? ca.target_temp_low : ca.temperature, high: range ? ca.target_temp_high : null, range: range,
      mode: c.state, action: ca.hvac_action || null, humidity: ca.current_humidity != null ? Math.round(ca.current_humidity) : null,
      modes: ca.hvac_modes || [], step: ca.target_temp_step || (D.config.units === 'fahrenheit' ? 1 : 0.5),
      min: ca.min_temp != null ? ca.min_temp : 7, max: ca.max_temp != null ? ca.max_temp : 35
    };
  } else D.climate = null;

  var m = players.filter(function (p) { return p.state === 'playing'; })[0] || players.filter(function (p) { return p.state !== 'off' && p.state !== 'standby'; })[0] || players[0];
  if (m) {
    var ma = m.attributes, reg = HA.reg[m.entity_id] || {};
    D.media = {
      id: m.entity_id, room: HA.areas[reg.area] || ma.friendly_name || 'Speaker',
      title: ma.media_title || (m.state === 'playing' ? 'Playing' : m.state === 'off' ? 'Off' : 'Nothing playing'),
      artist: ma.media_artist || ma.media_album_name || ma.app_name || ma.friendly_name || '',
      playing: m.state === 'playing', volume: ma.volume_level != null ? Math.round(ma.volume_level * 100) : null,
      art: ma.entity_picture ? (/^https?:/.test(ma.entity_picture) ? ma.entity_picture : HA.url + ma.entity_picture) : null
    };
  } else D.media = null;

  D.cameras = cameras;
  D.scenes = scenes;
  if (D.status.ha.state !== 'ok' && HA.conn && HA.conn.connected) D.status.ha = { state: 'ok' };
  App.emit('ha');
}

// person.* → family presence (matched by first name)
function presence(name, state) {
  var n = String(name).toLowerCase(), first = n.split(/\s+/)[0];
  D.people.forEach(function (p) {
    var pn = p.name.toLowerCase();
    if (pn !== n && pn !== first) return;
    p.home = state === 'home';
    p.status = state === 'home' ? 'Home' : state === 'not_home' ? 'Away' : state === 'unknown' || state === 'unavailable' ? '' : state.charAt(0).toUpperCase() + state.slice(1);
    if (state === 'unknown' || state === 'unavailable') p.home = null;
  });
}

App.on('ready', function () {
  if (callback) {
    setStatus('connecting');
    callback.then(connect, function (err) {
      if (err instanceof CorsError) setStatus('error', corsHelp());
      else setStatus('off', err === ERR_INVALID_AUTH ? 'Home Assistant rejected the login — try again.' : String(err.message || err));
    });
  } else connect();
});

// Settings changed: a new Home Assistant address means a new connection; renamed people need
// their presence matched again.
App.on('config', function () {
  if (String(D.config.haUrl || '').replace(/\/+$/, '') !== HA.url) {
    if (HA.conn) HA.conn.close();
    HA.conn = null;
    connect();
  } else if (HA.conn) scheduleBuild();
});
