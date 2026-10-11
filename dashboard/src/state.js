// Shared household state (chores + shopping + dashboard-added events + photo favourites), stored as
// one KV JSON document with a monotonically increasing `rev`.
import { dayKey, addDaysKey, weekdayMon } from './time.js';

export const STATE_KEY = 'state:v1';
export const STATE_FIELDS = ['routines', 'chores', 'stars', 'week', 'stores', 'catOrder', 'groceries', 'catalog', 'usuals', 'events', 'favs'];

const CATS = ['Produce', 'Bakery', 'Meat & Fish', 'Dairy & Eggs', 'Pantry', 'Frozen', 'Snacks', 'Household'];

const CATALOG = [
  ['Apples', 'Produce'], ['Avocados', 'Produce'], ['Bananas', 'Produce'], ['Baby spinach', 'Produce'], ['Blueberries', 'Produce'],
  ['Broccoli', 'Produce'], ['Carrots', 'Produce'], ['Cucumber', 'Produce'], ['Garlic', 'Produce'], ['Grapes', 'Produce'],
  ['Lemons', 'Produce'], ['Limes', 'Produce'], ['Onions', 'Produce'], ['Potatoes', 'Produce'], ['Strawberries', 'Produce'],
  ['Tomatoes', 'Produce'], ['Bread', 'Bakery'], ['Bagels', 'Bakery'], ['Croissants', 'Bakery'], ['Sourdough loaf', 'Bakery'],
  ['Tortillas', 'Bakery'], ['Hamburger buns', 'Bakery'], ['Bacon', 'Meat & Fish'], ['Chicken breasts', 'Meat & Fish'],
  ['Chicken thighs', 'Meat & Fish'], ['Ground beef', 'Meat & Fish'], ['Salmon fillets', 'Meat & Fish'], ['Shrimp', 'Meat & Fish'],
  ['Butter', 'Dairy & Eggs'], ['Cheddar', 'Dairy & Eggs'], ['Cream cheese', 'Dairy & Eggs'], ['Eggs', 'Dairy & Eggs'],
  ['Greek yogurt', 'Dairy & Eggs'], ['Milk', 'Dairy & Eggs'], ['Oat milk', 'Dairy & Eggs'], ['Parmesan', 'Dairy & Eggs'],
  ['Black beans', 'Pantry'], ['Cereal', 'Pantry'], ['Coffee', 'Pantry'], ['Flour', 'Pantry'], ['Honey', 'Pantry'],
  ['Maple syrup', 'Pantry'], ['Olive oil', 'Pantry'], ['Pasta sauce', 'Pantry'], ['Peanut butter', 'Pantry'], ['Rice', 'Pantry'],
  ['Pasta', 'Pantry'], ['Spaghetti', 'Pantry'], ['Sugar', 'Pantry'], ['Tea', 'Pantry'], ['Frozen peas', 'Frozen'],
  ['Frozen berries', 'Frozen'], ['Ice cream', 'Frozen'], ['Pizza', 'Frozen'], ['Waffles', 'Frozen'], ['Chips', 'Snacks'],
  ['Crackers', 'Snacks'], ['Dark chocolate', 'Snacks'], ['Granola bars', 'Snacks'], ['Popcorn', 'Snacks'],
  ['Dish soap', 'Household'], ['Dishwasher pods', 'Household'], ['Garbage bags', 'Household'],
  ['Laundry detergent', 'Household'], ['Paper towels', 'Household'], ['Toilet paper', 'Household'], ['Toothpaste', 'Household'],
];
const USUALS = ['Milk', 'Eggs', 'Bananas', 'Bread', 'Apples', 'Coffee', 'Greek yogurt', 'Cheddar', 'Butter', 'Baby spinach', 'Chicken thighs', 'Paper towels'];

const ROUTINES = [
  { id: 'morning', name: 'Morning', range: '6 – 11 AM', from: 0, to: 11 },
  { id: 'after', name: 'After school', range: '11 AM – 5 PM', from: 11, to: 17 },
  { id: 'evening', name: 'Evening', range: '5 – 10 PM', from: 17, to: 24 },
];

// Emoji must exist in Android 6's font (Unicode 8): 🪥 🧸 🧽 🧺 🪴 render as empty boxes on the frame.
const KID_CHORES = [
  ['morning', 'Make bed', '🛏️', 1], ['morning', 'Brush teeth', '😁', 1],
  ['after', 'Homework', '📚', 2], ['after', 'Tidy room', '🏠', 1],
  ['evening', 'Set the table', '🍴', 1], ['evening', 'Brush teeth', '😁', 1],
];
const ANY_CHORES = [['after', 'Empty dishwasher', '🍽️', 2], ['evening', 'Wipe counters', '✨', 1]];

function rid(prefix) { return prefix + Math.random().toString(36).slice(2, 10); }
function emptyWeek() { return [null, null, null, null, null, null, null]; }
function mondayOf(key) { return addDaysKey(key, -weekdayMon(key)); }

/** Starter document for the configured family (no mock people or items). */
export function seedState(members, tz, now = Date.now()) {
  const kids = members.filter((m) => m.kid);
  const chores = [];
  for (const k of kids) for (const c of KID_CHORES) chores.push({ id: rid('c'), r: c[0], who: k.id, title: c[1], emoji: c[2], stars: c[3], done: false });
  for (const c of ANY_CHORES) chores.push({ id: rid('c'), r: c[0], who: 'any', title: c[1], emoji: c[2], stars: c[3], done: false });
  const today = dayKey(now, tz);
  const doc = {
    rev: 1, day: today, weekStart: mondayOf(today),
    routines: ROUTINES, chores, stars: {}, week: {},
    stores: [{ id: 'grocer', name: 'Grocery' }],
    catOrder: { all: CATS, grocer: CATS },
    groceries: [], catalog: CATALOG, usuals: USUALS, events: [], favs: [],
    updated: now,
  };
  normalize(doc, members);
  return doc;
}

/** Make sure every configured kid has a star count and a week row. */
export function normalize(doc, members) {
  doc.stars = doc.stars || {};
  doc.week = doc.week || {};
  for (const m of members) {
    if (!m.kid) continue;
    if (typeof doc.stars[m.id] !== 'number') doc.stars[m.id] = 0;
    if (!Array.isArray(doc.week[m.id]) || doc.week[m.id].length !== 7) doc.week[m.id] = emptyWeek();
  }
  for (const f of STATE_FIELDS) if (doc[f] == null) doc[f] = f === 'stars' || f === 'week' || f === 'catOrder' ? {} : [];
  return doc;
}

/**
 * People removed in Settings: their chores go to "Anyone", their stars and week strip are dropped,
 * and dashboard-added events lose them. Runs on every load and save, so a device that saves an old
 * copy of the state after the removal can't bring them back. Returns true if the doc changed.
 */
export function purgeMembers(doc, removed, ids) {
  if (!removed || !removed.length) return false;
  const gone = new Set(removed);
  let changed = false;
  for (const c of doc.chores || []) {
    if (gone.has(c.who)) { c.who = 'any'; changed = true; }
    if (gone.has(c.doneBy)) { delete c.doneBy; changed = true; }
  }
  for (const k of ['stars', 'week']) {
    for (const id of Object.keys(doc[k] || {})) if (gone.has(id)) { delete doc[k][id]; changed = true; }
  }
  for (const e of doc.events || []) {
    if (!Array.isArray(e.people) || !e.people.some((p) => gone.has(p))) continue;
    e.people = e.people.filter((p) => !gone.has(p));
    if (!e.people.length) e.people = ids.slice();
    changed = true;
  }
  return changed;
}

/**
 * New day in tz: record yesterday's result per kid in the week strip (1 = all their chores done),
 * start a fresh week on Monday, and un-tick every chore. Returns true if the doc changed.
 */
export function rollover(doc, members, tz, now = Date.now()) {
  const today = dayKey(now, tz);
  if (doc.day === today) return false;
  if (doc.day && doc.day < today && mondayOf(doc.day) === doc.weekStart) {
    const idx = weekdayMon(doc.day);
    for (const m of members) {
      if (!m.kid || !doc.week[m.id]) continue;
      const mine = doc.chores.filter((c) => c.who === m.id);
      doc.week[m.id][idx] = mine.length ? (mine.every((c) => c.done) ? 1 : 0) : null;
    }
  }
  const monday = mondayOf(today);
  if (doc.weekStart !== monday) {
    for (const k of Object.keys(doc.week)) doc.week[k] = emptyWeek();
    doc.weekStart = monday;
  }
  for (const c of doc.chores) { c.done = false; delete c.doneBy; }
  // Dashboard-added events: forget ones that ended more than 60 days ago
  doc.events = (doc.events || []).filter((e) => +e.end > now - 60 * 864e5);
  doc.day = today;
  return true;
}

/** Validate a PUT body → sanitized fields or an error string. */
export function sanitize(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Body must be a JSON object';
  if (typeof body.rev !== 'number') return 'Missing numeric rev';
  const out = {};
  for (const f of STATE_FIELDS) {
    if (body[f] === undefined) continue;
    const isObj = f === 'stars' || f === 'week' || f === 'catOrder';
    if (isObj ? typeof body[f] !== 'object' || Array.isArray(body[f]) : !Array.isArray(body[f])) return 'Bad field: ' + f;
    out[f] = body[f];
  }
  return out;
}
