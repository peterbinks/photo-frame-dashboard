import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandIcs, mergeCalendars, expandFeeds } from '../src/calendar.js';
import { prefilterIcs, windowFromQuery } from '../src/ics-filter.js';

const TZ = 'America/Chicago';
const VTZ = `BEGIN:VTIMEZONE
TZID:America/Chicago
X-LIC-LOCATION:America/Chicago
BEGIN:DAYLIGHT
TZOFFSETFROM:-0600
TZOFFSETTO:-0500
TZNAME:CDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0500
TZOFFSETTO:-0600
TZNAME:CST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
X-WR-CALNAME:Fixture
${VTZ}
BEGIN:VEVENT
UID:soccer@test
SUMMARY:Soccer practice
LOCATION:Lakeshore Fields
DTSTART;TZID=America/Chicago:20261006T163000
DTEND;TZID=America/Chicago:20261006T180000
RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261201T000000Z
EXDATE;TZID=America/Chicago:20261013T163000
END:VEVENT
BEGIN:VEVENT
UID:soccer@test
RECURRENCE-ID;TZID=America/Chicago:20261020T163000
SUMMARY:Soccer practice (moved)
DTSTART;TZID=America/Chicago:20261021T170000
DTEND;TZID=America/Chicago:20261021T183000
END:VEVENT
BEGIN:VEVENT
UID:soccer@test
RECURRENCE-ID;TZID=America/Chicago:20261027T163000
SUMMARY:Soccer practice
STATUS:CANCELLED
DTSTART;TZID=America/Chicago:20261027T163000
DTEND;TZID=America/Chicago:20261027T180000
END:VEVENT
BEGIN:VEVENT
UID:bday@test
SUMMARY:Birthday
DTSTART;VALUE=DATE:20261012
DTEND;VALUE=DATE:20261013
RRULE:FREQ=YEARLY
END:VEVENT
BEGIN:VEVENT
UID:trip@test
SUMMARY:Cottage weekend
DTSTART;VALUE=DATE:20261016
DTEND;VALUE=DATE:20261019
END:VEVENT
BEGIN:VEVENT
UID:old@test
SUMMARY:Ancient history
DTSTART:20150101T150000Z
DTEND:20150101T160000Z
END:VEVENT
BEGIN:VEVENT
UID:utc@test
SUMMARY:Dentist
DESCRIPTION:Bring <b>card</b><br>Floss
DTSTART:20261014T170000Z
DTEND:20261014T174500Z
END:VEVENT
BEGIN:VEVENT
UID:floating@test
SUMMARY:Floating breakfast
DTSTART:20261015T080000
DTEND:20261015T090000
END:VEVENT
END:VCALENDAR`;

const win = { from: '2026-10-01', to: '2026-12-01', tz: TZ };
const chicago = (s) => new Date(s).toLocaleString('en-US', { timeZone: TZ, hour12: false });

test('expands weekly RRULE with EXDATE, moved and cancelled overrides', () => {
  const evs = expandIcs(ICS, win).filter((e) => e.uid === 'soccer@test').sort((a, b) => a.start - b.start);
  const days = evs.map((e) => chicago(e.start));
  // Tuesdays Oct 6 … Nov 24, minus Oct 13 (EXDATE) and Oct 27 (cancelled); Oct 20 moved to Wed Oct 21 17:00
  assert.deepEqual(days, [
    '10/6/2026, 16:30:00', '10/21/2026, 17:00:00', '11/3/2026, 16:30:00', '11/10/2026, 16:30:00',
    '11/17/2026, 16:30:00', '11/24/2026, 16:30:00',
  ]);
  assert.equal(evs[1].title, 'Soccer practice (moved)');
  assert.equal(evs[0].loc, 'Lakeshore Fields');
  assert.equal(evs[0].end - evs[0].start, 90 * 60000);
  // Across the DST change (Nov 1) the wall-clock time stays 16:30 → UTC offset changes
  assert.equal(new Date(evs[0].start).toISOString(), '2026-10-06T21:30:00.000Z');
  assert.equal(new Date(evs[2].start).toISOString(), '2026-11-03T22:30:00.000Z');
});

test('all-day events are date keys with exclusive end; multi-day kept', () => {
  const evs = expandIcs(ICS, win);
  const bday = evs.filter((e) => e.uid === 'bday@test');
  assert.deepEqual(bday.map((e) => [e.allDay, e.start, e.end]), [[true, '2026-10-12', '2026-10-13']]);
  const trip = evs.find((e) => e.uid === 'trip@test');
  assert.deepEqual([trip.start, trip.end], ['2026-10-16', '2026-10-19']);
});

test('drops out-of-window events; UTC and floating times resolve correctly', () => {
  const evs = expandIcs(ICS, win);
  assert.equal(evs.find((e) => e.uid === 'old@test'), undefined);
  const dentist = evs.find((e) => e.uid === 'utc@test');
  assert.equal(chicago(dentist.start), '10/14/2026, 12:00:00');
  assert.equal(dentist.notes, 'Bring card\nFloss');
  const floating = evs.find((e) => e.uid === 'floating@test');
  assert.equal(chicago(floating.start), '10/15/2026, 08:00:00');
});

test('rejects non-ICS input', () => {
  assert.throws(() => expandIcs('<html>nope</html>', win), /Not an iCalendar/);
});

test('prefilter (Worker side) trims old one-offs and bulky properties but keeps what expansion needs', () => {
  const crlf = ICS.replace(/\n/g, '\r\n').replace('UID:utc@test\r\n',
    'UID:utc@test\r\nATTENDEE;CN=Someone Very Long Name;ROLE=REQ-PARTICIPANT:mailto:someone@exam\r\n ple.com\r\nX-GOOGLE-CONFERENCE:https://meet.google.com/abc\r\n');
  const out = prefilterIcs(crlf, win.from, win.to);
  assert.ok(out.length < crlf.length);
  assert.ok(out.indexOf('Ancient history') < 0); // 2015 one-off dropped
  assert.ok(out.indexOf('ATTENDEE') < 0 && out.indexOf('ple.com') < 0 && out.indexOf('X-GOOGLE') < 0); // incl. folded line
  assert.ok(out.indexOf('BEGIN:VTIMEZONE') > -1 && out.indexOf('RRULE:FREQ=WEEKLY') > -1 && out.indexOf('RECURRENCE-ID') > -1);
  assert.deepEqual(expandIcs(out, win).map((e) => e.uid + e.start).sort(), expandIcs(ICS, win).map((e) => e.uid + e.start).sort());
  assert.deepEqual(windowFromQuery(new URLSearchParams(''), '2026-10-10'), { from: '2026-10-03', to: '2026-12-09' });
  assert.deepEqual(windowFromQuery(new URLSearchParams('from=2026-01-01&to=2028-01-01'), '2026-10-10'), { from: '2026-01-01', to: '2027-02-05' });
});

test('an override moved into the window from a slot far outside it still shows', () => {
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\n${VTZ}\nBEGIN:VEVENT\nUID:yearly@test\nSUMMARY:Checkup\nDTSTART;TZID=America/Chicago:20260301T090000\nDTEND;TZID=America/Chicago:20260301T100000\nRRULE:FREQ=YEARLY\nEND:VEVENT\nBEGIN:VEVENT\nUID:yearly@test\nRECURRENCE-ID;TZID=America/Chicago:20270301T090000\nSUMMARY:Checkup (moved up)\nDTSTART;TZID=America/Chicago:20261020T090000\nDTEND;TZID=America/Chicago:20261020T100000\nEND:VEVENT\nEND:VCALENDAR`;
  const evs = expandIcs(ics, win);
  assert.deepEqual(evs.map((e) => [e.title, chicago(e.start)]), [['Checkup (moved up)', '10/20/2026, 09:00:00']]);
});

test('client merge: shared events show once with everyone; one bad feed does not blank the rest', () => {
  const cals = [
    { name: 'Kids', people: ['riley', 'jo'], ok: true, text: ICS },
    { name: 'Pat', people: ['pat'], color: '#123456', ok: true, text: ICS },
    { name: 'Broken', people: ['sam'], ok: false, error: 'HTTP 404' },
    { name: 'Garbage', people: ['sam'], ok: true, text: 'not ics' },
  ];
  const res = expandFeeds({ calendars: cals, win, order: ['pat', 'sam', 'riley', 'jo'] });
  assert.deepEqual(res.errors.map(Boolean), [false, false, true, true]);
  const soccer = res.events.filter((e) => e.title === 'Soccer practice');
  assert.equal(soccer.length, 5);
  assert.deepEqual(soccer[0].people, ['pat', 'riley', 'jo']);
  assert.ok(/^g[0-9a-z]+$/.test(soccer[0].id));
  assert.equal(new Set(res.events.map((e) => e.id)).size, res.events.length);
  assert.deepEqual(mergeCalendars([{ events: [] }], [cals[0]], []), []);
});
