// US National Weather Service (api.weather.gov, no key, US only) → the same shape as weather.js
// (hourly arrays from today's local midnight, 48 hours), plus `source` and the observing `station`.
// The Worker falls back to Open-Meteo whenever anything here throws (non-US 404, 5xx, timeout).
import { dayKey, addDaysKey, zonedParts } from './time.js';

export const NWS_ORIGIN = 'https://api.weather.gov';
const UA = 'HomeHQ dashboard (github.com/peterbinks/photo-frame-dashboard)';
export const NWS_TIMEOUT_MS = 6000;
const POINT_TTL = 7 * 24 * 3600; // a point's grid and nearest station practically never change
const NO_POINT_TTL = 24 * 3600; // outside the US: don't ask again for a day
export const STALE_OBS_MS = 90 * 60 * 1000;
const HOUR = 3600 * 1000;

async function get(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, Accept: 'application/geo+json' },
    signal: AbortSignal.timeout(NWS_TIMEOUT_MS),
  });
  if (!res.ok) {
    const e = new Error('NWS HTTP ' + res.status + ' for ' + new URL(url).pathname);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * lat/lon (≤ 4 decimals) → { hourly, forecast, station, city }: the grid's forecast URLs and its
 * first (nearest) observation station, cached in KV for days. Points outside the US are remembered
 * as such so they go straight to Open-Meteo.
 */
export async function nwsPoint(lat, lon, kv, ctx, fetchImpl = fetch) {
  const key = 'nws:point:' + lat + ',' + lon;
  const hit = await kv.get(key, { type: 'json' });
  if (hit && hit.none) throw new Error('No NWS forecast for this location');
  if (hit) return hit;
  let p;
  try {
    p = (await get(NWS_ORIGIN + '/points/' + lat + ',' + lon, fetchImpl)).properties;
  } catch (e) {
    if (e.status === 404) ctx.waitUntil(kv.put(key, JSON.stringify({ none: true }), { expirationTtl: NO_POINT_TTL }));
    throw e;
  }
  if (!p || !p.forecastHourly || !p.forecast) throw new Error('NWS point without forecasts');
  let station = null;
  if (p.observationStations) {
    const list = await get(p.observationStations + '?limit=1', fetchImpl);
    const f = list.features && list.features[0];
    station = (f && f.properties && f.properties.stationIdentifier) || null;
  }
  const rel = (p.relativeLocation && p.relativeLocation.properties) || {};
  const point = { hourly: p.forecastHourly, forecast: p.forecast, station, city: rel.city || '' };
  ctx.waitUntil(kv.put(key, JSON.stringify(point), { expirationTtl: POINT_TTL }));
  return point;
}

// ------------------------------------------------------------------ conditions
// NWS icon codes (…/icons/land/day/rain_showers,40?size=small) → icon names in js/icons.js
const ICON_CODES = {
  skc: 'clear', few: 'clear', hot: 'clear', cold: 'clear',
  sct: 'partly',
  bkn: 'cloud', ovc: 'cloud', fog: 'cloud', haze: 'cloud', smoke: 'cloud', dust: 'cloud',
  rain: 'rain', rain_showers: 'rain', rain_showers_hi: 'rain', fzra: 'rain', rain_fzra: 'rain', sleet: 'rain', rain_sleet: 'rain',
  snow: 'snow', rain_snow: 'snow', snow_sleet: 'snow', snow_fzra: 'snow', blizzard: 'snow',
  tsra: 'storm', tsra_sct: 'storm', tsra_hi: 'storm', tornado: 'storm', hurricane: 'storm', tropical_storm: 'storm',
};
const ICON_RE = /\/icons\/land\/(day|night)\/([a-z_]+)/;

function textKind(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/thunder|t-storm|tstorm|tornado|hurricane|tropical storm/.test(s)) return 'storm';
  if (/snow|flurr|blizzard|sleet|ice pellet/.test(s)) return 'snow';
  if (/rain|shower|drizzle|freezing/.test(s)) return 'rain';
  if (/partly/.test(s)) return 'partly';
  if (/cloud|overcast|fog|haze|smoke|dust|mist/.test(s)) return 'cloud';
  if (/sun|clear|fair/.test(s)) return 'clear';
  return null;
}

/**
 * NWS icon URL (or, without one, its text) → sun | moon | partly | cloud | rain | snow | storm;
 * `fallback` when neither says anything (observations often have no icon and an empty text).
 */
export function nwsCondition(icon, text, isDay, fallback = 'cloud') {
  const m = icon ? ICON_RE.exec(icon) : null;
  const day = m ? m[1] === 'day' : !!isDay;
  const kind = (m && ICON_CODES[m[2].replace(/^wind_/, '')]) || textKind(text);
  if (!kind) return fallback;
  if (kind === 'clear') return day ? 'sun' : 'moon';
  if (kind === 'partly') return day ? 'partly' : 'moon';
  return kind;
}

// ------------------------------------------------------------------ mapping
const round = (x) => (x == null || !isFinite(x) ? null : Math.round(x));
const cToUnits = (c, units) => (units === 'fahrenheit' ? c * 9 / 5 + 32 : c);
function tempIn(value, unit, units) {
  if (value == null) return null;
  const isF = unit === 'F' || unit === 'wmoUnit:degF';
  if (isF === (units === 'fahrenheit')) return value;
  return isF ? (value - 32) * 5 / 9 : value * 9 / 5 + 32;
}
// "5 mph", "10 to 15 mph", "8 km/h" → the middle of the range
function windOf(s) {
  const n = String(s || '').match(/\d+(\.\d+)?/g);
  return n ? (+n[0] + +n[n.length - 1]) / 2 : null;
}
const pct = (q) => (q && q.value != null ? q.value : null);

/** A fresh observation (≤ 90 min old, with a temperature) or null. */
export function freshObservation(obs, now) {
  const o = obs && obs.properties;
  if (!o || !o.temperature || o.temperature.value == null) return null;
  const at = Date.parse(o.timestamp);
  return isFinite(at) && now - at <= STALE_OBS_MS && at <= now + 10 * 60000 ? o : null;
}

/**
 * Running observed high/low (°C) for the station's local day, so the evening "H" can still show
 * what was observed after NWS drops today's daytime period. → the updated stats, or null if
 * nothing changed.
 */
export function nextDayStats(stats, obs, day) {
  if (!obs) return null;
  const c = obs.temperature.value;
  const base = stats && stats.day === day ? stats : { day, hi: c, lo: c };
  const next = { day, hi: Math.max(base.hi, c), lo: Math.min(base.lo, c) };
  return stats && stats.day === day && stats.hi === next.hi && stats.lo === next.lo ? null : next;
}

/**
 * raw = { hourly, forecast, obs } (geojson bodies; forecast/obs may be null), stats = the day's
 * observed {day, hi, lo} in °C or null → the /api/weather shape. Throws when the hourly forecast
 * doesn't cover today.
 */
export function mapNws(raw, { tz, units, city, station, stats = null, now = Date.now() }) {
  const today = dayKey(now, tz), tomorrow = addDaysKey(today, 1);
  const hourNow = zonedParts(now, tz).hour;
  const t = new Array(48).fill(null), c = new Array(48).fill(null), p = new Array(48).fill(0);
  const periods = (raw.hourly && raw.hourly.properties && raw.hourly.properties.periods) || [];
  const end = now + 50 * HOUR;
  let cur = null, first = 48;
  for (let i = 0; i < periods.length; i++) {
    const per = periods[i], ms = Date.parse(per.startTime);
    if (!(ms < end)) break; // periods are in time order; the rest is beyond tomorrow
    if (ms <= now && now < Date.parse(per.endTime)) cur = per;
    const z = zonedParts(ms, tz);
    const key = z.year + '-' + (z.month < 10 ? '0' : '') + z.month + '-' + (z.day < 10 ? '0' : '') + z.day;
    const idx = key === today ? z.hour : key === tomorrow ? 24 + z.hour : -1;
    if (idx < 0) continue;
    t[idx] = round(tempIn(per.temperature, per.temperatureUnit, units));
    c[idx] = nwsCondition(per.icon, per.shortForecast, per.isDaytime);
    p[idx] = pct(per.probabilityOfPrecipitation) || 0;
    if (idx < first) first = idx;
  }
  if (first > hourNow + 1) throw new Error('NWS hourly forecast does not cover the current hour');
  if (!cur) cur = periods[0];

  const curCond = cur ? nwsCondition(cur.icon, cur.shortForecast, cur.isDaytime) : c[first];
  const obs = freshObservation(raw.obs, now);
  const obsTemp = obs ? round(cToUnits(obs.temperature.value, units)) : null;
  const obsCond = obs ? nwsCondition(obs.icon, obs.textDescription, cur && cur.isDaytime, curCond) : null;

  // Hours before the first period (the past; views start at the current hour): the observation for
  // the current hour, the nearest forecast hour before that. Then carry over DST gaps.
  for (let i = first - 1; i >= 0; i--) {
    const useObs = i === hourNow && obs;
    t[i] = useObs ? obsTemp : t[i + 1];
    c[i] = useObs ? obsCond : c[i + 1];
  }
  for (let i = 1; i < 48; i++) if (t[i] == null) { t[i] = t[i - 1]; c[i] = c[i - 1]; p[i] = p[i - 1]; }

  // Current conditions: the station observation, else the current hourly period.
  let now_, cond, feels, humidity, wind;
  const curTemp = cur ? round(tempIn(cur.temperature, cur.temperatureUnit, units)) : t[hourNow];
  if (obs) {
    const tc = obs.temperature.value;
    const hi = obs.heatIndex && obs.heatIndex.value, wc = obs.windChill && obs.windChill.value;
    now_ = obsTemp;
    cond = obsCond;
    feels = round(cToUnits(tc >= 26.7 && hi != null ? hi : tc <= 10 && wc != null ? wc : tc, units));
    humidity = round(pct(obs.relativeHumidity));
    const kmh = obs.windSpeed && obs.windSpeed.value;
    wind = kmh == null ? null : round(units === 'fahrenheit' ? kmh / 1.609344 : kmh);
  } else {
    now_ = curTemp;
    cond = curCond;
    feels = curTemp;
  }
  if (humidity == null && cur) humidity = round(pct(cur.relativeHumidity));
  if (wind == null && cur) wind = round(windOf(cur.windSpeed));

  // Today's high: the daytime period of the 12-hour forecast (never below what was observed); once
  // that period has passed, the observed high so far vs the rest of today's hours. Low: tonight's.
  const fps = (raw.forecast && raw.forecast.properties && raw.forecast.properties.periods) || [];
  let dayP = null, nightP = null;
  for (let i = 0; i < fps.length && i < 4; i++) {
    const ms = Date.parse(fps[i].startTime);
    if (dayKey(ms, tz) !== today) continue;
    if (fps[i].isDaytime) { if (!dayP) dayP = fps[i]; } else if (!nightP && zonedParts(ms, tz).hour >= 12) nightP = fps[i];
  }
  const seenHi = stats && stats.day === today ? round(cToUnits(stats.hi, units)) : null;
  const seen = [seenHi, obsTemp].filter((x) => x != null);
  const rest = t.slice(hourNow, 24);
  const hi = dayP
    ? Math.max(round(tempIn(dayP.temperature, dayP.temperatureUnit, units)), ...seen)
    : Math.max(...seen, ...rest);
  const lo = nightP ? round(tempIn(nightP.temperature, nightP.temperatureUnit, units)) : Math.min(...t.slice(hourNow, 30));

  const out = {
    day: today, units, city: city || '',
    now: now_, cond, hi, lo, feels, humidity, wind,
    t, c, p,
    source: 'nws',
    updated: now,
  };
  if (obs) out.station = obs.stationId || station || '';
  return out;
}

/**
 * The whole NWS path for one location: point (KV) → hourly + 12-hour forecast + latest observation
 * in parallel (3 subrequests once the point is cached) → mapped weather. The observation and the
 * 12-hour forecast are optional; the hourly forecast is not.
 */
export async function nwsWeather({ lat, lon, tz, units, city, kv, ctx, now = Date.now() }, fetchImpl = fetch) {
  const point = await nwsPoint(lat, lon, kv, ctx, fetchImpl);
  const u = units === 'fahrenheit' ? 'us' : 'si';
  const statsKey = point.station ? 'nws:obsday:' + point.station : null;
  const [hourly, forecast, obs, stats] = await Promise.all([
    get(point.hourly + '?units=' + u, fetchImpl),
    get(point.forecast + '?units=' + u, fetchImpl).catch(() => null),
    point.station ? get(NWS_ORIGIN + '/stations/' + point.station + '/observations/latest', fetchImpl).catch(() => null) : null,
    statsKey ? kv.get(statsKey, { type: 'json' }).catch(() => null) : null,
  ]);
  const raw = { hourly, forecast, obs };
  const out = mapNws(raw, { tz, units, city: city || point.city, station: point.station, stats, now });
  const next = nextDayStats(stats, freshObservation(obs, now), out.day);
  if (next) ctx.waitUntil(kv.put(statsKey, JSON.stringify(next), { expirationTtl: 2 * 24 * 3600 }));
  return out;
}
