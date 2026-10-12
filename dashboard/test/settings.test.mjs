// Settings document: validation, seeding from the old env vars, member removal, rev conflicts,
// ?fresh=1 throttling and the client's reload decision. Worker tests run the real fetch handler
// against an in-memory KV and a stubbed network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, seedSettings, removedIds, icsSummary, mapPlaces, mapZip, PALETTE } from '../src/settings.js';
import { readFileSync } from 'node:fs';
import { wallToEpoch } from '../src/time.js';
import { purgeMembers } from '../src/state.js';
import { createThrottle } from '../src/fresh.js';
import { reloadDecision, QUIET_MS } from '../js/reload-policy.js';

const ICS_URL = 'https://calendar.google.com/calendar/ical/family%40group.calendar.google.com/private-abc/basic.ics';
const ALBUM = 'https://photos.icloud.com/shared/album/0SyntheticAlbumId_Example';
const ENV = {
  FAMILY: JSON.stringify([
    { id: 'alex', name: 'Alex', color: '#2D5BFF', kid: false },
    { id: 'jordan', name: 'Jordan', color: '#E4007C', kid: false },
    { id: 'sam', name: 'Sam', color: '#00A36C', kid: true },
  ]),
  GCAL_ICS: JSON.stringify([
    { url: ICS_URL.replace('https://', 'webcal://'), name: 'Family', people: ['alex', 'jordan', 'sam'] },
    { url: 'https://example.com/work.ics', name: 'Work', people: ['alex', 'ghost'] },
    { url: 'http://insecure.example.com/x.ics', name: 'Dropped' },
  ]),
  ICLOUD_ALBUMS: JSON.stringify([ALBUM, 'not a link']),
  LAT: '41.85', LON: '-87.65', CITY: 'Chicago', UNITS: 'fahrenheit', HA_URL: 'http://192.168.1.200:8123/', TZ: 'America/Chicago',
};

const seeded = () => seedSettings(ENV, {}, 1000);

test('seeding migrates the deploy-time vars and secrets', () => {
  const d = seeded();
  assert.equal(d.rev, 1);
  assert.deepEqual(d.family.map((m) => [m.id, m.name, m.color, m.kid]), [['alex', 'Alex', '#2D5BFF', false], ['jordan', 'Jordan', '#E4007C', false], ['sam', 'Sam', '#00A36C', true]]);
  assert.deepEqual(d.usedIds, ['alex', 'jordan', 'sam']);
  assert.equal(d.calendars.length, 2); // the http:// one is dropped
  assert.equal(d.calendars[0].url, ICS_URL); // webcal → https
  assert.deepEqual(d.calendars[0].people, []); // everyone
  assert.deepEqual(d.calendars[1].people, ['alex']); // unknown ids dropped
  assert.match(d.calendars[0].id, /^c[a-z0-9]+$/);
  assert.deepEqual(d.albums.map((a) => a.url), [ALBUM]);
  assert.deepEqual(d.location, { city: 'Chicago', lat: 41.85, lon: -87.65 });
  assert.equal(d.units, 'fahrenheit');
  assert.equal(d.haUrl, 'http://192.168.1.200:8123');
  assert.deepEqual([d.clock24, d.nightFrom, d.nightTo, d.idleMinutes, d.slideSeconds], [false, 22, 6, 2, 15]);
  assert.deepEqual(seedSettings(ENV, {}, 1000), d, 'deterministic, so concurrent seeds agree');
  // No location vars → automatic; units from the visitor's country
  const bare = seedSettings({ FAMILY: '[]' }, { country: 'US' });
  assert.equal(bare.location, null);
  assert.equal(bare.units, 'fahrenheit');
  assert.deepEqual([bare.family, bare.calendars, bare.albums, bare.haUrl], [[], [], [], '']);
  // A seeded document passes its own validation unchanged
  const same = applySettings({ ...d }, d);
  assert.equal(same.error, undefined);
  assert.deepEqual(same.doc, d);
});

test('validation rejects bad input with a readable reason', () => {
  const d = seeded();
  const bad = (body, re) => { const r = applySettings({ rev: d.rev, ...body }, d); assert.ok(r.error, JSON.stringify(body) + ' should fail'); assert.match(r.error, re); };
  bad({ junk: 1 }, /Unknown field: junk/);
  assert.match(applySettings({ units: 'celsius' }, d).error, /rev/);
  assert.match(applySettings([1], d).error, /object/);
  bad({ family: [{ name: '' }] }, /empty/);
  bad({ family: [{ name: 'x'.repeat(25) }] }, /too long/);
  bad({ family: [{ name: '<b>Pat</b>' }] }, /can’t contain/);
  bad({ family: [{ name: 'Pat', color: 'red' }] }, /colour/);
  bad({ family: [{ name: 'Pat', kid: 'yes' }] }, /true or false/);
  bad({ family: [{ name: 'Pat', nickname: 'P' }] }, /Unknown field/);
  bad({ family: [{ name: 'Pat' }, { name: 'pat' }] }, /both be called/);
  bad({ family: [{ id: 'zed', name: 'Zed' }] }, /isn’t in the family/);
  bad({ family: Array.from({ length: 7 }, (_, i) => ({ name: 'P' + i })) }, /At most 6/);
  const cal = (c) => ({ calendars: [{ url: ICS_URL, name: 'Family', ...c }] });
  bad(cal({ url: 'http://example.com/a.ics' }), /https/);
  bad(cal({ url: 'ftp://example.com/a.ics' }), /https/);
  bad(cal({ url: 'https://192.168.1.5/a.ics' }), /public/);
  bad(cal({ url: 'https://localhost/a.ics' }), /public/);
  bad(cal({ url: 'https://user:pw@example.com/a.ics' }), /password/);
  bad(cal({ url: 'not a url' }), /isn’t a link/);
  bad(cal({ people: ['nobody'] }), /unknown person/);
  bad(cal({ color: '#12345' }), /colour/);
  bad({ calendars: [{ url: ICS_URL, name: 'A' }, { url: ICS_URL, name: 'B' }] }, /already/);
  bad({ albums: [{ url: 'https://example.com/album' }] }, /iCloud shared album/);
  bad({ albums: [{ url: ALBUM }, { url: ALBUM + '/' }] }, /already/);
  bad({ location: { city: 'X', lat: 91, lon: 0 } }, /Latitude/);
  bad({ location: { lat: 1, lon: 2, zoom: 3 } }, /Unknown location field/);
  bad({ units: 'kelvin' }, /fahrenheit or celsius/);
  bad({ clock24: 1 }, /true or false/);
  bad({ nightFrom: 24 }, /0 to 23/);
  bad({ idleMinutes: 1.5 }, /whole number/);
  bad({ slideSeconds: 2 }, /5 to 300/);
  bad({ haUrl: 'ftp://ha.local' }, /http/);
  bad({ haUrl: 'http://ha.local:8123/?x=1' }, /just the address/);
});

test('valid edits: renames keep ids, new ids are unique slugs never reused', () => {
  const d = seeded();
  let r = applySettings({ rev: 1, family: [{ id: 'alex', name: 'Al', color: '#7B3FE4' }, { id: 'sam', name: 'Sam', kid: true }] }, d);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.doc.family.map((m) => m.id), ['alex', 'sam']);
  assert.equal(r.doc.family[0].name, 'Al');
  assert.deepEqual(removedIds(r.doc), ['jordan']);
  // Jordan leaves, and someone new called Jordan joins: a different id
  r = applySettings({ rev: 2, family: r.doc.family.concat([{ name: 'Jordan' }, { name: 'Alex' }]) }, r.doc);
  assert.deepEqual(r.doc.family.map((m) => m.id), ['alex', 'sam', 'jordan-2', 'alex-2']);
  assert.equal(r.doc.family[2].color, PALETTE[2]);
  // Calendars: webcal accepted, all people = everyone, ids assigned
  r = applySettings({ rev: 3, calendars: [{ url: ICS_URL.replace('https', 'webcal'), name: 'Fam', people: ['alex', 'sam', 'jordan-2', 'alex-2'] }], albums: [{ url: ALBUM, name: 'Home Frame' }], units: 'celsius', clock24: true, location: null, haUrl: '' }, r.doc);
  assert.equal(r.error, undefined);
  assert.equal(r.doc.calendars[0].url, ICS_URL);
  assert.deepEqual(r.doc.calendars[0].people, []);
  assert.match(r.doc.calendars[0].id, /^c/);
  assert.deepEqual(r.doc.albums, [{ id: r.doc.albums[0].id, url: ALBUM, name: 'Home Frame' }]);
  assert.deepEqual([r.doc.units, r.doc.clock24, r.doc.location, r.doc.haUrl], ['celsius', true, null, '']);
});

test('removing someone drops them from calendars, and from chores/stars/week in state', () => {
  const d = seeded();
  d.calendars[1].people = ['alex', 'sam'];
  const r = applySettings({ rev: 1, family: d.family.filter((m) => m.id !== 'sam') }, d);
  assert.deepEqual(r.doc.calendars[1].people, ['alex']);
  const r2 = applySettings({ rev: 2, family: [r.doc.family[0]] }, { ...r.doc, rev: 2 });
  assert.deepEqual(r2.doc.calendars[1].people, [], 'only-person removed → everyone');

  const state = {
    chores: [{ id: 'c1', who: 'sam', done: true, doneBy: 'sam' }, { id: 'c2', who: 'any', doneBy: 'sam' }, { id: 'c3', who: 'alex' }],
    stars: { sam: 7 }, week: { sam: [1, 0, null, null, null, null, null] },
    events: [{ id: 'e1', people: ['sam'] }, { id: 'e2', people: ['alex', 'sam'] }],
  };
  assert.equal(purgeMembers(state, ['sam'], ['alex', 'jordan']), true);
  assert.deepEqual(state.chores.map((c) => [c.who, c.doneBy]), [['any', undefined], ['any', undefined], ['alex', undefined]]);
  assert.deepEqual([state.stars, state.week], [{}, {}]);
  assert.deepEqual(state.events.map((e) => e.people), [['alex', 'jordan'], ['alex']]);
  assert.equal(purgeMembers(state, ['sam'], ['alex', 'jordan']), false, 'idempotent');
});

test('cheap link-check helpers', () => {
  const ics = 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Family\\, home\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR';
  assert.deepEqual(icsSummary(ics), { events: 2, name: 'Family, home' });
  assert.equal(icsSummary('<html>sign in</html>'), null);
  assert.deepEqual(mapPlaces({ results: [{ name: 'Chicago', admin1: 'Illinois', country: 'United States', latitude: 41.85003, longitude: -87.65005, timezone: 'America/Chicago' }] }),
    [{ name: 'Chicago', region: 'Illinois, United States', lat: 41.85, lon: -87.65, tz: 'America/Chicago' }]);
});

test('fresh throttle: once per window per source', () => {
  const allow = createThrottle(20000);
  assert.equal(allow('calendar', 0), true);
  assert.equal(allow('calendar', 5000), false);
  assert.equal(allow('photos', 5000), true);
  assert.equal(allow('calendar', 20000), true);
});

test('version check: reload only for a new build at a quiet moment', () => {
  const quiet = { current: 'aaa', latest: 'bbb', now: 10 * QUIET_MS, lastTouch: 0, sheetOpen: false, typing: false, haLogin: false, takeover: false };
  assert.equal(reloadDecision(quiet), 'reload');
  assert.equal(reloadDecision({ ...quiet, latest: 'aaa' }), 'none');
  assert.equal(reloadDecision({ ...quiet, latest: null }), 'none');
  assert.equal(reloadDecision({ ...quiet, latest: '' }), 'none');
  assert.equal(reloadDecision({ ...quiet, current: 'dev' }), 'none');
  assert.equal(reloadDecision({ ...quiet, lastTouch: quiet.now - QUIET_MS + 1000 }), 'wait');
  assert.equal(reloadDecision({ ...quiet, sheetOpen: true }), 'wait');
  assert.equal(reloadDecision({ ...quiet, typing: true }), 'wait');
  assert.equal(reloadDecision({ ...quiet, haLogin: true }), 'wait');
  assert.equal(reloadDecision({ ...quiet, takeover: true }), 'wait');
});

// ------------------------------------------------------------------ the Worker, end to end
if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) => {
    const x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    let d = 0;
    for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
    return d === 0;
  };
}
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

let instance = 0;
async function harness(envExtra = {}, route = null) {
  const worker = (await import('../src/worker.js?i=' + ++instance)).default; // fresh module = fresh memory caches
  const kv = new Map();
  const env = {
    ...ENV, ACCESS_KEY: 'secret', ...envExtra,
    STATE: {
      get: async (k, o) => { const v = kv.get(k); return v == null ? null : o && o.type === 'json' ? JSON.parse(v) : v; },
      put: async (k, v) => { kv.set(k, v); },
    },
    ASSETS: { fetch: async () => new Response('<html><head><meta name="hq-build" content="b123"></head></html>') },
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const routed = route && (await route(u));
    if (routed) return routed;
    if (u.startsWith('https://api.open-meteo.com/')) return Response.json({ hourly: { time: [], temperature_2m: [], weather_code: [], is_day: [], precipitation_probability: [] }, current: {}, daily: {} });
    if (u.startsWith('https://geocoding-api.open-meteo.com/')) return Response.json({ results: [{ name: 'Chicago', admin1: 'Illinois', country: 'United States', latitude: 41.85, longitude: -87.65 }] });
    if (u.includes('.ics')) return new Response('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR');
    return new Response('nope', { status: 404 });
  };
  const call = async (path, opts = {}) => {
    const headers = { Authorization: 'Bearer secret', ...(opts.headers || {}) };
    if (opts.noKey) delete headers.Authorization;
    const res = await worker.fetch(new Request('https://hq.example' + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined }), env, { waitUntil() {} });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return { call, kv, calls, env };
}

test('worker: 401 without the key; first request seeds settings; config hides links', async () => {
  const h = await harness();
  assert.equal((await h.call('/api/settings', { noKey: true })).status, 401);
  assert.equal((await h.call('/api/settings/check', { noKey: true, method: 'POST', body: { kind: 'city', value: 'x' } })).status, 401);
  assert.equal(h.kv.has('settings:v1'), false);
  const cfg = await h.call('/api/config');
  assert.equal(cfg.status, 200);
  assert.equal(h.kv.has('settings:v1'), true, 'seeded and persisted');
  assert.deepEqual(cfg.body.family.map((m) => m.id), ['alex', 'jordan', 'sam']);
  assert.deepEqual(cfg.body.calendars[0].people, ['alex', 'jordan', 'sam']);
  assert.equal(cfg.body.albums, 1);
  assert.equal(cfg.body.settingsRev, 1);
  assert.deepEqual(cfg.body.display, { clock24: false, nightFrom: 22, nightTo: 6, idleMinutes: 2, slideSeconds: 15 });
  const text = JSON.stringify(cfg.body);
  assert.ok(text.indexOf('calendar.google.com') < 0 && text.indexOf('photos.icloud.com') < 0 && text.indexOf('example.com') < 0, 'no calendar/album links in /api/config');
  const s = await h.call('/api/settings');
  assert.equal(s.body.calendars[0].url, ICS_URL);
  // Env changes after seeding are ignored
  h.env.FAMILY = '[]';
  assert.equal((await h.call('/api/settings')).body.family.length, 3);
  assert.equal((await h.call('/api/version')).body.version, 'b123');
});

test('worker: "reload all screens" reaches state polls without counting as a settings change', async () => {
  const h = await harness();
  const before = await h.call('/api/state');
  assert.equal(before.body.reloadAt, 0);
  assert.equal((await h.call('/api/reload', { noKey: true, method: 'POST' })).status, 401);
  assert.equal((await h.call('/api/reload')).status, 405);
  const r = await h.call('/api/reload', { method: 'POST' });
  assert.equal(r.status, 200);
  const after = await h.call('/api/state');
  assert.equal(after.body.reloadAt, r.body.reloadAt);
  assert.equal(after.body.settingsRev, before.body.settingsRev, 'rev unchanged: screens reload, not re-apply settings');
  // The Settings screen may send back the whole doc it fetched, reloadAt included; saving keeps working.
  const doc = (await h.call('/api/settings')).body;
  const put = await h.call('/api/settings', { method: 'PUT', body: { ...doc, units: 'celsius' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.reloadAt, r.body.reloadAt);
});

test('worker: PUT validates, bumps rev, 409s a stale rev, and removal updates state', async () => {
  const h = await harness();
  const st = await h.call('/api/state');
  assert.equal(st.body.settingsRev, 1);
  assert.ok(st.body.chores.some((c) => c.who === 'sam'));
  assert.equal(st.body.stars.sam, 0);

  assert.equal((await h.call('/api/settings', { method: 'PUT', body: { rev: 1, units: 'kelvin' } })).status, 400);
  assert.equal((await h.call('/api/settings', { method: 'PUT', body: { rev: 1, units: 'celsius', extra: true } })).status, 400);
  const ok = await h.call('/api/settings', { method: 'PUT', body: { rev: 1, units: 'celsius' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.rev, 2);
  const stale = await h.call('/api/settings', { method: 'PUT', body: { rev: 1, clock24: true } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.settings.rev, 2);
  assert.equal(stale.body.settings.units, 'celsius');

  // An old copy of the state (from before the removal) to save afterwards
  const old = st.body;
  const fam = ok.body.family.filter((m) => m.id !== 'sam');
  const rm = await h.call('/api/settings', { method: 'PUT', body: { rev: 2, family: fam } });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.body.usedIds, ['alex', 'jordan', 'sam']);
  const after = await h.call('/api/state');
  assert.ok(after.body.rev > old.rev, 'state rev bumped');
  assert.ok(!after.body.chores.some((c) => c.who === 'sam'));
  assert.equal(after.body.chores.filter((c) => c.who === 'any').length, old.chores.filter((c) => c.who === 'any' || c.who === 'sam').length);
  assert.equal(after.body.stars.sam, undefined);
  assert.equal(after.body.week.sam, undefined);
  assert.equal(after.body.settingsRev, 3);
  // A stale device saves state that still has Sam's chores: they still land on Anyone
  const put = await h.call('/api/state', { method: 'PUT', body: { rev: after.body.rev, chores: old.chores, stars: old.stars } });
  assert.equal(put.status, 200);
  assert.ok(!put.body.chores.some((c) => c.who === 'sam'));
  assert.equal(put.body.stars.sam, undefined);
  // Adding a new Sam gets a fresh id
  const add = await h.call('/api/settings', { method: 'PUT', body: { rev: 3, family: rm.body.family.concat([{ name: 'Sam', kid: true }]) } });
  assert.equal(add.body.family[2].id, 'sam-2');
});

test('worker: ?fresh=1 bypasses caches at most once per 20 s per source', async () => {
  const h = await harness();
  const wx = () => h.calls.filter((u) => u.startsWith('https://api.open-meteo.com/')).length;
  assert.equal((await h.call('/api/weather')).status, 200);
  assert.equal(wx(), 1);
  await h.call('/api/weather');
  assert.equal(wx(), 1, 'cached');
  const f1 = await h.call('/api/weather?fresh=1');
  assert.equal(f1.headers.get('X-Fresh'), 'ok');
  assert.equal(wx(), 2);
  const f2 = await h.call('/api/weather?fresh=1');
  assert.equal(f2.headers.get('X-Fresh'), 'throttled');
  assert.equal(wx(), 2, 'throttled: served from cache');
  const ics = () => h.calls.filter((u) => u.includes('.ics')).length;
  await h.call('/api/calendar');
  const before = ics();
  await h.call('/api/calendar');
  assert.equal(ics(), before, 'calendar cached');
  assert.equal((await h.call('/api/calendar?fresh=1')).headers.get('X-Fresh'), 'ok');
  assert.equal(ics(), before * 2, 'every feed refetched');
});

test('worker: link checks', async () => {
  const h = await harness();
  const c = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'calendar', value: 'webcal://example.com/a.ics' } });
  assert.deepEqual(c.body, { ok: true, url: 'https://example.com/a.ics', name: '', events: 1 });
  const bad = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'calendar', value: 'http://example.com/a.ics' } });
  assert.equal(bad.status, 400);
  const nf = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'calendar', value: 'https://example.com/missing' } });
  assert.equal(nf.body.ok, false);
  assert.match(nf.body.error, /404/);
  const city = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'city', value: 'Chicago' } });
  assert.equal(city.body.places[0].name, 'Chicago');
  assert.equal((await h.call('/api/settings/check', { method: 'POST', body: { kind: 'album', value: 'https://example.com' } })).status, 400);
  assert.equal((await h.call('/api/settings/check', { method: 'POST', body: { kind: 'nope', value: 'x' } })).status, 400);
});

const fixture = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));

test('worker: a 5-digit query is a US ZIP code (zippopotam.us), anything else a city name', async () => {
  const ZIP = fixture('zip-60601.json');
  assert.deepEqual(mapZip(ZIP, '60601'), [{ name: 'Chicago, IL 60601', region: 'Illinois, United States', lat: 41.8858, lon: -87.6181, tz: '' }]);
  assert.deepEqual(mapZip({}, '00000'), []);
  const h = await harness({}, (u) => {
    if (u === 'https://api.zippopotam.us/us/60601') return Response.json(ZIP);
    if (u.startsWith('https://api.zippopotam.us/')) return Response.json({}, { status: 404 });
  });
  const zip = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'city', value: ' 60601 ' } });
  assert.equal(zip.body.ok, true);
  assert.equal(zip.body.places[0].name, 'Chicago, IL 60601');
  assert.deepEqual([zip.body.places[0].lat, zip.body.places[0].lon], [41.8858, -87.6181]);
  const none = await h.call('/api/settings/check', { method: 'POST', body: { kind: 'city', value: '00000' } });
  assert.deepEqual(none.body, { ok: false, error: 'No US ZIP code 00000 found' });
  assert.equal(h.calls.filter((u) => u.startsWith('https://geocoding-api.open-meteo.com/')).length, 0);
  await h.call('/api/settings/check', { method: 'POST', body: { kind: 'city', value: '606018' } });
  assert.equal(h.calls.filter((u) => u.startsWith('https://geocoding-api.open-meteo.com/')).length, 1, 'not a ZIP: city search');
});

// api.weather.gov for the seeded location (41.85,-87.65 → LOT 75,72, KMDW), captured 2026-10-11
function nwsRoute(overrides = {}) {
  const routes = {
    '/points/41.85,-87.65': () => Response.json(fixture('nws-points.json')),
    '/gridpoints/LOT/75,72/stations': () => Response.json(fixture('nws-stations.json')),
    '/gridpoints/LOT/75,72/forecast/hourly': () => Response.json(fixture('nws-hourly.json')),
    '/gridpoints/LOT/75,72/forecast': () => Response.json(fixture('nws-forecast.json')),
    '/stations/KMDW/observations/latest': () => Response.json(fixture('nws-obs.json')),
    ...overrides,
  };
  return (u) => {
    if (!u.startsWith('https://api.weather.gov/')) return null;
    const r = routes[new URL(u).pathname];
    return r ? r() : Response.json({}, { status: 404 });
  };
}
async function atFixtureTime(fn) {
  const real = Date.now, t = wallToEpoch(2026, 10, 11, 14, 39, 0, 'America/Chicago');
  Date.now = () => t;
  try { return await fn(); } finally { Date.now = real; }
}
const nwsCalls = (h) => h.calls.filter((u) => u.startsWith('https://api.weather.gov/')).length;
const omCalls = (h) => h.calls.filter((u) => u.startsWith('https://api.open-meteo.com/')).length;

test('worker: weather from the National Weather Service, cached', () => atFixtureTime(async () => {
  const h = await harness({}, nwsRoute());
  const w = await h.call('/api/weather');
  assert.equal(w.status, 200);
  assert.deepEqual([w.body.source, w.body.station, w.body.now, w.body.t[14], w.body.hi, w.body.lo], ['nws', 'KMDW', 75, 71, 75, 63]);
  assert.equal(w.body.city, 'Chicago');
  assert.equal(nwsCalls(h), 5, 'points + stations + hourly + forecast + observation');
  assert.equal(omCalls(h), 0);
  await h.call('/api/weather');
  assert.equal(nwsCalls(h), 5, 'cached');
  assert.equal((await h.call('/api/weather?fresh=1')).body.source, 'nws');
  assert.equal(nwsCalls(h), 8, 'fresh: point from KV, 3 requests');
}));

test('worker: NWS 500, timeout or a non-US 404 → Open-Meteo', () => atFixtureTime(async () => {
  const fail = (res) => nwsRoute({ '/gridpoints/LOT/75,72/forecast/hourly': res });
  const timeout = () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  for (const route of [fail(() => new Response('', { status: 500 })), fail(timeout), nwsRoute({ '/points/41.85,-87.65': () => Response.json({}, { status: 404 }) })]) {
    const h = await harness({}, route);
    const w = await h.call('/api/weather');
    assert.equal(w.status, 200);
    assert.equal(w.body.source, 'open-meteo');
    assert.equal(w.body.station, undefined);
    assert.equal(omCalls(h), 1);
  }
  const h = await harness({}, nwsRoute({ '/points/41.85,-87.65': () => Response.json({}, { status: 404 }) }));
  await h.call('/api/weather');
  assert.equal(nwsCalls(h), 1);
  assert.equal((await h.call('/api/weather?fresh=1')).body.source, 'open-meteo');
  assert.equal(nwsCalls(h), 1, 'a non-US point is remembered');
  assert.equal(omCalls(h), 2);
}));
