// Google Calendar "secret address in iCal format" → events in the shape the calendar views use.
// Expands RRULE/RDATE/EXDATE and RECURRENCE-ID overrides with ical.js. Runs on the client (in a Web
// Worker, js/calendar-worker.js) and in the setup script — never in the Cloudflare Worker, whose
// CPU budget is too small for it.
import ICAL from 'ical.js';
import { addDaysKey, wallToEpoch, isValidTz } from './time.js';
import { prefilterIcs, hashId } from './ics-filter.js';

const MAX_OCCURRENCES = 20000; // per recurring event, guards against runaway rules
const SLACK = 2 * 864e5; // wall-clock-as-UTC is within ±14 h of the real instant; 2 days is plenty

function epochOf(t, tz) {
  const zone = t.zone && t.zone.tzid;
  if (zone === 'UTC' || zone === 'Z') return t.toUnixTime() * 1000;
  if (zone && zone !== 'floating' && ICAL.TimezoneService.has(zone)) return t.toUnixTime() * 1000;
  // Floating time, or a TZID without a VTIMEZONE block: interpret the wall clock in that IANA zone
  // if it is one, else in the frame's zone.
  const named = t.timezone && isValidTz(t.timezone) ? t.timezone : zone && isValidTz(zone) ? zone : tz;
  return wallToEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, named);
}
// Cheap position of an occurrence slot for skipping (no timezone math)
function roughMs(t) { return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second); }

function pad(n) { return (n < 10 ? '0' : '') + n; }
function dateKeyOf(t) { return t.year + '-' + pad(t.month) + '-' + pad(t.day); }

// Google descriptions are HTML-ish.
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 600);
}

/**
 * @param {string} text  ICS (raw or already prefiltered)
 * @param {{from: string, to: string, tz: string}} win  from/to are YYYY-MM-DD (inclusive from, exclusive to) in tz
 * @returns {Array<{uid, title, start, end, allDay?, loc?, notes?}>} start/end: epoch ms for timed, YYYY-MM-DD for all-day
 */
export function expandIcs(text, win) {
  const { from, to, tz } = win;
  if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new Error('Not an iCalendar file');
  const fromMs = wallToEpoch(+from.slice(0, 4), +from.slice(5, 7), +from.slice(8, 10), 0, 0, 0, tz);
  const toMs = wallToEpoch(+to.slice(0, 4), +to.slice(5, 7), +to.slice(8, 10), 0, 0, 0, tz);
  const comp = new ICAL.Component(ICAL.parse(prefilterIcs(text, from, to)));
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid');
    if (id && !ICAL.TimezoneService.has(id)) ICAL.TimezoneService.register(vtz);
  }

  const groups = new Map();
  for (const v of comp.getAllSubcomponents('vevent')) {
    const uid = v.getFirstPropertyValue('uid') || 'nouid-' + groups.size;
    let g = groups.get(uid);
    if (!g) groups.set(uid, (g = { masters: [], exceptions: [] }));
    (v.hasProperty('recurrence-id') ? g.exceptions : g.masters).push(v);
  }

  const out = [];
  function emit(uid, item, startT, endT) {
    const c = item.component || item;
    if (String(c.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const ev = { uid, title: String(c.getFirstPropertyValue('summary') || '(No title)').trim() };
    if (startT.isDate) {
      const s = dateKeyOf(startT);
      const e = endT && dateKeyOf(endT) > s ? dateKeyOf(endT) : addDaysKey(s, 1);
      if (e <= from || s >= to) return;
      ev.allDay = true; ev.start = s; ev.end = e;
    } else {
      if (roughMs(startT) - SLACK >= toMs || roughMs(endT || startT) + SLACK <= fromMs) return;
      const s = epochOf(startT, tz);
      let e = endT ? epochOf(endT, tz) : s;
      if (e < s) e = s;
      if (e <= fromMs && !(e === s && s >= fromMs)) return;
      if (s >= toMs) return;
      ev.start = s; ev.end = e;
    }
    const loc = c.getFirstPropertyValue('location');
    if (loc) ev.loc = String(loc).trim();
    const notes = cleanText(c.getFirstPropertyValue('description'));
    if (notes) ev.notes = notes;
    out.push(ev);
  }
  // Is an occurrence slot (original start) before / after the window, with slack?
  function before(t) { return t.isDate ? dateKeyOf(t) < addDaysKey(from, -2) : roughMs(t) + SLACK < fromMs; }
  function after(t) { return t.isDate ? dateKeyOf(t) > addDaysKey(to, 2) : roughMs(t) - SLACK > toMs; }

  for (const [uid, g] of groups) {
    if (!g.masters.length) {
      // Orphan overrides (e.g. a single invited instance of someone else's series)
      for (const x of g.exceptions) { const e = new ICAL.Event(x, { exceptions: [] }); emit(uid, e, e.startDate, e.endDate); }
      continue;
    }
    for (const m of g.masters) {
      const event = new ICAL.Event(m, { strictExceptions: true, exceptions: g.exceptions });
      if (!event.startDate) continue;
      if (!event.isRecurring()) { emit(uid, event, event.startDate, event.endDate); continue; }
      const it = event.iterator();
      for (let n = 0, next; (next = it.next()) && n < MAX_OCCURRENCES; n++) {
        if (after(next)) break;
        if (before(next)) continue; // years of history: skip without resolving details
        const d = event.getOccurrenceDetails(next);
        emit(uid, d.item, d.startDate, d.endDate);
      }
      // Overrides whose original slot was skipped above but which were moved into the window
      for (const x of g.exceptions) {
        const rid = x.getFirstPropertyValue('recurrence-id');
        if (rid && (before(rid) || after(rid))) { const e = new ICAL.Event(x, { exceptions: [] }); emit(uid, e, e.startDate, e.endDate); }
      }
    }
  }
  return out;
}

/**
 * Merge per-calendar results into the events the views use. The same event shared into several
 * family calendars shows once, with everyone on it.
 * @param {Array<{events?: Array, error?: string}>} results  expandIcs output per calendar (same order)
 * @param {Array<{name, color, people}>} calendars
 * @param {string[]} memberOrder  family ids in display order
 */
export function mergeCalendars(results, calendars, memberOrder) {
  const byKey = new Map();
  results.forEach((r, i) => {
    const cal = calendars[i];
    for (const ev of r.events || []) {
      const k = ev.uid + '|' + ev.start;
      const prev = byKey.get(k);
      if (prev) { for (const p of cal.people) if (prev.people.indexOf(p) < 0) prev.people.push(p); continue; }
      const out = { id: 'g' + hashId(k), title: ev.title, start: ev.start, end: ev.end, people: cal.people.slice(), cal: i };
      if (ev.allDay) out.allDay = true;
      if (ev.loc) out.loc = ev.loc;
      if (ev.notes) out.notes = ev.notes;
      if (cal.color) out.color = cal.color;
      byKey.set(k, out);
    }
  });
  const events = Array.from(byKey.values());
  for (const e of events) e.people.sort((a, b) => memberOrder.indexOf(a) - memberOrder.indexOf(b));
  return events;
}

/**
 * Expand and merge the /api/calendar payload (used by js/calendar-worker.js, and on the main thread
 * if Web Workers aren't available).
 * @param {{calendars: Array<{name, color, people, ok, error?, text?}>, win: {from, to, tz}, order: string[]}} msg
 * @returns {{events: Array, errors: Array<string|null>}}
 */
export function expandFeeds(msg) {
  const results = msg.calendars.map((c) => {
    if (!c.ok) return { error: c.error || 'Calendar unavailable' };
    try { return { events: expandIcs(c.text, msg.win) }; } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  return { events: mergeCalendars(results, msg.calendars, msg.order), errors: results.map((r) => r.error || null) };
}
