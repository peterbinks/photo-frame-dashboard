import test from 'node:test';
import assert from 'node:assert/strict';
import { rate, zipFrom, mapPollen, fetchPollen } from '../src/pollen.js';
import { rateAqi, mapAir } from '../src/airquality.js';

// Shapes as pollen.com returns them (trimmed, synthetic values).
const CURRENT = {
  Type: 'pollen', ForecastDate: '2026-10-11T00:00:00-04:00',
  Location: {
    ZIP: '60601', City: 'CHICAGO', State: 'IL', DisplayLocation: 'Chicago, IL',
    periods: [
      { Type: 'Yesterday', Index: 2.0, Triggers: [] },
      { Type: 'Today', Index: 3.5, Triggers: [{ Name: 'Ragweed', PlantType: 'Ragweed' }, { Name: 'Chenopods', PlantType: 'Ragweed' }, { Name: 'Ragweed', PlantType: 'Ragweed' }] },
      { Type: 'Tomorrow', Index: 4.85, Triggers: [{ Name: 'Ragweed', PlantType: 'Ragweed' }] },
    ],
  },
};
const EXTENDED = {
  Type: 'pollen', ForecastDate: '2026-10-11T00:00:00-04:00',
  Location: { ZIP: '60601', periods: ['3.5', '4.8', '5.2', '2.4', '3.0', '9.9'].map((v, i) => ({ Period: '2026-10-' + (11 + i) + 'T21:23:54.61', Index: +v })) },
};
const ASTHMA = { Location: { periods: [{ Type: 'Today', Index: 4.0, Triggers: [] }, { Type: 'Tomorrow', Index: 7.5, Triggers: [] }] } };

test('pollen.com scale bands and ZIP extraction', () => {
  assert.deepEqual([0, 2.4, 2.5, 4.8, 4.85, 7.2, 9.6, 9.7, 12, 15].map((v) => rate(v).label),
    ['Low', 'Low', 'Low–medium', 'Low–medium', 'Medium', 'Medium', 'Medium–high', 'High', 'High', 'High']);
  assert.equal(rate(15).index, 12);
  assert.equal(rate(null), null);
  assert.equal(zipFrom('Chicago, IL 60601'), '60601');
  assert.equal(zipFrom('Chicago 60601'), '60601');
  assert.equal(zipFrom('Chicago'), null);
  assert.equal(zipFrom('Unit 123456'), null);
});

test('mapPollen: today/tomorrow with de-duplicated triggers, 5 days from today, optional extras', () => {
  const p = mapPollen('60601', CURRENT, EXTENDED, ASTHMA, null);
  assert.deepEqual(p.today, { index: 3.5, level: 1, label: 'Low–medium', triggers: [{ name: 'Ragweed', type: 'Ragweed' }, { name: 'Chenopods', type: 'Ragweed' }] });
  assert.equal(p.tomorrow.label, 'Medium');
  assert.deepEqual(p.days.map((d) => [d.date, d.index]), [['2026-10-11', 3.5], ['2026-10-12', 4.8], ['2026-10-13', 5.2], ['2026-10-14', 2.4], ['2026-10-15', 3]]);
  assert.equal(p.asthma.today.index, 4);
  assert.equal(p.asthma.tomorrow.label, 'Medium–high');
  assert.equal(p.cold, null);
  assert.equal(p.place, 'Chicago, IL');
  assert.throws(() => mapPollen('60601', { Location: { periods: [] } }, null, null, null), /no forecast/);
});

test('fetchPollen sends a pollen.com Referer; only the current forecast is required', async () => {
  const seen = [];
  const fetchImpl = async (u, init) => {
    seen.push([u, init.headers.Referer]);
    if (u.endsWith('/current/pollen/60601')) return Response.json(CURRENT);
    if (u.endsWith('/current/asthma/60601')) return Response.json(ASTHMA);
    return new Response('nope', { status: 405 });
  };
  const p = await fetchPollen('60601', { fetchImpl });
  assert.equal(seen.length, 4);
  for (const [u, ref] of seen) assert.equal(ref, u.replace('/api/forecast/', '/forecast/'));
  assert.equal(p.today.index, 3.5);
  assert.deepEqual(p.days, []);
  assert.equal(p.cold, null);
  await assert.rejects(fetchPollen('60601', { fetchImpl: async () => new Response('', { status: 405 }) }), /HTTP 405/);
});

test('AQI bands, main pollutant and daily peaks', () => {
  assert.deepEqual([0, 50, 51, 100, 101, 151, 201, 301].map((v) => rateAqi(v).label),
    ['Good', 'Good', 'Moderate', 'Moderate', 'Unhealthy for sensitive groups', 'Unhealthy', 'Very unhealthy', 'Hazardous']);
  const a = mapAir({
    current: { us_aqi: 55.4, us_aqi_pm2_5: 55, us_aqi_ozone: 32, us_aqi_pm10: 20, us_aqi_nitrogen_dioxide: null },
    hourly: { time: ['2026-10-11T22:00', '2026-10-11T23:00', '2026-10-12T00:00', '2026-10-12T01:00'], us_aqi: [58, 60, 120, null] },
  }, '2026-10-11', '2026-10-12');
  assert.deepEqual(a.now, { aqi: 55, level: 1, label: 'Moderate', main: 'Fine particles (PM2.5)' });
  assert.equal(a.today.aqi, 60);
  assert.deepEqual(a.tomorrow, { aqi: 120, level: 2, label: 'Unhealthy for sensitive groups' });
  assert.throws(() => mapAir({ current: {} }, '2026-10-11', '2026-10-12'), /no air quality/);
});
