// Household settings: one KV JSON document with a monotonically increasing `rev`, edited from the
// Settings screen (PUT /api/settings). It is seeded once from the deploy-time vars/secrets
// (FAMILY, GCAL_ICS, ICLOUD_ALBUMS, LAT/LON/CITY, UNITS, HA_URL); after that those are ignored.
// Pure functions only: the Worker does the I/O.
import { parseAlbumLink } from './icloud.js';
import { hashId } from './ics-filter.js';
import { unitsFor } from './weather.js';

export const SETTINGS_KEY = 'settings:v1';

// Person colours: distinct hues that hold up as fills behind white or black initials.
export const PALETTE = ['#2D5BFF', '#E4007C', '#00A36C', '#FFB000', '#7B3FE4', '#00A3C4', '#FF5A1F', '#8C6A00', '#5B6770', '#9B2C8F'];

export const LIMITS = {
  members: 6, calendars: 8, albums: 5,
  memberName: 24, calendarName: 40, albumName: 60, city: 80, url: 2048, haUrl: 200,
  idleMinutes: [0, 120], slideSeconds: [5, 300],
};

export const DEFAULTS = { clock24: false, nightFrom: 22, nightTo: 6, idleMinutes: 2, slideSeconds: 15 };

// Fields the Settings screen edits; `rev`, `usedIds` and `updated` are kept by the server.
export const SETTINGS_FIELDS = ['family', 'calendars', 'albums', 'location', 'units', 'clock24', 'nightFrom', 'nightTo', 'idleMinutes', 'slideSeconds', 'haUrl'];
const SERVER_FIELDS = ['rev', 'usedIds', 'updated'];
const RESERVED_IDS = ['family', 'any', 'all'];

// ------------------------------------------------------------------ small helpers
function parseJSON(s, fallback) {
  if (!s) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20).replace(/-$/, '') || 'member';
}
export function inkFor(hex) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return { rgb: r + ' ' + g + ' ' + b, ink: 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#111111' : '#FFFFFF' };
}
function unknownKey(o, allowed) {
  for (const k of Object.keys(o)) if (allowed.indexOf(k) < 0) return k;
  return null;
}
class Invalid extends Error {}
function fail(msg) { throw new Invalid(msg); }

/** Display name: trimmed, single spaces, no control characters or markup. */
function cleanName(v, max, what, strict) {
  if (typeof v !== 'string') fail(what + ' must be text');
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) fail(what + ' can’t be empty');
  if (s.length > max) fail(what + ' is too long (max ' + max + ' characters)');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f<>]/.test(s) || (strict && /["\\]/.test(s))) fail(what + ' can’t contain < > " or \\');
  return s;
}
function cleanColor(v, what) {
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) fail(what + ' must be a colour like #2D5BFF');
  return v.toUpperCase();
}
function cleanBool(v, what) {
  if (typeof v !== 'boolean') fail(what + ' must be true or false');
  return v;
}
function cleanInt(v, lo, hi, what) {
  if (!Number.isInteger(v) || v < lo || v > hi) fail(what + ' must be a whole number from ' + lo + ' to ' + hi);
  return v;
}
function cleanId(v, what) {
  if (typeof v !== 'string' || !/^[a-z0-9-]{1,40}$/.test(v)) fail(what + ' has a bad id');
  return v;
}

/** Public host only: no IP literals, single-label or local names, no credentials. */
function publicHost(u) {
  const h = u.hostname.toLowerCase();
  if (!h || h.indexOf('.') < 0 || /^[\d.]+$/.test(h) || h[0] === '[' || h.indexOf(':') > -1) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid)$/.test(h);
}

/** Google/iCloud/Outlook secret iCal address → https URL (webcal:// converted). Throws Invalid. */
export function cleanCalendarUrl(v) {
  if (typeof v !== 'string') fail('Calendar link must be text');
  let s = v.trim();
  if (!s) fail('Paste the calendar’s secret iCal address');
  if (s.length > LIMITS.url) fail('Calendar link is too long');
  s = s.replace(/^webcal:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { fail('That isn’t a link'); }
  if (u.protocol !== 'https:') fail('Calendar links must start with https:// (or webcal://)');
  if (u.username || u.password) fail('Calendar links can’t contain a user name or password');
  if (!publicHost(u)) fail('Calendar links must point to a public internet address');
  return u.href;
}

/** iCloud shared-album link (either format) → { url, kind, token }. Throws Invalid. */
export function cleanAlbumUrl(v) {
  if (typeof v !== 'string') fail('Album link must be text');
  const s = v.trim();
  if (s.length > 300) fail('Album link is too long');
  const a = parseAlbumLink(s);
  if (!a) fail('That isn’t an iCloud shared album link (photos.icloud.com/shared/album/… or icloud.com/sharedalbum/#…)');
  return { url: s, kind: a.kind, token: a.token };
}

export function cleanHaUrl(v) {
  if (typeof v !== 'string') fail('Home Assistant address must be text');
  const s = v.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (s.length > LIMITS.haUrl) fail('Home Assistant address is too long');
  let u;
  try { u = new URL(s); } catch { fail('Home Assistant address must look like http://192.168.1.20:8123'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('Home Assistant address must start with http:// or https://');
  if (u.username || u.password || u.search || u.hash) fail('Home Assistant address must be just the address, like http://192.168.1.20:8123');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function cleanLocation(v) {
  if (v === null) return null;
  if (!isObj(v)) fail('Location must be a place or automatic');
  const k = unknownKey(v, ['city', 'lat', 'lon']);
  if (k) fail('Unknown location field: ' + k);
  const lat = v.lat, lon = v.lon;
  if (typeof lat !== 'number' || !isFinite(lat) || lat < -90 || lat > 90) fail('Latitude must be between -90 and 90');
  if (typeof lon !== 'number' || !isFinite(lon) || lon < -180 || lon > 180) fail('Longitude must be between -180 and 180');
  const city = v.city == null || v.city === '' ? '' : cleanName(v.city, LIMITS.city, 'City');
  return { city, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
}

// ------------------------------------------------------------------ family
/**
 * Members keep their id across renames. Entries without an id are new people: they get a unique
 * slug that was never used in this document before (ids of removed people are never handed out
 * again, so their old chores can't attach to someone new).
 */
function cleanFamily(list, current) {
  if (!Array.isArray(list)) fail('Family must be a list');
  if (list.length > LIMITS.members) fail('At most ' + LIMITS.members + ' people fit on the dashboard');
  const existing = new Set(current.family.map((m) => m.id));
  const used = new Set([...(current.usedIds || []), ...existing, ...RESERVED_IDS]);
  const seen = new Set(), names = new Set();
  const family = list.map((m, i) => {
    const what = 'Person ' + (i + 1);
    if (!isObj(m)) fail(what + ' must be an object');
    const k = unknownKey(m, ['id', 'name', 'color', 'kid']);
    if (k) fail('Unknown field for ' + what.toLowerCase() + ': ' + k);
    const name = cleanName(m.name, LIMITS.memberName, 'Name', true);
    const lower = name.toLowerCase();
    if (names.has(lower)) fail('Two people can’t both be called ' + name);
    names.add(lower);
    let id;
    if (m.id !== undefined) {
      id = cleanId(m.id, what);
      if (!existing.has(id)) fail(what + ' (' + name + ') isn’t in the family any more — reload and try again');
      if (seen.has(id)) fail(name + ' is listed twice');
    } else {
      const base = slug(name);
      id = base;
      for (let n = 2; used.has(id) || seen.has(id); n++) id = base + '-' + n;
    }
    seen.add(id);
    used.add(id);
    const color = m.color === undefined ? PALETTE[i % PALETTE.length] : cleanColor(m.color, name + '’s colour');
    const kid = m.kid === undefined ? false : cleanBool(m.kid, 'Kid');
    return { id, name, color, kid };
  });
  return { family, usedIds: Array.from(used).filter((id) => RESERVED_IDS.indexOf(id) < 0) };
}

/** [] = everyone (so people added later see the shared family calendars too). */
function cleanPeople(v, ids, what) {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(what + ': whose must be a list');
  const out = [];
  for (const p of v) {
    if (typeof p !== 'string' || ids.indexOf(p) < 0) fail(what + ': unknown person ' + JSON.stringify(p));
    if (out.indexOf(p) < 0) out.push(p);
  }
  return out.length === ids.length ? [] : ids.filter((id) => out.indexOf(id) > -1);
}

function newId(prefix, key, taken) {
  let id = prefix + hashId(key);
  for (let n = 2; taken.has(id); n++) id = prefix + hashId(key + '#' + n);
  return id;
}

function cleanCalendars(list, ids) {
  if (!Array.isArray(list)) fail('Calendars must be a list');
  if (list.length > LIMITS.calendars) fail('At most ' + LIMITS.calendars + ' calendars');
  const urls = new Set(), taken = new Set();
  for (const c of list) if (isObj(c) && typeof c.id === 'string') taken.add(c.id);
  return list.map((c, i) => {
    const what = 'Calendar ' + (i + 1);
    if (!isObj(c)) fail(what + ' must be an object');
    const k = unknownKey(c, ['id', 'url', 'name', 'color', 'people']);
    if (k) fail('Unknown field for ' + what.toLowerCase() + ': ' + k);
    const url = cleanCalendarUrl(c.url);
    if (urls.has(url)) fail('That calendar is already on the list');
    urls.add(url);
    const name = cleanName(c.name, LIMITS.calendarName, what + ' name');
    const id = c.id !== undefined ? cleanId(c.id, what) : newId('c', url, taken);
    taken.add(id);
    const color = c.color == null ? null : cleanColor(c.color, name + ' colour');
    return { id, url, name, color, people: cleanPeople(c.people, ids, name) };
  });
}

function cleanAlbums(list) {
  if (!Array.isArray(list)) fail('Albums must be a list');
  if (list.length > LIMITS.albums) fail('At most ' + LIMITS.albums + ' albums');
  const tokens = new Set(), taken = new Set();
  for (const a of list) if (isObj(a) && typeof a.id === 'string') taken.add(a.id);
  return list.map((a, i) => {
    const what = 'Album ' + (i + 1);
    if (!isObj(a)) fail(what + ' must be an object');
    const k = unknownKey(a, ['id', 'url', 'name']);
    if (k) fail('Unknown field for ' + what.toLowerCase() + ': ' + k);
    const link = cleanAlbumUrl(a.url);
    if (tokens.has(link.token)) fail('That album is already on the list');
    tokens.add(link.token);
    const id = a.id !== undefined ? cleanId(a.id, what) : newId('a', link.token, taken);
    taken.add(id);
    const out = { id, url: link.url };
    if (a.name != null && a.name !== '') out.name = cleanName(a.name, LIMITS.albumName, what + ' name');
    return out;
  });
}

// ------------------------------------------------------------------ PUT validation
/**
 * Validate a PUT body (any subset of SETTINGS_FIELDS plus the `rev` it was based on) against the
 * current document → { doc } with the complete next document (rev not yet bumped), or { error }.
 * Removing a person also drops them from every calendar's "whose".
 */
export function applySettings(body, current) {
  try {
    if (!isObj(body)) fail('Body must be a JSON object');
    if (typeof body.rev !== 'number') fail('Missing numeric rev');
    const k = unknownKey(body, SETTINGS_FIELDS.concat(SERVER_FIELDS));
    if (k) fail('Unknown field: ' + k);
    const next = JSON.parse(JSON.stringify(current));
    if (own(body, 'family')) {
      const f = cleanFamily(body.family, current);
      next.family = f.family;
      next.usedIds = f.usedIds;
    }
    const ids = next.family.map((m) => m.id);
    if (own(body, 'calendars')) next.calendars = cleanCalendars(body.calendars, ids);
    else next.calendars = next.calendars.map((c) => ({ ...c, people: cleanPeople(c.people.filter((p) => ids.indexOf(p) > -1), ids, c.name) }));
    if (own(body, 'albums')) next.albums = cleanAlbums(body.albums);
    if (own(body, 'location')) next.location = cleanLocation(body.location);
    if (own(body, 'units')) {
      if (body.units !== 'fahrenheit' && body.units !== 'celsius') fail('Units must be fahrenheit or celsius');
      next.units = body.units;
    }
    if (own(body, 'clock24')) next.clock24 = cleanBool(body.clock24, '24-hour clock');
    if (own(body, 'nightFrom')) next.nightFrom = cleanInt(body.nightFrom, 0, 23, 'Night screen start');
    if (own(body, 'nightTo')) next.nightTo = cleanInt(body.nightTo, 0, 23, 'Night screen end');
    if (own(body, 'idleMinutes')) next.idleMinutes = cleanInt(body.idleMinutes, LIMITS.idleMinutes[0], LIMITS.idleMinutes[1], 'Idle minutes');
    if (own(body, 'slideSeconds')) next.slideSeconds = cleanInt(body.slideSeconds, LIMITS.slideSeconds[0], LIMITS.slideSeconds[1], 'Seconds per photo');
    if (own(body, 'haUrl')) next.haUrl = cleanHaUrl(body.haUrl);
    return { doc: next };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
}

/** Ids of people who were in the family once and have been removed. */
export function removedIds(doc) {
  const now = new Set(doc.family.map((m) => m.id));
  return (doc.usedIds || []).filter((id) => !now.has(id));
}

// ------------------------------------------------------------------ seeding (one-time migration)
/**
 * First settings document, from the deploy-time vars/secrets the dashboard used before it had a
 * Settings screen. Deterministic (ids derive from the content), so two requests seeding at once
 * write the same document. Entries that wouldn't pass validation are dropped.
 */
export function seedSettings(env, cf = {}, now = Date.now()) {
  const used = new Set();
  const family = [];
  for (const [i, m] of (parseJSON(env.FAMILY, []) || []).entries()) {
    if (!m || !m.name || family.length >= LIMITS.members) continue;
    // Same id rule the env-based Worker used, so chores/stars keyed by member id keep matching.
    let id = m.id && /^[a-z0-9-]+$/.test(m.id) ? m.id : slug(m.name);
    while (used.has(id) || id === 'family' || id === 'any') id += '-' + i;
    let name;
    try { name = cleanName(String(m.name), LIMITS.memberName, 'Name', true); } catch { continue; }
    used.add(id);
    const color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color.toUpperCase() : PALETTE[i % PALETTE.length];
    family.push({ id, name, color, kid: !!m.kid });
  }
  const ids = family.map((m) => m.id);
  const calendars = [], calTaken = new Set(), urls = new Set();
  for (const [i, c] of (parseJSON(env.GCAL_ICS, []) || []).entries()) {
    if (!c || !c.url || calendars.length >= LIMITS.calendars) continue;
    let url;
    try { url = cleanCalendarUrl(String(c.url)); } catch { continue; }
    if (urls.has(url)) continue;
    urls.add(url);
    let name;
    try { name = cleanName(c.name ? String(c.name) : 'Calendar ' + (i + 1), LIMITS.calendarName, 'Name'); } catch { name = 'Calendar ' + (i + 1); }
    const people = (Array.isArray(c.people) ? c.people : []).filter((p) => ids.indexOf(p) > -1);
    const id = newId('c', url, calTaken);
    calTaken.add(id);
    calendars.push({
      id, url, name,
      color: /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color.toUpperCase() : null,
      people: people.length === ids.length ? [] : people,
    });
  }
  const albums = [], albTaken = new Set(), tokens = new Set();
  for (const a of parseJSON(env.ICLOUD_ALBUMS, []) || []) {
    if (albums.length >= LIMITS.albums) break;
    let link;
    try { link = cleanAlbumUrl(String(a)); } catch { continue; }
    if (tokens.has(link.token)) continue;
    tokens.add(link.token);
    const id = newId('a', link.token, albTaken);
    albTaken.add(id);
    albums.push({ id, url: link.url });
  }
  const lat = env.LAT !== undefined && env.LAT !== '' ? +env.LAT : NaN;
  const lon = env.LON !== undefined && env.LON !== '' ? +env.LON : NaN;
  let location = null;
  if (isFinite(lat) && isFinite(lon)) {
    try { location = cleanLocation({ city: String(env.CITY || '').slice(0, LIMITS.city), lat, lon }); } catch { location = null; }
  }
  let haUrl = '';
  try { haUrl = cleanHaUrl(String(env.HA_URL || '')); } catch { haUrl = ''; }
  return {
    rev: 1,
    family, calendars, albums, location,
    units: unitsFor(env, env.COUNTRY || cf.country),
    ...DEFAULTS,
    haUrl,
    usedIds: ids.slice(),
    updated: now,
  };
}

// ------------------------------------------------------------------ runtime view
/** Settings doc + environment → what the request handlers use. */
export function runtimeConfig(doc, env, cf = {}, tz) {
  const ids = doc.family.map((m) => m.id);
  const members = doc.family.map((m) => ({ ...m, ...inkFor(m.color) }));
  const calendars = doc.calendars.map((c) => ({ id: c.id, url: c.url, name: c.name, color: c.color, people: c.people.length ? c.people.slice() : ids.slice() }));
  const albums = doc.albums.map((a) => ({ id: a.id, name: a.name || '', ...parseAlbumLink(a.url) }));
  const loc = doc.location;
  const lat = loc ? loc.lat : cf.latitude != null ? +cf.latitude : null;
  const lon = loc ? loc.lon : cf.longitude != null ? +cf.longitude : null;
  return {
    rev: doc.rev, tz, members, calendars, albums,
    haUrl: doc.haUrl,
    haToken: String(env.HA_TOKEN || '').trim() || null, // optional long-lived token instead of OAuth on the frame
    lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null,
    city: loc ? loc.city : cf.city || '',
    autoLocation: !loc,
    units: doc.units,
    display: { clock24: doc.clock24, nightFrom: doc.nightFrom, nightTo: doc.nightTo, idleMinutes: doc.idleMinutes, slideSeconds: doc.slideSeconds },
    removed: removedIds(doc),
  };
}

// ------------------------------------------------------------------ link checks (cheap parts)
/** Count VEVENTs and read the calendar's own name without parsing the feed (Worker CPU budget). */
export function icsSummary(text) {
  if (typeof text !== 'string' || text.indexOf('BEGIN:VCALENDAR') < 0) return null;
  let events = 0;
  for (let i = text.indexOf('BEGIN:VEVENT'); i > -1; i = text.indexOf('BEGIN:VEVENT', i + 12)) events++;
  const m = text.slice(0, 4000).match(/\nX-WR-CALNAME:([^\r\n]*)/);
  return { events, name: m ? m[1].replace(/\\([,;\\])/g, '$1').trim().slice(0, LIMITS.calendarName) : '' };
}

/** Open-Meteo geocoding results → place candidates. */
export function mapPlaces(json) {
  return ((json && json.results) || []).slice(0, 6).map((r) => ({
    name: String(r.name || ''),
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: Math.round(+r.latitude * 1e4) / 1e4,
    lon: Math.round(+r.longitude * 1e4) / 1e4,
    tz: r.timezone || '',
  })).filter((p) => p.name && isFinite(p.lat) && isFinite(p.lon));
}
