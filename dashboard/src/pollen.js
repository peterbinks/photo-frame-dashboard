// Pollen forecast from pollen.com (IQVIA): the JSON its own website uses (Home Assistant's IQVIA
// integration reads the same). US ZIP codes only. Unofficial: it refuses requests without a
// pollen.com Referer (HTTP 405), and its shape could change without notice.
const BASE = 'https://www.pollen.com/api/forecast/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TIMEOUT_MS = 8000;

// pollen.com's 0–12 scale bands (same for the asthma and cold & flu indices).
const BANDS = [[2.4, 'Low'], [4.8, 'Low–medium'], [7.2, 'Medium'], [9.6, 'Medium–high'], [Infinity, 'High']];

/** Index → { index, level 0–4, label }, or null when the value is missing. */
export function rate(index) {
  if (typeof index !== 'number' || !isFinite(index)) return null;
  const i = Math.max(0, Math.min(12, Math.round(index * 10) / 10));
  const level = BANDS.findIndex((b) => i <= b[0]);
  return { index: i, level, label: BANDS[level][1] };
}

/** A US ZIP code from a place label ("Chicago, IL 60618", "Chicago 60618"), else null. */
export function zipFrom(label) {
  const m = String(label || '').match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

async function get(kind, type, zip, fetchImpl) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(BASE + kind + '/' + type + '/' + zip, {
      headers: { Accept: 'application/json', Referer: 'https://www.pollen.com/forecast/' + kind + '/' + type + '/' + zip, 'User-Agent': UA },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error('pollen.com HTTP ' + res.status);
    const j = await res.json();
    if (!j || !j.Location || !Array.isArray(j.Location.periods)) throw new Error('pollen.com: unexpected answer');
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('pollen.com timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function period(json, type) {
  return ((json && json.Location && json.Location.periods) || []).find((p) => p.Type === type) || null;
}
function day(json, type) {
  const p = period(json, type);
  const r = p && rate(p.Index);
  if (!r) return null;
  const seen = new Set();
  const triggers = (p.Triggers || []).filter((t) => t && t.Name && !seen.has(t.Name) && seen.add(t.Name))
    .slice(0, 4).map((t) => ({ name: String(t.Name), type: String(t.PlantType || '') }));
  return { ...r, triggers };
}

/** pollen.com answers → the dashboard's pollen shape. `asthma`/`cold` may be null. */
export function mapPollen(zip, current, extended, asthma, cold) {
  const today = day(current, 'Today');
  if (!today) throw new Error('pollen.com: no forecast for ' + zip);
  const start = String(current.ForecastDate || '').slice(0, 10);
  const days = ((extended && extended.Location.periods) || []).map((p) => {
    const r = rate(p.Index);
    return r && { date: String(p.Period || '').slice(0, 10), ...r };
  }).filter((d) => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && (!start || d.date >= start)).slice(0, 5);
  const index = (json) => json && { today: day(json, 'Today'), tomorrow: day(json, 'Tomorrow') };
  return {
    source: 'pollen.com',
    zip,
    place: String(current.Location.DisplayLocation || ''),
    today,
    tomorrow: day(current, 'Tomorrow'),
    days,
    asthma: index(asthma),
    cold: index(cold),
    updated: Date.now(),
  };
}

/** Fetch everything for one ZIP: the pollen forecast is required, the rest is best effort. */
export async function fetchPollen(zip, { fetchImpl = fetch } = {}) {
  const [current, extended, asthma, cold] = await Promise.allSettled([
    get('current', 'pollen', zip, fetchImpl),
    get('extended', 'pollen', zip, fetchImpl),
    get('current', 'asthma', zip, fetchImpl),
    get('current', 'cold', zip, fetchImpl),
  ]);
  if (current.status === 'rejected') throw current.reason;
  const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
  return mapPollen(zip, current.value, ok(extended), ok(asthma), ok(cold));
}
