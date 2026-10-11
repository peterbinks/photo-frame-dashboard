import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState, rollover, sanitize } from '../src/state.js';
import { parseAlbumLink, initialHost, pickDerivative, fetchAlbum } from '../src/icloud.js';
import { mapWeather, condition, unitsFor } from '../src/weather.js';
import { wallToEpoch } from '../src/time.js';

const TZ = 'America/Chicago';
const members = [{ id: 'pat', name: 'Pat', kid: false }, { id: 'riley', name: 'Riley', kid: true }];
const at = (y, m, d, h) => wallToEpoch(y, m, d, h, 0, 0, TZ);

test('seed is built from the configured family only', () => {
  const doc = seedState(members, TZ, at(2026, 10, 7, 9));
  assert.equal(doc.rev, 1);
  assert.deepEqual(doc.stars, { riley: 0 });
  assert.deepEqual(Object.keys(doc.week), ['riley']);
  assert.ok(doc.chores.every((c) => c.who === 'riley' || c.who === 'any'));
  assert.deepEqual(doc.groceries, []);
});

test('rollover records the week strip, unticks chores, resets on Monday', () => {
  const doc = seedState(members, TZ, at(2026, 10, 7, 9)); // Wednesday
  doc.chores.filter((c) => c.who === 'riley').forEach((c) => { c.done = true; c.doneBy = 'riley'; });
  assert.equal(rollover(doc, members, TZ, at(2026, 10, 7, 23)), false); // same day
  assert.equal(rollover(doc, members, TZ, at(2026, 10, 8, 7)), true); // Thursday
  assert.equal(doc.week.riley[2], 1); // Wednesday = all done
  assert.ok(doc.chores.every((c) => !c.done && !c.doneBy));
  rollover(doc, members, TZ, at(2026, 10, 9, 7)); // Friday: Thursday had nothing done
  assert.equal(doc.week.riley[3], 0);
  rollover(doc, members, TZ, at(2026, 10, 12, 7)); // next Monday
  assert.deepEqual(doc.week.riley, [null, null, null, null, null, null, null]);
  assert.equal(doc.weekStart, '2026-10-12');
});

test('PUT bodies are validated', () => {
  assert.match(sanitize([1]), /JSON object/);
  assert.match(sanitize({ groceries: [] }), /rev/);
  assert.match(sanitize({ rev: 1, stars: [] }), /stars/);
  assert.deepEqual(sanitize({ rev: 3, groceries: [], junk: 1 }), { groceries: [] });
});

test('iCloud links (both formats), partition host and derivative choice', () => {
  assert.deepEqual(parseAlbumLink('https://www.icloud.com/sharedalbum/#B1d5oqs3q2iqS4D'), { kind: 'stream', token: 'B1d5oqs3q2iqS4D' });
  assert.deepEqual(parseAlbumLink('https://www.icloud.com/sharedalbum/en-us/#B1d5oqs3q2iqS4D'), { kind: 'stream', token: 'B1d5oqs3q2iqS4D' });
  assert.deepEqual(parseAlbumLink('B1d5oqs3q2iqS4D'), { kind: 'stream', token: 'B1d5oqs3q2iqS4D' });
  assert.deepEqual(parseAlbumLink(' https://photos.icloud.com/shared/album/0abCDefGhijk_LmnoPqrs-Tu '), { kind: 'cloudkit', token: '0abCDefGhijk_LmnoPqrs-Tu' });
  assert.deepEqual(parseAlbumLink('https://photos.icloud.com/shared/album/0abCDefGhijk_LmnoPqrs-Tu/?x=1'), { kind: 'cloudkit', token: '0abCDefGhijk_LmnoPqrs-Tu' });
  assert.deepEqual(parseAlbumLink('0abCDefGhijk_LmnoPqrs-Tu'), { kind: 'cloudkit', token: '0abCDefGhijk_LmnoPqrs-Tu' });
  assert.equal(parseAlbumLink('https://example.com/nope'), null);
  assert.equal(parseAlbumLink('https://photos.icloud.com.evil.example/shared/album/0abCDefGhijk_LmnoPqrs-Tu'), null);
  assert.equal(initialHost('B1d5oqs3q2iqS4D'), 'p101-sharedstreams.icloud.com');
  assert.equal(initialHost('A5abc'), 'p05-sharedstreams.icloud.com');
  const photo = { derivatives: { 342: { checksum: 'small', width: '257', height: '342' }, 1600: { checksum: 'mid', width: '1200', height: '1600' }, 2049: { checksum: 'big', width: '1537', height: '2049' } } };
  assert.equal(pickDerivative(photo).checksum, 'mid');
  assert.equal(pickDerivative({ derivatives: { 342: { checksum: 's', width: '257', height: '342' } } }).checksum, 's');
  assert.equal(pickDerivative({ mediaAssetType: 'video', derivatives: { PosterFrame: { checksum: 'p' } } }), null);
});

test('iCloud album: follows the 330 host redirect and maps photos', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.startsWith('https://p101-')) return new Response('{"X-Apple-MMe-Host":"p42-sharedstreams.icloud.com"}', { status: 330, headers: { 'X-Apple-MMe-Host': 'p42-sharedstreams.icloud.com' } });
    return Response.json({
      streamName: 'Family',
      photos: [
        { photoGuid: 'G1', batchGuid: 'B1', dateCreated: '2025-03-14T07:51:41Z', contributorFirstName: 'Riley', caption: '', derivatives: { 2049: { checksum: 'c1', width: '2049', height: '1537' } } },
        { photoGuid: 'G2', batchGuid: 'B1', mediaAssetType: 'video', derivatives: { PosterFrame: { checksum: 'c2', width: '720', height: '1280' } } },
      ],
    });
  };
  const a = await fetchAlbum('B1d5oqs3q2iqS4D', 0, { members, fetchImpl: fake });
  assert.deepEqual(calls.map((u) => new URL(u).host), ['p101-sharedstreams.icloud.com', 'p42-sharedstreams.icloud.com']);
  assert.equal(a.host, 'p42-sharedstreams.icloud.com');
  assert.deepEqual(a.checksums, { G1: 'c1' });
  assert.deepEqual(a.photos[0], { id: 'G1', url: '/api/photo/0/G1', o: 'l', w: 2049, h: 1537, date: '2025-03-14T07:51:41Z', place: 'Family', from: 'riley', by: 'Riley', tag: 'B1', album: 0 });
});

test('weather maps Open-Meteo to hour-of-day arrays and icons', () => {
  const time = [], temperature_2m = [], code = [], isDay = [], pp = [];
  for (let d = 9; d <= 11; d++) for (let h = 0; h < 24; h++) {
    time.push('2026-10-' + d + 'T' + String(h).padStart(2, '0') + ':00');
    temperature_2m.push(50 + h); code.push(h === 15 ? 61 : 0); isDay.push(h >= 7 && h < 19 ? 1 : 0); pp.push(h === 15 ? 80 : 0);
  }
  const raw = {
    hourly: { time, temperature_2m, weather_code: code, is_day: isDay, precipitation_probability: pp },
    current: { temperature_2m: 61.4, apparent_temperature: 59, relative_humidity_2m: 70, wind_speed_10m: 8, weather_code: 0, is_day: 0 },
    daily: { time: ['2026-10-09', '2026-10-10', '2026-10-11'], temperature_2m_max: [70, 80, 75], temperature_2m_min: [50, 55, 52] },
  };
  const w = mapWeather(raw, { tz: TZ, units: 'fahrenheit', city: 'Chicago', now: at(2026, 10, 10, 22) });
  assert.equal(w.day, '2026-10-10');
  assert.equal(w.t.length, 48);
  assert.equal(w.t[0], 50);
  assert.equal(w.c[15], 'rain');
  assert.equal(w.c[3], 'moon');
  assert.equal(w.c[12], 'sun');
  assert.deepEqual([w.now, w.hi, w.lo, w.cond, w.source], [61, 80, 55, 'moon', 'open-meteo']);
  assert.equal(condition(73, 1), 'snow');
  assert.equal(condition(95, 1), 'storm');
  assert.equal(unitsFor({}, 'US'), 'fahrenheit');
  assert.equal(unitsFor({}, 'CA'), 'celsius');
  assert.equal(unitsFor({ UNITS: 'celsius' }, 'US'), 'celsius');
});
