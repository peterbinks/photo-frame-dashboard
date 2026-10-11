// Timezone helpers built on Intl (Workers run in UTC; the family lives in env.TZ).

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { partsFormatter(tz); return true; } catch { return false; }
}

/** Wall-clock parts of an instant in tz. */
export function zonedParts(ms, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

// UTC offset of tz at an instant. Offsets only change on hour boundaries in practice, so cache per
// hour: expanding years of recurring events would otherwise call Intl thousands of times.
const offsetCache = new Map();
function offsetAt(ms, tz) {
  const key = tz + '|' + Math.floor(ms / 3600000);
  let o = offsetCache.get(key);
  if (o === undefined) {
    const hour = Math.floor(ms / 3600000) * 3600000;
    const p = zonedParts(hour, tz);
    o = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - hour;
    if (offsetCache.size > 20000) offsetCache.clear();
    offsetCache.set(key, o);
  }
  return o;
}

/** Instant for a wall-clock time in tz (DST gaps resolve forward, overlaps to the first instant). */
export function wallToEpoch(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const o1 = offsetAt(guess - offsetAt(guess, tz), tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

/** YYYY-MM-DD of an instant in tz. */
export function dayKey(ms, tz) {
  const p = zonedParts(ms, tz);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}

export function addDaysKey(key, n) {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10) + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/** 0 = Monday … 6 = Sunday for a YYYY-MM-DD key. */
export function weekdayMon(key) {
  return (new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))).getUTCDay() + 6) % 7;
}
