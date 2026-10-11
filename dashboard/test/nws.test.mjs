// National Weather Service mapping. Fixtures: api.weather.gov for the Chicago grid (LOT 75,72,
// station KMDW) on 2026-10-11 ~14:40 CDT, trimmed to the fields the mapping reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapNws, nwsCondition, nwsWeather, nwsPoint, freshObservation, nextDayStats } from '../src/nws.js';
import { wallToEpoch } from '../src/time.js';

const TZ = 'America/Chicago';
const fx = (name) => JSON.parse(readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8'));
const HOURLY = fx('nws-hourly.json'), FORECAST = fx('nws-forecast.json'), OBS = fx('nws-obs.json');
const POINTS = fx('nws-points.json'), STATIONS = fx('nws-stations.json');
const at = (d, h, mi = 0) => wallToEpoch(2026, 10, d, h, mi, 0, TZ);
const NOW = at(11, 14, 39); // obs at 14:25, hourly from 14:00
const opts = (extra = {}) => ({ tz: TZ, units: 'fahrenheit', city: 'Chicago', station: 'KMDW', now: NOW, ...extra });
const clone = (x) => JSON.parse(JSON.stringify(x));

test('nws: hourly → 48 hour-of-day slots, observation for now, forecast hi/lo', () => {
  const w = mapNws({ hourly: HOURLY, forecast: FORECAST, obs: OBS }, opts());
  assert.equal(w.source, 'nws');
  assert.equal(w.station, 'KMDW');
  assert.equal(w.day, '2026-10-11');
  assert.equal(w.t.length, 48);
  assert.ok(w.t.every((x) => typeof x === 'number') && w.c.every((x) => typeof x === 'string'));
  // the NWS hourly values for the same hours (14:00 today … 23:00 tomorrow)
  assert.deepEqual(w.t.slice(14, 20), [71, 72, 72, 71, 68, 66]);
  assert.deepEqual([w.t[24], w.t[38], w.t[47]], [64, 84, 76]);
  assert.deepEqual([w.c[14], w.c[18], w.c[24], w.c[38]], ['sun', 'moon', 'moon', 'sun']);
  // past hours (not shown by the views) carry the closest value
  assert.deepEqual(w.t.slice(0, 14), new Array(14).fill(71));
  // observation 24 °C → 75 °F; humidity and wind from the station
  assert.equal(w.now, 75);
  assert.equal(w.humidity, 54);
  assert.equal(w.wind, 0);
  assert.equal(w.feels, 75); // below heat-index range: the air temperature
  assert.equal(w.cond, 'sun'); // the obs has no icon/text: the current hourly period's
  // "This Afternoon" 72 but 75 already observed; "Tonight" 63
  assert.deepEqual([w.hi, w.lo], [75, 63]);
});

test('nws: stale or missing observation → current hourly period, no station', () => {
  const old = clone(OBS);
  old.properties.timestamp = new Date(NOW - 2 * 3600e3).toISOString();
  for (const obs of [old, null, { properties: { ...OBS.properties, temperature: { value: null } } }]) {
    const w = mapNws({ hourly: HOURLY, forecast: FORECAST, obs }, opts());
    assert.equal(w.now, 71);
    assert.equal(w.cond, 'sun');
    assert.equal(w.station, undefined);
    assert.equal(w.humidity, 60);
    assert.equal(w.wind, 5);
    assert.deepEqual([w.hi, w.lo], [72, 63]);
  }
  const obsAt = Date.parse(OBS.properties.timestamp);
  assert.notEqual(freshObservation(OBS, obsAt + 89 * 60000), null);
  assert.equal(freshObservation(OBS, obsAt + 91 * 60000), null);
});

test('nws: °C observation and °F forecast both land in the owner’s units', () => {
  const obs = clone(OBS);
  obs.properties.windSpeed.value = 16.09344; // km/h
  obs.properties.temperature.value = -3;
  obs.properties.windChill.value = -8.2;
  const f = mapNws({ hourly: HOURLY, forecast: FORECAST, obs }, opts());
  assert.deepEqual([f.now, f.feels, f.wind], [27, 17, 10]);
  const c = mapNws({ hourly: HOURLY, forecast: FORECAST, obs: OBS }, opts({ units: 'celsius' }));
  assert.equal(c.units, 'celsius');
  assert.equal(c.now, 24);
  assert.equal(c.t[14], 22); // 71 °F
  assert.equal(c.lo, 17); // 63 °F
  assert.equal(c.wind, 0);
});

test('nws: hours before the first period use the observation for the current hour', () => {
  const late = clone(HOURLY);
  late.properties.periods = late.properties.periods.slice(1); // forecast starts at 15:00
  const w = mapNws({ hourly: late, forecast: FORECAST, obs: OBS }, opts());
  assert.equal(w.t[14], 75);
  assert.deepEqual(w.t.slice(0, 14), new Array(14).fill(75));
  assert.equal(w.t[15], 72);
  const none = mapNws({ hourly: late, forecast: FORECAST, obs: null }, opts());
  assert.equal(none.t[14], 72); // no observation: the nearest forecast hour
  const stale = clone(HOURLY);
  stale.properties.periods = stale.properties.periods.slice(4); // starts at 18:00: doesn't cover now
  assert.throws(() => mapNws({ hourly: stale, forecast: FORECAST, obs: OBS }, opts()), /current hour/);
});

test('nws: in the evening the high is the observed high so far vs the rest of today', () => {
  const evening = at(11, 19, 30);
  const tonight = clone(FORECAST);
  tonight.properties.periods = tonight.properties.periods.slice(1); // "This Afternoon" has passed
  const stats = { day: '2026-10-11', hi: 26, lo: 14 };
  const w = mapNws({ hourly: HOURLY, forecast: tonight, obs: OBS }, opts({ now: evening, stats }));
  assert.equal(w.station, undefined); // the 14:25 obs is stale by 19:30
  assert.deepEqual([w.hi, w.lo], [79, 63]); // 26 °C observed
  const noStats = mapNws({ hourly: HOURLY, forecast: tonight, obs: OBS }, opts({ now: evening }));
  assert.equal(noStats.hi, 66); // the rest of today: 19:00 66, 20:00 65 …
  assert.equal(mapNws({ hourly: HOURLY, forecast: tonight, obs: OBS }, opts({ now: evening, stats: { ...stats, day: '2026-10-10' } })).hi, 66);
  const noForecast = mapNws({ hourly: HOURLY, forecast: null, obs: OBS }, opts());
  assert.deepEqual([noForecast.hi, noForecast.lo], [75, 63]); // obs vs hourly; lowest hour through 05:00
});

test('nws: running observed high/low per day', () => {
  const o = (c) => ({ temperature: { value: c } });
  assert.deepEqual(nextDayStats(null, o(20), 'd1'), { day: 'd1', hi: 20, lo: 20 });
  assert.deepEqual(nextDayStats({ day: 'd1', hi: 20, lo: 20 }, o(22), 'd1'), { day: 'd1', hi: 22, lo: 20 });
  assert.equal(nextDayStats({ day: 'd1', hi: 22, lo: 20 }, o(21), 'd1'), null);
  assert.deepEqual(nextDayStats({ day: 'd1', hi: 22, lo: 20 }, o(15), 'd2'), { day: 'd2', hi: 15, lo: 15 });
  assert.equal(nextDayStats({ day: 'd1', hi: 22, lo: 20 }, null, 'd1'), null);
});

test('nws: icons and texts → the client’s condition names', () => {
  const icon = (s) => 'https://api.weather.gov/icons/land/' + s + '?size=small';
  assert.equal(nwsCondition(icon('day/skc')), 'sun');
  assert.equal(nwsCondition(icon('night/few')), 'moon');
  assert.equal(nwsCondition(icon('day/sct')), 'partly');
  assert.equal(nwsCondition(icon('night/sct')), 'moon');
  assert.equal(nwsCondition(icon('day/bkn')), 'cloud');
  assert.equal(nwsCondition(icon('day/wind_bkn')), 'cloud');
  assert.equal(nwsCondition(icon('night/fog')), 'cloud');
  assert.equal(nwsCondition(icon('day/rain_showers,70')), 'rain');
  assert.equal(nwsCondition(icon('day/tsra_hi,40/tsra_hi,70')), 'storm');
  assert.equal(nwsCondition(icon('night/rain_snow,60')), 'snow');
  assert.equal(nwsCondition(icon('day/fzra')), 'rain');
  assert.equal(nwsCondition(null, 'Light Snow and Fog/Mist', true), 'snow');
  assert.equal(nwsCondition(null, 'Thunderstorms and Rain', true), 'storm');
  assert.equal(nwsCondition(null, 'Partly Cloudy', false), 'moon');
  assert.equal(nwsCondition(null, 'Mostly Cloudy', true), 'cloud');
  assert.equal(nwsCondition(null, 'Clear', false), 'moon');
  assert.equal(nwsCondition(null, '', true, 'partly'), 'partly');
  const wet = clone(HOURLY);
  wet.properties.periods[20].icon = icon('day/rain_showers,60');
  wet.properties.periods[20].probabilityOfPrecipitation.value = 60;
  const w = mapNws({ hourly: wet, forecast: FORECAST, obs: OBS }, opts());
  assert.deepEqual([w.c[34], w.p[34], w.p[33]], ['rain', 60, 0]); // 10:00 tomorrow
});

// ------------------------------------------------------------------ I/O: point cache, subrequests
function world(overrides = {}) {
  const calls = [], kv = new Map(), waits = [];
  const routes = {
    '/points/41.85,-87.65': () => Response.json(POINTS),
    '/gridpoints/LOT/75,72/stations': () => Response.json(STATIONS),
    '/gridpoints/LOT/75,72/forecast/hourly': () => Response.json(HOURLY),
    '/gridpoints/LOT/75,72/forecast': () => Response.json(FORECAST),
    '/stations/KMDW/observations/latest': () => Response.json(OBS),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    assert.match(init.headers['User-Agent'], /github\.com\/peterbinks\/photo-frame-dashboard/);
    assert.equal(init.headers.Accept, 'application/geo+json');
    const r = routes[u.pathname];
    return r ? r(u) : new Response('{}', { status: 404 });
  };
  const store = {
    get: async (k, o) => { const v = kv.get(k); return v == null ? null : o && o.type === 'json' ? JSON.parse(v) : v; },
    put: async (k, v, o) => { kv.set(k, v); kv.set(k + '#ttl', o && o.expirationTtl); },
  };
  const ctx = { waitUntil: (p) => waits.push(p) };
  const run = async (args = {}) => {
    const w = await nwsWeather({ lat: 41.85, lon: -87.65, tz: TZ, units: 'fahrenheit', city: '', kv: store, ctx, now: NOW, ...args }, fetchImpl);
    await Promise.all(waits);
    return w;
  };
  return { calls, kv, store, ctx, run, fetchImpl, waits };
}

test('nws: point + station cached in KV; 3 subrequests per refresh afterwards', async () => {
  const x = world();
  const w = await x.run();
  assert.equal(w.source, 'nws');
  assert.equal(w.city, 'Chicago'); // from the point when settings have none
  assert.deepEqual(x.calls.sort(), [
    '/gridpoints/LOT/75,72/forecast/hourly?units=us', '/gridpoints/LOT/75,72/forecast?units=us',
    '/gridpoints/LOT/75,72/stations?limit=1', '/points/41.85,-87.65', '/stations/KMDW/observations/latest',
  ]);
  assert.deepEqual(JSON.parse(x.kv.get('nws:point:41.85,-87.65')).station, 'KMDW');
  assert.ok(x.kv.get('nws:point:41.85,-87.65#ttl') >= 86400);
  assert.deepEqual(JSON.parse(x.kv.get('nws:obsday:KMDW')), { day: '2026-10-11', hi: 24, lo: 24 });
  x.calls.length = 0;
  const again = await x.run({ units: 'celsius' });
  assert.equal(x.calls.length, 3);
  assert.ok(x.calls.includes('/gridpoints/LOT/75,72/forecast/hourly?units=si'));
  assert.equal(again.units, 'celsius');
});

test('nws: optional parts may fail; the hourly forecast may not', async () => {
  const noObs = world({ '/stations/KMDW/observations/latest': () => new Response('', { status: 500 }), '/gridpoints/LOT/75,72/forecast': () => new Response('', { status: 503 }) });
  const w = await noObs.run();
  assert.equal(w.now, 71);
  assert.equal(w.station, undefined);
  assert.deepEqual([w.hi, w.lo], [72, 63]);
  await assert.rejects(world({ '/gridpoints/LOT/75,72/forecast/hourly': () => new Response('', { status: 500 }) }).run(), /HTTP 500/);
  const timeout = () => { throw new DOMException('The operation timed out', 'TimeoutError'); };
  await assert.rejects(world({ '/gridpoints/LOT/75,72/forecast/hourly': timeout }).run(), /timed out/);
});

test('nws: outside the US (404) is remembered, other failures are not', async () => {
  const x = world();
  await assert.rejects(nwsPoint(51.5, -0.12, x.store, x.ctx, x.fetchImpl), /404/);
  await Promise.all(x.waits);
  assert.deepEqual(JSON.parse(x.kv.get('nws:point:51.5,-0.12')), { none: true });
  x.calls.length = 0;
  await assert.rejects(nwsPoint(51.5, -0.12, x.store, x.ctx, x.fetchImpl), /No NWS forecast/);
  assert.equal(x.calls.length, 0, 'no request for a known non-US point');
  const down = world({ '/points/41.85,-87.65': () => new Response('', { status: 500 }) });
  await assert.rejects(down.run(), /500/);
  await Promise.all(down.waits);
  assert.equal(down.kv.has('nws:point:41.85,-87.65'), false);
});
