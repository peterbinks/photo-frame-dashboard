// US Air Quality Index from Open-Meteo's air-quality API (CAMS model, global, no key).
// Forecast/model values, not EPA AirNow observations (AirNow needs an API key).
const URL_BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TIMEOUT_MS = 8000;

// EPA AQI categories.
const BANDS = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
const POLLUTANTS = { us_aqi_pm2_5: 'Fine particles (PM2.5)', us_aqi_pm10: 'Dust (PM10)', us_aqi_ozone: 'Ozone', us_aqi_nitrogen_dioxide: 'Nitrogen dioxide' };

/** AQI → { aqi, level 0–5, label }, or null when missing. */
export function rateAqi(aqi) {
  if (typeof aqi !== 'number' || !isFinite(aqi)) return null;
  const v = Math.max(0, Math.round(aqi));
  const level = BANDS.findIndex((b) => v <= b[0]);
  return { aqi: v, level, label: BANDS[level][1] };
}

/** Open-Meteo answer → { now, main, today, tomorrow }. Hourly times are local (timezone=tz). */
export function mapAir(json, todayKey, tomorrowKey) {
  const c = (json && json.current) || {};
  const now = rateAqi(c.us_aqi);
  if (!now) throw new Error('Open-Meteo: no air quality for this place');
  let main = null, best = -1;
  for (const k of Object.keys(POLLUTANTS)) if (typeof c[k] === 'number' && c[k] > best) { best = c[k]; main = POLLUTANTS[k]; }
  const h = (json && json.hourly) || {};
  const peak = (key) => {
    let m = null;
    (h.time || []).forEach((t, i) => { const v = (h.us_aqi || [])[i]; if (String(t).slice(0, 10) === key && typeof v === 'number' && (m === null || v > m)) m = v; });
    return rateAqi(m);
  };
  return { source: 'open-meteo', now: { ...now, main }, today: peak(todayKey), tomorrow: peak(tomorrowKey) };
}

export async function fetchAir({ lat, lon, tz, todayKey, tomorrowKey, fetchImpl = fetch }) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), timezone: tz, forecast_days: '2',
    current: 'us_aqi,' + Object.keys(POLLUTANTS).join(','), hourly: 'us_aqi',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(URL_BASE + '?' + q, { signal: ac.signal });
    if (!res.ok) throw new Error('Open-Meteo air quality HTTP ' + res.status);
    return mapAir(await res.json(), todayKey, tomorrowKey);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Open-Meteo air quality timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
