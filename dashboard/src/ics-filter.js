// Cheap, dependency-free trim of an ICS feed to a date window. Runs in the Worker (10 ms CPU budget
// on the free plan), so it only does linear string scanning: one-off VEVENTs far outside the window
// are dropped, recurring ones and their overrides are kept, and bulky properties the dashboard never
// shows (attendees, attachments, conference data, X- extensions) are stripped. Full parsing and
// RRULE expansion happen on the client (src/calendar.js).

// Properties removed from kept events (plus every X-* property)
const DROP = new Set(['ATTENDEE', 'ORGANIZER', 'ATTACH', 'CONFERENCE', 'DTSTAMP', 'CREATED', 'LAST-MODIFIED', 'SEQUENCE', 'TRANSP', 'CLASS', 'URL', 'CONTACT', 'COMMENT', 'GEO', 'PRIORITY', 'CATEGORIES', 'RESOURCES', 'IMAGE']);
const ANCHORS = ['\nDTSTART', '\nDTEND', '\nRECURRENCE-ID'];

// FNV-1a → short base36 id that is safe inside HTML attributes.
export function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/** Calendar window from ?from=&to= (YYYY-MM-DD in tz); default today −7 … +60, at most 400 days. */
export function windowFromQuery(params, today) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = ok(params.get('from')) ? params.get('from') : shiftDay(today, -7);
  let to = ok(params.get('to')) ? params.get('to') : shiftDay(today, 60);
  if (to <= from) to = shiftDay(from, 1);
  if (to > shiftDay(from, 400)) to = shiftDay(from, 400);
  return { from, to };
}

function compact(day) { return day.replace(/-/g, ''); }
function shiftDay(key, n) {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

// Drop DROP/X- properties (with their folded continuation lines) from one VEVENT block.
function strip(block) {
  const lines = block.split('\n');
  const out = [];
  let dropping = false;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
    if (l.charCodeAt(0) === 32 || l.charCodeAt(0) === 9) { if (!dropping) out.push(l); continue; }
    const end = l.search(/[;:]/);
    const name = end < 0 ? l : l.slice(0, end);
    dropping = DROP.has(name) || (name.charCodeAt(0) === 88 && name.charCodeAt(1) === 45); // "X-"
    if (!dropping) out.push(l);
  }
  return out.join('\n');
}

/**
 * @param {string} text  raw ICS (CRLF or LF)
 * @param {string} from  YYYY-MM-DD (inclusive)
 * @param {string} to    YYYY-MM-DD (exclusive)
 * @returns {string} ICS with only what the window needs (kept events are LF-separated)
 */
export function prefilterIcs(text, from, to) {
  const lo = compact(shiftDay(from, -2));
  const hi = compact(shiftDay(to, 2));
  // Next position of each marker, re-searched only once the scan has passed it: the whole pass
  // stays linear in the feed size (no per-block regex, no copy of the whole text).
  const next = {};
  function inBlock(marker, s, e) {
    let i = next[marker];
    if (i === undefined || (i !== -1 && i < s)) i = next[marker] = text.indexOf(marker, s);
    return i > -1 && i < e ? i : -1;
  }
  const out = [];
  let pos = 0;
  for (;;) {
    const s = text.indexOf('BEGIN:VEVENT', pos);
    if (s < 0) { out.push(text.slice(pos)); break; }
    out.push(text.slice(pos, s));
    const e = text.indexOf('END:VEVENT', s);
    if (e < 0) { out.push(text.slice(s)); break; }
    const end = e + 10;
    pos = end;
    if (inBlock('\nRRULE', s, e) > -1 || inBlock('\nRDATE', s, e) > -1) { out.push(strip(text.slice(s, end))); continue; }
    let first = null, last = null, inside = false;
    for (let a = 0; a < ANCHORS.length; a++) {
      const i = inBlock(ANCHORS[a], s, e);
      if (i < 0) continue;
      const d = text.substr(text.indexOf(':', i + 1) + 1, 8);
      if (!/^\d{8}$/.test(d)) continue;
      if (first === null || d < first) first = d;
      if (last === null || d > last) last = d;
      if (d >= lo && d <= hi) inside = true;
    }
    // Keep if it overlaps the window, any anchor (e.g. RECURRENCE-ID) is inside it, or it has no
    // parsable date at all (let the real parser decide).
    if (first === null || inside || (first <= hi && last >= lo)) out.push(strip(text.slice(s, end)));
  }
  return out.join('');
}
