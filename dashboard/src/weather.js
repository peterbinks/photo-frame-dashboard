// Open-Meteo (no key) → the weather shape the views use; the fallback when the National Weather
// Service (nws.js) can't answer. Hourly arrays start at today's local midnight and cover 48 hours,
// so index = hour of day today (24–47 = tomorrow).
import { dayKey } from './time.js';

// WMO weather codes → icon names in js/icons.js
export function condition(code, isDay) {
  if (code === 0 || code === 1) return isDay ? 'sun' : 'moon';
  if (code === 2) return isDay ? 'partly' : 'moon';
  if (code === 3 || code === 45 || code === 48) return 'cloud';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  if (code >= 51 && code <= 82) return 'rain';
  return 'cloud';
}

export function unitsFor(env, country) {
  const u = String(env.UNITS || '').toLowerCase();
  if (u === 'fahrenheit' || u === 'f' || u === 'imperial') return 'fahrenheit';
  if (u === 'celsius' || u === 'c' || u === 'metric') return 'celsius';
  return ['US', 'LR', 'MM', 'PR', 'GU', 'VI', 'AS', 'MP', 'BS', 'KY', 'BZ', 'PW', 'FM', 'MH'].indexOf(country) > -1 ? 'fahrenheit' : 'celsius';
}

export async function fetchWeather({ lat, lon, tz, units }, fetchImpl = fetch) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: tz, forecast_days: '3',
    hourly: 'temperature_2m,precipitation_probability,weather_code,is_day',
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    daily: 'temperature_2m_max,temperature_2m_min',
    temperature_unit: units, wind_speed_unit: units === 'fahrenheit' ? 'mph' : 'kmh',
  });
  const res = await fetchImpl('https://api.open-meteo.com/v1/forecast?' + q);
  if (!res.ok) throw new Error('Open-Meteo HTTP ' + res.status);
  return res.json();
}

export function mapWeather(raw, { tz, units, city, now = Date.now() }) {
  const H = raw.hourly || {}, C = raw.current || {}, D = raw.daily || {};
  const today = dayKey(now, tz);
  const start = (H.time || []).findIndex((t) => t.slice(0, 10) === today);
  const from = start < 0 ? 0 : start;
  const r = (x) => (x == null ? null : Math.round(x));
  const t = [], c = [], p = [];
  for (let i = from; i < from + 48 && i < (H.time || []).length; i++) {
    t.push(r(H.temperature_2m[i]));
    c.push(condition(H.weather_code[i], H.is_day[i]));
    p.push(H.precipitation_probability[i] == null ? 0 : H.precipitation_probability[i]);
  }
  const di = Math.max(0, (D.time || []).indexOf(today));
  return {
    day: today, units, city: city || '',
    now: r(C.temperature_2m), cond: condition(C.weather_code, C.is_day),
    hi: r((D.temperature_2m_max || [])[di]), lo: r((D.temperature_2m_min || [])[di]),
    feels: r(C.apparent_temperature), humidity: r(C.relative_humidity_2m), wind: r(C.wind_speed_10m),
    t, c, p,
    source: 'open-meteo',
    updated: now,
  };
}
