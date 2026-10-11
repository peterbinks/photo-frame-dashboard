// Web Worker: parses and expands the calendar feeds off the UI thread (the frame's CPU is slow, and
// a big calendar can take a while). Messages: {id, calendars, win, order} → {id, events, errors}.
import { expandFeeds } from '../src/calendar.js';

self.onmessage = function (e) {
  var m = e.data, res;
  try { res = expandFeeds(m); } catch (err) { res = { events: [], errors: m.calendars.map(function () { return String(err.message || err); }) }; }
  self.postMessage({ id: m.id, events: res.events, errors: res.errors });
};
