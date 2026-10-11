// Home HQ Worker: access control + /api/* for the family dashboard. Static files come from ASSETS.
import { prefilterIcs, windowFromQuery, hashId } from './ics-filter.js';
import { fetchAlbum, fetchAssetUrls, fetchCloudAlbum, cloudPhotoUrl } from './icloud.js';
import { fetchWeather, mapWeather } from './weather.js';
import { STATE_KEY, seedState, normalize, purgeMembers, rollover, sanitize } from './state.js';
import { SETTINGS_KEY, seedSettings, applySettings, runtimeConfig, removedIds, cleanCalendarUrl, cleanAlbumUrl, icsSummary, mapPlaces } from './settings.js';
import { createThrottle } from './fresh.js';
import { isValidTz, dayKey } from './time.js';

const COOKIE = 'hq_key';
const COOKIE_MAX_AGE = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days
const ICS_TTL = 5 * 60;
const WEATHER_TTL = 15 * 60;
const ALBUM_TTL = 15 * 60;
const PHOTO_TTL = 30 * 24 * 3600;
const SETTINGS_MEMO_MS = 10 * 1000;
const CHECK_TIMEOUT_MS = 15000;
const CACHE_ORIGIN = 'https://cache.home-hq.internal/';

// ------------------------------------------------------------------ helpers
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
function parseJSON(s, fallback) {
  if (!s) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}
function errText(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'No answer within ' + CHECK_TIMEOUT_MS / 1000 + ' seconds';
  return String((e && e.message) || e);
}

// ------------------------------------------------------------------ access control
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(x, y);
}
function cookieValue(request, name) {
  const all = request.headers.get('Cookie') || '';
  for (const part of all.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) { try { return decodeURIComponent(part.slice(i + 1)); } catch { return null; } }
  }
  return null;
}
async function authorized(request, env) {
  if (!env.ACCESS_KEY) return false; // fail closed until the secret exists
  const auth = request.headers.get('Authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : cookieValue(request, COOKIE);
  return !!presented && safeEqual(presented, env.ACCESS_KEY);
}
// ?k=<key> on any page: remember it in a cookie and drop it from the URL. The browser keeps the
// #fragment across the redirect because Location has none.
async function keyRedirect(url, env) {
  const k = url.searchParams.get('k');
  url.searchParams.delete('k');
  const headers = new Headers({ Location: url.pathname + url.search, 'Cache-Control': 'no-store' });
  if (env.ACCESS_KEY && k && (await safeEqual(k, env.ACCESS_KEY))) {
    headers.append('Set-Cookie', COOKIE + '=' + encodeURIComponent(k) + '; Max-Age=' + COOKIE_MAX_AGE + '; Path=/; HttpOnly; Secure; SameSite=Lax');
  }
  return new Response(null, { status: 302, headers });
}

// ------------------------------------------------------------------ caching
// Layer 1: per-isolate memory. Layer 2: Cache API (per data centre). Producers run on a miss, or
// always when `force` (?fresh=1) — the fresh value then replaces both layers.
const memo = new Map();
const inflight = new Map();
function memoGet(key, ttlMs) {
  const e = memo.get(key);
  return e && Date.now() - e.at < ttlMs ? e.value : undefined;
}
function memoSet(key, value) {
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  memo.set(key, { at: Date.now(), value });
}
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
async function cached(key, ttl, ctx, force, type, producer) {
  const req = new Request(CACHE_ORIGIN + encodeURIComponent(key));
  if (!force) {
    const m = memoGet(key, ttl * 1000);
    if (m !== undefined) return m;
    const hit = await caches.default.match(req);
    if (hit) { const v = type === 'json' ? await hit.json() : await hit.text(); memoSet(key, v); return v; }
  }
  return once(key, async () => {
    const v = await producer();
    memoSet(key, v);
    const body = type === 'json' ? JSON.stringify(v) : v;
    ctx.waitUntil(caches.default.put(req, new Response(body, { headers: { 'Cache-Control': 'max-age=' + ttl, 'Content-Type': type === 'json' ? 'application/json' : 'text/plain' } })));
    return v;
  });
}

// ?fresh=1 → { force, header } (force is false when the source was refreshed < 20 s ago)
const freshAllowed = createThrottle();
function freshness(url, source) {
  if (url.searchParams.get('fresh') !== '1') return { force: false, headers: {} };
  const force = freshAllowed(source);
  return { force, headers: { 'X-Fresh': force ? 'ok' : 'throttled' } };
}

// ------------------------------------------------------------------ settings
const tzOf = (env) => (isValidTz(env.TZ) ? env.TZ : 'America/Chicago');

/**
 * The settings document. The first request after this feature ships finds none and seeds it from
 * the old vars/secrets (FAMILY, GCAL_ICS, ICLOUD_ALBUMS, LAT/LON/CITY, UNITS, HA_URL) — after that
 * KV is the only source. Memoized briefly per isolate; `fresh` reads KV.
 */
async function loadSettings(env, cf, fresh = false) {
  if (!fresh) { const m = memoGet(SETTINGS_KEY, SETTINGS_MEMO_MS); if (m) return m; }
  let doc = await env.STATE.get(SETTINGS_KEY, { type: 'json' });
  if (!doc) {
    doc = seedSettings(env, cf);
    await env.STATE.put(SETTINGS_KEY, JSON.stringify(doc));
  }
  memoSet(SETTINGS_KEY, doc);
  return doc;
}

async function handleSettings(request, env, cf) {
  if (request.method === 'GET') return json(await loadSettings(env, cf, true));
  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405, { Allow: 'GET, PUT' });
  const text = await request.text();
  if (text.length > 64 * 1024) return json({ error: 'settings too large' }, 413);
  const body = parseJSON(text, null);
  const current = await loadSettings(env, cf, true);
  if (body && typeof body === 'object' && typeof body.rev === 'number' && body.rev !== current.rev) {
    return json({ error: 'conflict', settings: current }, 409);
  }
  const r = applySettings(body, current);
  if (r.error) return json({ error: r.error }, 400);
  const next = { ...r.doc, rev: current.rev + 1, updated: Date.now() };
  await env.STATE.put(SETTINGS_KEY, JSON.stringify(next));
  memoSet(SETTINGS_KEY, next);
  // Someone was removed: move their chores to Anyone and drop their stars/week now, so every
  // screen sees it on its next poll (loadState repeats this for state saved by stale devices).
  if (current.family.some((m) => !next.family.some((n) => n.id === m.id))) {
    const st = await env.STATE.get(STATE_KEY, { type: 'json' });
    if (st && purgeMembers(st, removedIds(next), next.family.map((m) => m.id))) {
      st.rev++;
      st.updated = Date.now();
      await env.STATE.put(STATE_KEY, JSON.stringify(st));
    }
  }
  return json(next);
}

// POST /api/settings/check {kind, value}: try a link before it is saved.
async function handleCheck(request) {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  const text = await request.text();
  const body = text.length < 4096 ? parseJSON(text, null) : null;
  if (!body || typeof body.value !== 'string' || typeof body.kind !== 'string') return json({ ok: false, error: 'Send {kind, value}' }, 400);
  const value = body.value;
  if (body.kind === 'calendar') {
    let url;
    try { url = cleanCalendarUrl(value); } catch (e) { return json({ ok: false, error: e.message }, 400); }
    try {
      const res = await fetch(url, { headers: { Accept: 'text/calendar, */*' }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) return json({ ok: false, error: res.status === 404 ? 'Not found (404) — copy the secret iCal address again' : 'The calendar server answered HTTP ' + res.status });
      if (+res.headers.get('Content-Length') > 20e6) return json({ ok: false, error: 'That feed is too big' });
      const ics = await res.text();
      const s = icsSummary(ics);
      if (!s) return json({ ok: false, error: 'That isn’t an iCal feed — use the “Secret address in iCal format”' });
      memoSet(icsKey(url), ics); // the first calendar load after saving reuses it
      return json({ ok: true, url, name: s.name, events: s.events });
    } catch (e) { return json({ ok: false, error: errText(e) }); }
  }
  if (body.kind === 'album') {
    let link;
    try { link = cleanAlbumUrl(value); } catch (e) { return json({ ok: false, error: e.message }, 400); }
    try {
      const a = link.kind === 'cloudkit'
        ? await fetchCloudAlbum(link.token, 'check', { maxPages: 30 })
        : await fetchAlbum(link.token, 'check', { members: [] });
      return json({ ok: true, url: link.url, name: a.name || '', count: a.photos.length, partial: a.complete === false || undefined });
    } catch (e) { return json({ ok: false, error: errText(e) }); }
  }
  if (body.kind === 'city') {
    const q = value.replace(/\s+/g, ' ').trim();
    if (q.length < 2 || q.length > 80) return json({ ok: false, error: 'Type a city name' }, 400);
    try {
      const res = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=' + encodeURIComponent(q), { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (!res.ok) return json({ ok: false, error: 'Place search answered HTTP ' + res.status });
      const places = mapPlaces(await res.json());
      return json(places.length ? { ok: true, places } : { ok: false, error: 'No place called “' + q + '” found' });
    } catch (e) { return json({ ok: false, error: errText(e) }); }
  }
  return json({ ok: false, error: 'kind must be calendar, album or city' }, 400);
}

// ------------------------------------------------------------------ calendar
function icsKey(url) { return 'ics:' + hashId(url) + ':' + url.length; }
async function fetchIcs(url, ctx, force) {
  return cached(icsKey(url), ICS_TTL, ctx, force, 'text', async () => {
    const res = await fetch(url, { headers: { Accept: 'text/calendar, */*' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'Calendar not found (404) — check the secret iCal address' : 'Calendar HTTP ' + res.status);
    const text = await res.text();
    if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('Not an iCal feed — use the "Secret address in iCal format"');
    return text;
  });
}

// The Worker only fetches, caches and trims the feeds (a few ms of CPU for ~1 MB); the client parses
// and expands them (js/calendar-worker.js). ETag/If-None-Match keeps unchanged feeds off the wire.
async function handleCalendar(request, url, cfg, ctx) {
  const fresh = freshness(url, 'calendar');
  const win = windowFromQuery(url.searchParams, dayKey(Date.now(), cfg.tz));
  const calendars = await Promise.all(cfg.calendars.map(async (cal) => {
    const meta = { id: cal.id, name: cal.name, color: cal.color, people: cal.people };
    try {
      const raw = await fetchIcs(cal.url, ctx, fresh.force);
      const key = 'flt:' + hashId(cal.url) + ':' + win.from + ':' + win.to + ':' + raw.length + ':' + hashId(raw.slice(-2000));
      let text = memoGet(key, ICS_TTL * 1000);
      if (text === undefined) { text = prefilterIcs(raw, win.from, win.to); memoSet(key, text); }
      return { ...meta, ok: true, text };
    } catch (e) {
      return { ...meta, ok: false, error: String((e && e.message) || e) };
    }
  }));
  const body = JSON.stringify({ from: win.from, to: win.to, tz: cfg.tz, configured: cfg.calendars.length, calendars });
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  let hex = '';
  for (let i = 0; i < 16; i++) hex += (digest[i] < 16 ? '0' : '') + digest[i].toString(16);
  const etag = '"' + hex + '"';
  const headers = { ETag: etag, 'Cache-Control': 'no-store', ...fresh.headers };
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

// ------------------------------------------------------------------ weather
async function handleWeather(url, cfg, ctx) {
  if (cfg.lat == null || cfg.lon == null) return json({ error: 'No location — pick a city in Settings → Display' }, 503);
  const fresh = freshness(url, 'weather');
  const lat = Math.round(cfg.lat * 100) / 100, lon = Math.round(cfg.lon * 100) / 100;
  const key = 'wx:' + lat + ',' + lon + ':' + cfg.units + ':' + cfg.tz;
  try {
    const raw = await cached(key, WEATHER_TTL, ctx, fresh.force, 'json', () => fetchWeather({ lat, lon, tz: cfg.tz, units: cfg.units }));
    return json(mapWeather(raw, { tz: cfg.tz, units: cfg.units, city: cfg.city }), 200, fresh.headers);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 502, fresh.headers);
  }
}

// ------------------------------------------------------------------ photos
// Album listings live in memory + KV (stale-while-revalidate): the old webstream call can take tens
// of seconds for big albums, and the photo proxy needs the id → checksum/record map.
// Subrequest budget for listing refreshes in one request (Workers free plan: 50 per request).
const LIST_PAGE_BUDGET = 40;
async function albumListing(env, ctx, cfg, idx, force) {
  const { id, kind, token } = cfg.albums[idx];
  const key = (kind === 'cloudkit' ? 'ckalbum:' : 'album:') + hashId(token) + ':' + token.length;
  const fresh = (e) => e && Date.now() - e.at < ALBUM_TTL * 1000;
  const refresh = () => once(key, async () => {
    const value = kind === 'cloudkit'
      ? await fetchCloudAlbum(token, id, { maxPages: Math.max(1, Math.floor(LIST_PAGE_BUDGET / cfg.albums.length)) })
      : await fetchAlbum(token, id, { members: cfg.members });
    const entry = { at: Date.now(), value };
    memoSet(key, entry);
    await env.STATE.put(key, JSON.stringify(entry));
    return entry;
  });
  if (force) return (await refresh()).value;
  let entry = memoGet(key, 24 * 3600 * 1000);
  if (!entry) { entry = await env.STATE.get(key, { type: 'json' }); if (entry) memoSet(key, entry); }
  if (fresh(entry)) return entry.value;
  if (entry) { ctx.waitUntil(refresh().catch(() => {})); return entry.value; }
  return (await refresh()).value;
}

async function handlePhotos(url, env, ctx, cfg) {
  const fresh = freshness(url, 'photos');
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...fresh.headers };
  if (!cfg.albums.length) return json({ configured: 0, albums: [], photos: [] }, 200, fresh.headers);
  const results = await Promise.all(cfg.albums.map((_, i) => albumListing(env, ctx, cfg, i, fresh.force).then(
    (v) => ({ v }),
    (e) => ({ error: String((e && e.message) || e) }),
  )));
  // Big albums make a big body: reuse the serialized one until a listing actually changes.
  const parts = results.map((r) => r.v || r.error).concat(cfg.albums.map((a) => a.id));
  if (photosBody && photosBody.parts.length === parts.length && photosBody.parts.every((p, i) => p === parts[i])) {
    return new Response(photosBody.body, { headers });
  }
  const photos = [];
  for (const r of results) if (r.v) photos.push(...r.v.photos);
  const body = JSON.stringify({
    configured: cfg.albums.length,
    albums: results.map((r, i) => (r.v
      ? { id: cfg.albums[i].id, name: r.v.name, count: r.v.photos.length, ok: true, partial: r.v.complete === false || undefined }
      : { id: cfg.albums[i].id, name: cfg.albums[i].name, ok: false, error: r.error })),
    photos,
  });
  photosBody = { parts, body };
  return new Response(body, { headers });
}
let photosBody = null;

async function assetUrl(listing, token, guid, checksum, force) {
  const key = 'asset:' + checksum;
  const m = !force && memoGet(key, 45 * 60 * 1000);
  if (m) return m;
  const urls = await fetchAssetUrls(listing.host, token, [guid]);
  for (const [c, u] of Object.entries(urls)) memoSet('asset:' + c, u);
  return urls[checksum] || null;
}

// New-format albums: a CloudKit lookup gives a pre-signed URL; reuse it until shortly before its
// `e=` expiry.
async function cloudUrl(token, ref, guid, force) {
  const key = 'ckurl:' + hashId(token) + ':' + guid;
  const m = !force && memoGet(key, 3600 * 1000);
  if (m && m.expires - 120000 > Date.now()) return m.url;
  const fresh = await cloudPhotoUrl(token, ref);
  memoSet(key, fresh);
  return fresh.url;
}

// /api/photo/<album id>/<guid>. Listings cached before albums had ids used the album's position.
async function handlePhoto(env, ctx, cfg, album, guid) {
  let idx = cfg.albums.findIndex((a) => a.id === album);
  if (idx < 0 && /^\d+$/.test(album)) idx = +album;
  if (!(idx >= 0 && idx < cfg.albums.length) || !/^[A-Za-z0-9-]{8,64}$/.test(guid)) return json({ error: 'not found' }, 404);
  const { kind, token } = cfg.albums[idx];
  const browser = { 'Cache-Control': 'private, max-age=' + PHOTO_TTL + ', immutable' };
  const cacheReq = new Request(CACHE_ORIGIN + 'photo/' + hashId(token) + '/' + guid);
  const hit = await caches.default.match(cacheReq);
  if (hit) return new Response(hit.body, { headers: { 'Content-Type': hit.headers.get('Content-Type') || 'image/jpeg', ...browser } });

  const listing = await albumListing(env, ctx, cfg, idx);
  const ref = kind === 'cloudkit' ? listing.refs && listing.refs[guid] : listing.checksums[guid];
  if (!ref) return json({ error: 'not found' }, 404);
  let res = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const u = kind === 'cloudkit' ? await cloudUrl(token, ref, guid, attempt > 0) : await assetUrl(listing, token, guid, ref, attempt > 0);
      if (!u) break;
      res = await fetch(u);
      if (res.ok) break;
    }
  } catch { res = null; }
  if (!res || !res.ok) return json({ error: 'photo unavailable' }, 502);
  const type = res.headers.get('Content-Type') || 'image/jpeg';
  const [a, b] = res.body.tee();
  ctx.waitUntil(caches.default.put(cacheReq, new Response(b, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=' + PHOTO_TTL } })));
  return new Response(a, { headers: { 'Content-Type': type, ...browser } });
}

// ------------------------------------------------------------------ state
async function loadState(env, cfg) {
  let doc = await env.STATE.get(STATE_KEY, { type: 'json', cacheTtl: 30 });
  if (!doc) {
    doc = seedState(cfg.members, cfg.tz);
    await env.STATE.put(STATE_KEY, JSON.stringify(doc));
    return doc;
  }
  normalize(doc, cfg.members);
  const purged = purgeMembers(doc, cfg.removed, cfg.members.map((m) => m.id));
  if (rollover(doc, cfg.members, cfg.tz) || purged) {
    doc.rev++;
    doc.updated = Date.now();
    await env.STATE.put(STATE_KEY, JSON.stringify(doc));
  }
  return doc;
}

// Responses carry settingsRev so the screens' 1-minute state poll notices settings changes too.
async function handleState(request, env, cfg) {
  if (request.method === 'GET') return json({ ...(await loadState(env, cfg)), settingsRev: cfg.rev });
  if (request.method !== 'PUT') return json({ error: 'method not allowed' }, 405, { Allow: 'GET, PUT' });
  const text = await request.text();
  if (text.length > 1024 * 1024) return json({ error: 'state too large' }, 413);
  const fields = sanitize(parseJSON(text, null));
  if (typeof fields === 'string') return json({ error: fields }, 400);
  const body = JSON.parse(text);
  const current = await loadState(env, cfg);
  if (body.rev !== current.rev) return json({ error: 'conflict', state: { ...current, settingsRev: cfg.rev } }, 409);
  const next = normalize({ ...current, ...fields, rev: current.rev + 1, updated: Date.now() }, cfg.members);
  purgeMembers(next, cfg.removed, cfg.members.map((m) => m.id));
  await env.STATE.put(STATE_KEY, JSON.stringify(next));
  return json({ ...next, settingsRev: cfg.rev });
}

// ------------------------------------------------------------------ config + version
// No calendar or album links here: those only come from GET /api/settings.
function handleConfig(cfg) {
  return json({
    family: cfg.members,
    calendars: cfg.calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, people: c.people })),
    albums: cfg.albums.length,
    albumIds: cfg.albums.map((a) => a.id),
    haUrl: cfg.haUrl,
    haToken: cfg.haToken,
    location: { city: cfg.city, lat: cfg.lat, lon: cfg.lon, auto: cfg.autoLocation },
    tz: cfg.tz,
    units: cfg.units,
    display: cfg.display,
    settingsRev: cfg.rev,
  });
}

// The build id Vite writes into index.html (<meta name="hq-build">). A deploy starts new isolates,
// so caching it per isolate for a minute is plenty.
async function buildId(env, request) {
  const m = memoGet('build', 60000);
  if (m !== undefined) return m;
  const res = await env.ASSETS.fetch(new Request(new URL('/', request.url)));
  const html = res.ok ? await res.text() : '';
  const id = (html.match(/<meta name="hq-build" content="([^"]*)"/) || [])[1] || '';
  memoSet('build', id);
  return id;
}

// ------------------------------------------------------------------ router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const api = url.pathname.startsWith('/api/');
    if (!api) {
      if (url.searchParams.has('k')) return keyRedirect(url, env);
      return env.ASSETS.fetch(request);
    }
    if (!(await authorized(request, env))) {
      return json({ error: 'unauthorized', message: 'Open the dashboard link that ends in ?k=<access key>.' }, 401);
    }
    const path = url.pathname.replace(/\/+$/, '');
    const cf = request.cf || {};
    try {
      if (path === '/api/version') return json({ version: await buildId(env, request) });
      if (path === '/api/settings') return await handleSettings(request, env, cf);
      if (path === '/api/settings/check') return await handleCheck(request);
      const cfg = runtimeConfig(await loadSettings(env, cf), env, cf, tzOf(env));
      if (path === '/api/state') return await handleState(request, env, cfg);
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (path === '/api/config') return handleConfig(cfg);
      if (path === '/api/calendar') return await handleCalendar(request, url, cfg, ctx);
      if (path === '/api/weather') return await handleWeather(url, cfg, ctx);
      if (path === '/api/photos') return await handlePhotos(url, env, ctx, cfg);
      const m = path.match(/^\/api\/photo\/([A-Za-z0-9-]{1,40})\/([^/]+)$/);
      if (m) return await handlePhoto(env, ctx, cfg, m[1], decodeURIComponent(m[2]));
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
