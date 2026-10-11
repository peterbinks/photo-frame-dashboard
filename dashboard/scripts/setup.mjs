#!/usr/bin/env node
// Home HQ setup: `npm run setup` — first deploy and bootstrap.
// Asks for the family, Google calendars, iCloud shared albums, Home Assistant and location, checks
// each one, deploys the Worker to your Cloudflare account (KV namespace, access key), then writes
// those answers into the dashboard's settings (PUT /api/settings) and prints the link to open on
// the photo frame. After that, day-to-day changes happen in Settings on the frame or a phone.
// Re-running it against a live dashboard starts from its current settings.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit } from 'node:process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandIcs, expandFeeds } from '../src/calendar.js';
import { findFrame, sendToFrame, manualCommand } from './frame.mjs';
import { parseAlbumLink, fetchAlbum, fetchCloudAlbum } from '../src/icloud.js';
import { dayKey, addDaysKey, isValidTz } from '../src/time.js';
import { LIMITS } from '../src/settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = join(ROOT, '.frame-config.json');
const DEV_VARS = join(ROOT, '.dev.vars');
const WRANGLER = join(ROOT, 'wrangler.jsonc');
const KV_TITLE = 'home-dashboard-state';
const DEFAULT_HA = 'http://192.168.1.200:8123';

// Prompts read from a line queue so answers can also be piped in (readline's question() drops
// lines that arrive before it is called).
const rl = createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
const queued = [];
let waiting = null, inputClosed = false;
rl.on('line', (l) => {
  if (!waiting) return queued.push(l);
  if (!stdin.isTTY) stdout.write(l + '\n');
  const w = waiting; waiting = null; w(l);
});
rl.on('close', () => { inputClosed = true; if (waiting) { console.log('\nInput ended — setup stopped.'); exit(1); } });
function line(prompt) {
  stdout.write(prompt);
  if (queued.length) { const l = queued.shift(); if (!stdin.isTTY) stdout.write(l + '\n'); return Promise.resolve(l); }
  if (inputClosed) { console.log('\nInput ended — setup stopped.'); exit(1); }
  return new Promise((resolve) => { waiting = resolve; });
}
const bold = (s) => '\x1b[1m' + s + '\x1b[0m';
const dim = (s) => '\x1b[2m' + s + '\x1b[0m';
const green = (s) => '\x1b[32m' + s + '\x1b[0m';
const red = (s) => '\x1b[31m' + s + '\x1b[0m';
const ok = (s) => console.log('  ' + green('✓') + ' ' + s);
const warn = (s) => console.log('  ' + red('!') + ' ' + s);

async function ask(q, def) {
  const a = (await line('  ' + q + (def != null && def !== '' ? dim(' [' + def + ']') : '') + ' ')).trim();
  return a === '' ? (def == null ? '' : String(def)) : a;
}
async function yes(q, def = true) {
  const a = (await line('  ' + q + dim(def ? ' [Y/n]' : ' [y/N]') + ' ')).trim().toLowerCase();
  return a === '' ? def : a[0] === 'y';
}
function section(title) { console.log('\n' + bold(title)); }
function short(url) { return url.length > 60 ? url.slice(0, 44) + '…' + url.slice(-12) : url; }
async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// Run a command. capture: collect stdout/stderr (still shown when echo); input: string piped to stdin.
function run(cmd, args, { capture = false, input = null, echo = !capture, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT, env: { ...process.env, ...env },
      stdio: [input != null ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
    });
    let out = '';
    if (capture) {
      child.stdout.on('data', (d) => { out += d; if (echo) stdout.write(d); });
      child.stderr.on('data', (d) => { out += d; if (echo) process.stderr.write(d); });
    }
    if (input != null) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
}
const wrangler = (args, opts) => run('npx', ['--yes', 'wrangler', ...args], opts);

// ------------------------------------------------------------------ load
const cfg = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
function save() { cfg.updated = new Date().toISOString(); writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); }

// The live dashboard's settings API (Bearer = the access key)
function settingsApi(base, key) {
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  return {
    get: async () => {
      const r = await fetchWithTimeout(base + '/api/settings', { headers }, 15000);
      return r.ok ? r.json() : null;
    },
    put: async (body) => {
      const r = await fetchWithTimeout(base + '/api/settings', { method: 'PUT', headers, body: JSON.stringify(body) }, 15000);
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}

console.log(bold('\nHome HQ setup') + dim('  — first deploy and bootstrap. Press Enter to keep the value in [brackets].'));

// Re-run against a live dashboard: its settings (edited in Settings on the frame/phone) are the defaults.
let live = null;
if (cfg.workerUrl && cfg.accessKey) {
  try { live = await settingsApi(cfg.workerUrl, cfg.accessKey).get(); } catch { live = null; }
  if (live && Array.isArray(live.family)) {
    ok('Read the current settings from ' + cfg.workerUrl);
    cfg.family = live.family;
    cfg.calendars = live.calendars;
    cfg.albums = live.albums;
    cfg.haUrl = live.haUrl || cfg.haUrl;
    cfg.units = live.units;
    if (live.location) { cfg.city = live.location.city; cfg.lat = live.location.lat; cfg.lon = live.location.lon; cfg.cityChecked = cfg.city; }
    else { cfg.city = ''; cfg.lat = null; cfg.lon = null; }
  } else live = null;
}
// Older answer files kept albums as plain links
cfg.albums = (cfg.albums || []).map((a) => (typeof a === 'string' ? { url: a } : a));

// ------------------------------------------------------------------ family
section('1. Family');
if (cfg.family && cfg.family.length) {
  console.log('  ' + cfg.family.map((m) => m.name + (m.kid ? ' (kid ★)' : '')).join(', '));
}
if (!(cfg.family && cfg.family.length) || !(await yes('Keep this family?'))) {
  const before = cfg.family || [];
  const list = [];
  console.log(dim('  Enter each person; leave the name blank when done. Kids earn stars for chores. Up to ' + LIMITS.members + '.'));
  while (list.length < LIMITS.members) {
    const name = await ask('Name' + (list.length ? ' (blank = done)' : '') + ':');
    if (!name) { if (list.length) break; warn('Add at least one person.'); continue; }
    if (name.length > LIMITS.memberName || /[<>"\\]/.test(name)) { warn('Names are up to ' + LIMITS.memberName + ' characters, without < > " or \\'); continue; }
    // Same name as before → same person (keeps their chores and stars)
    const prev = before.find((m) => m.name.toLowerCase() === name.toLowerCase());
    list.push({ ...(prev ? { id: prev.id, color: prev.color } : {}), name, kid: await yes('Is ' + name + ' a kid who earns stars?', prev ? !!prev.kid : false) });
  }
  cfg.family = list;
}
ok(cfg.family.length + ' people');

// Calendar "whose" lists refer to people by id; people added just now don't have one yet, so
// whose is kept as names until the settings are written.
const nameOf = (id) => (cfg.family.find((m) => m.id === id) || {}).name;
function whoFromAnswer(answer) {
  if (!answer.trim()) return [];
  const picked = [];
  for (const part of answer.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const n = +part;
    const m = n >= 1 && n <= cfg.family.length ? cfg.family[n - 1] : cfg.family.find((x) => x.name.toLowerCase() === part || x.id === part);
    if (m && picked.indexOf(m.name) < 0) picked.push(m.name);
    if (!m) warn('No family member "' + part + '" — skipped');
  }
  return picked;
}
function whoText(names) {
  const list = (names || []).filter((n) => cfg.family.some((m) => m.name === n));
  return !list.length || list.length === cfg.family.length ? 'everyone' : list.join(', ');
}

// ------------------------------------------------------------------ calendars
section('2. Google calendars');
console.log(dim('  For each calendar: Google Calendar on the web → ⚙ Settings → click the calendar on the left →\n' +
  '  "Integrate calendar" → copy "Secret address in iCal format" (ends in /basic.ics).'));
async function checkIcs(url) {
  try {
    const res = await fetchWithTimeout(url.replace(/^webcal:\/\//i, 'https://'));
    if (!res.ok) return { error: 'HTTP ' + res.status + (res.status === 404 ? ' — not found (copy the secret address again)' : '') };
    const text = await res.text();
    if (text.indexOf('BEGIN:VCALENDAR') < 0) return { error: 'not an iCal file — use the "Secret address in iCal format"' };
    const total = (text.match(/BEGIN:VEVENT/g) || []).length;
    const name = ((text.match(/\nX-WR-CALNAME:(.*)/) || [])[1] || '').trim();
    const tz = cfg.tz || 'America/Chicago';
    const today = dayKey(Date.now(), tz);
    let upcoming = null;
    try { upcoming = expandIcs(text, { from: today, to: addDaysKey(today, 30), tz }).length; } catch { /* count only */ }
    return { total, upcoming, name };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timed out' : e.message };
  }
}
cfg.calendars = (cfg.calendars || []).map((c) => ({ ...c, people: (c.people || []).map((p) => nameOf(p) || p).filter((n) => cfg.family.some((m) => m.name === n)) }));
if (cfg.calendars.length) {
  cfg.calendars.forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c.name + dim(' — ' + whoText(c.people) + ' — ' + short(c.url))));
  if (!(await yes('Keep these calendars?'))) cfg.calendars = [];
}
while (cfg.calendars.length < LIMITS.calendars && await yes(cfg.calendars.length ? 'Add another calendar?' : 'Add a calendar?', !cfg.calendars.length)) {
  const url = await ask('Secret iCal address:');
  if (!/^(https|webcal):\/\//i.test(url)) { warn('That should start with https://'); continue; }
  process.stdout.write(dim('  checking…\r'));
  const r = await checkIcs(url);
  if (r.error) { warn('Couldn’t read it: ' + r.error); if (!(await yes('Use it anyway?', false))) continue; }
  else ok(r.total + ' events in the feed' + (r.upcoming != null ? ', ' + r.upcoming + ' in the next 30 days' : ''));
  const name = (await ask('Name for this calendar:', r.name || 'Calendar ' + (cfg.calendars.length + 1))).slice(0, LIMITS.calendarName);
  console.log(dim('  Whose is it? ' + cfg.family.map((m, i) => (i + 1) + '=' + m.name).join(', ') + ' — numbers or names, comma separated; Enter = everyone'));
  const people = whoFromAnswer(await ask('Whose:', ''));
  cfg.calendars.push({ url: url.replace(/^webcal:\/\//i, 'https://'), name, people });
}
for (const c of cfg.calendars) {
  const r = await checkIcs(c.url);
  if (r.error) warn(c.name + ': ' + r.error); else ok(c.name + ': ' + r.total + ' events' + (r.upcoming != null ? ' (' + r.upcoming + ' in the next 30 days)' : '') + ' — ' + whoText(c.people));
}

// ------------------------------------------------------------------ photos
section('3. iCloud shared albums');
console.log(dim('  In Photos on iPhone/Mac: open the shared album → People (or ⋯) → turn on "Public Website" → copy the link.\n' +
  '  Either form works: https://photos.icloud.com/shared/album/… or https://www.icloud.com/sharedalbum/#…\n' +
  '  Big albums can take up to a minute to check.'));
async function checkAlbum(url) {
  const album = parseAlbumLink(url);
  if (!album) return { error: 'that isn’t an iCloud shared album link' };
  try {
    const a = album.kind === 'cloudkit'
      ? await fetchCloudAlbum(album.token, 0, { maxPages: 1000 })
      : await fetchAlbum(album.token, 0, { members: cfg.family });
    return { name: a.name, count: a.photos.length };
  } catch (e) { return { error: e.message }; }
}
if (cfg.albums.length) {
  cfg.albums.forEach((a, i) => console.log('  ' + (i + 1) + '. ' + (a.name ? a.name + dim(' — ' + a.url) : a.url)));
  if (!(await yes('Keep these albums?'))) cfg.albums = [];
}
while (cfg.albums.length < LIMITS.albums && await yes(cfg.albums.length ? 'Add another album?' : 'Add an album?', !cfg.albums.length)) {
  const url = (await ask('Shared album link:')).trim();
  if (!parseAlbumLink(url)) { warn('That isn’t an iCloud shared album link'); continue; }
  process.stdout.write(dim('  checking…\r'));
  const r = await checkAlbum(url);
  if (r.error) { warn('Couldn’t read it: ' + r.error); if (!(await yes('Use it anyway?', false))) continue; }
  else ok('"' + r.name + '" — ' + r.count + ' photos');
  cfg.albums.push({ url, ...(r.name && !/[<>]/.test(r.name) ? { name: r.name.slice(0, LIMITS.albumName) } : {}) });
}

// ------------------------------------------------------------------ Home Assistant
section('4. Home Assistant');
cfg.haUrl = (await ask('Home Assistant URL (as the frame reaches it on your Wi-Fi):', cfg.haUrl || DEFAULT_HA)).replace(/\/+$/, '');
try {
  const res = await fetchWithTimeout(cfg.haUrl + '/api/', {}, 4000);
  ok('Reachable from this computer (HTTP ' + res.status + ')');
} catch {
  warn('Not reachable from this computer — fine if you are not on the home network right now.');
}
console.log(dim('  The frame signs in to Home Assistant itself (Settings → Home Assistant → Connect).\n' +
  '  Optional instead: paste a long-lived access token (HA → your profile → Security). "-" clears it.'));
const tok = await ask('Long-lived token (optional):', cfg.haToken ? '•••• keep' : '');
if (tok === '-') cfg.haToken = '';
else if (tok && tok !== '•••• keep') cfg.haToken = tok;

// ------------------------------------------------------------------ location + units + time zone
section('5. Weather location');
console.log(dim('  Leave the city blank to use the frame’s internet location (from Cloudflare).'));
const city = await ask('City:', cfg.city || '');
cfg.city = city === '-' ? '' : city;
if (cfg.city && (cfg.lat == null || city !== (cfg.cityChecked || ''))) {
  try {
    const g = await (await fetchWithTimeout('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(cfg.city))).json();
    const hit = g.results && g.results[0];
    if (hit && (await yes('Found ' + [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(', ') + ' (' + hit.latitude.toFixed(2) + ', ' + hit.longitude.toFixed(2) + '). Use it?'))) {
      cfg.lat = +hit.latitude.toFixed(4); cfg.lon = +hit.longitude.toFixed(4); cfg.cityChecked = cfg.city;
      if (hit.timezone && !cfg.tz) cfg.tz = hit.timezone;
    }
  } catch { warn('Couldn’t look the city up — enter coordinates below.'); }
}
const lat = await ask('Latitude (blank = automatic):', cfg.lat ?? '');
const lon = lat ? await ask('Longitude:', cfg.lon ?? '') : '';
cfg.lat = lat && isFinite(+lat) ? +lat : null;
cfg.lon = lon && isFinite(+lon) ? +lon : null;
if (cfg.lat == null || cfg.lon == null) { cfg.lat = null; cfg.lon = null; }
for (;;) {
  const u = (await ask('Temperature units — auto, fahrenheit or celsius:', cfg.units || 'auto')).toLowerCase();
  const m = { auto: 'auto', a: 'auto', f: 'fahrenheit', fahrenheit: 'fahrenheit', c: 'celsius', celsius: 'celsius' }[u];
  if (m) { cfg.units = m; break; }
  warn('Type auto, fahrenheit or celsius');
}
for (;;) {
  const tz = await ask('Time zone of the frame:', cfg.tz || 'America/Chicago');
  if (isValidTz(tz)) { cfg.tz = tz; break; }
  warn('Not a time zone name (e.g. America/Chicago)');
}

// ------------------------------------------------------------------ access key + local files
if (!cfg.accessKey) cfg.accessKey = randomBytes(32).toString('base64url');
save();
// Only the time zone is a Worker var; everything else lives in the settings document.
const vars = { TZ: cfg.tz };
const secrets = { ACCESS_KEY: cfg.accessKey };
if (cfg.haToken) secrets.HA_TOKEN = cfg.haToken;
// dotenv quoting: single quotes unless the value has one, then backticks
const q = (v) => (String(v).indexOf("'") < 0 ? "'" + v + "'" : '`' + v + '`');
writeFileSync(DEV_VARS, '# Written by npm run setup — local secrets for `wrangler dev`. Never commit.\n' +
  '# Local dev keeps its own settings (in .wrangler/): change them in Settings at http://localhost:8787\n' +
  Object.entries({ ...vars, ...secrets }).map(([k, v]) => k + '=' + q(v)).join('\n') + '\n', { mode: 0o600 });
chmodSync(DEV_VARS, 0o600);
chmodSync(CONFIG, 0o600);
ok('Saved .frame-config.json and .dev.vars');

// ------------------------------------------------------------------ Cloudflare
section('6. Cloudflare');
if (!(await yes('Deploy to your Cloudflare account now?'))) {
  console.log(dim('\n  Skipped. Run npm run setup again to deploy.'));
  rl.close();
  exit(0);
}
rl.close(); // no more questions: wrangler gets the terminal (login, workers.dev subdomain prompts)

let who = await wrangler(['whoami'], { capture: true, echo: false });
if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
  console.log('  Opening the Cloudflare login in your browser…');
  if ((await wrangler(['login'])).code !== 0) { warn('Cloudflare login failed.'); exit(1); }
  who = await wrangler(['whoami'], { capture: true, echo: false });
}
ok('Logged in to Cloudflare');

// KV namespace for the shared state and settings
const wranglerText = readFileSync(WRANGLER, 'utf8');
const currentId = (wranglerText.match(/"binding":\s*"STATE",\s*"id":\s*"([0-9a-f]{32})"/) || [])[1];
const listNamespaces = async () => {
  const r = await wrangler(['kv', 'namespace', 'list'], { capture: true, echo: false });
  const m = r.out.match(/\[[\s\S]*\]/);
  try { return m ? JSON.parse(m[0]) : []; } catch { return []; }
};
let spaces = await listNamespaces();
let kv = spaces.find((n) => n.id === currentId) || spaces.find((n) => n.title === KV_TITLE);
if (!kv) {
  const r = await wrangler(['kv', 'namespace', 'create', KV_TITLE], { capture: true, echo: false });
  spaces = await listNamespaces();
  kv = spaces.find((n) => n.title === KV_TITLE);
  if (!kv) { console.log(r.out); warn('Could not create the KV namespace.'); exit(1); }
  ok('Created KV namespace ' + KV_TITLE);
} else ok('KV namespace ' + kv.title);
if (kv.id !== currentId) {
  const patched = wranglerText.replace(/\{\s*"binding":\s*"STATE"(,\s*"id":\s*"[^"]*")?\s*\}/, '{ "binding": "STATE", "id": "' + kv.id + '" }');
  writeFileSync(WRANGLER, patched);
  ok('Saved the namespace id in wrangler.jsonc');
}
cfg.kvId = kv.id;
save();

// Build + deploy (TZ goes in as a var; wrangler.jsonc has keep_vars so plain `npm run deploy`s keep it)
console.log('  Building…');
if ((await run('npx', ['vite', 'build'], { capture: true, echo: false })).code !== 0) { warn('Build failed — run npm run build to see why.'); exit(1); }
const outDir = mkdtempSync(join(tmpdir(), 'hq-deploy-'));
const outFile = join(outDir, 'out.ndjson');
const varArgs = Object.entries(vars).flatMap(([k, v]) => ['--var', k + ':' + v]);
console.log('  Deploying…');
const dep = await wrangler(['deploy', ...varArgs], { env: { WRANGLER_OUTPUT_FILE_PATH: outFile } });
let targets = [];
try {
  for (const l of readFileSync(outFile, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const e = JSON.parse(l);
    if (e.type === 'deploy' && e.targets) targets = e.targets;
  }
} catch { /* no output file */ }
rmSync(outDir, { recursive: true, force: true });
if (dep.code !== 0) { warn('Deploy failed (see above).'); exit(1); }
const workerUrl = (targets.find((t) => /workers\.dev/.test(t)) || targets[0] || cfg.workerUrl || '').replace(/\/+$/, '');

// Secrets via stdin (never on the command line)
for (const [k, v] of Object.entries(secrets)) {
  const r = await wrangler(['secret', 'put', k], { input: v, capture: true, echo: false });
  if (r.code !== 0) { console.log(r.out); warn('Could not upload secret ' + k); exit(1); }
  ok('Secret ' + k + ' uploaded');
}
if (!cfg.haToken && cfg.haTokenUploaded) {
  await wrangler(['secret', 'delete', 'HA_TOKEN'], { input: 'y\n', capture: true, echo: false });
  ok('Removed the old HA_TOKEN secret');
}
cfg.haTokenUploaded = !!cfg.haToken;

if (!workerUrl) {
  warn('Deployed, but couldn’t read the workers.dev address from wrangler. Find it in the Cloudflare dashboard (Workers → home-dashboard).');
  save();
  exit(1);
}
cfg.workerUrl = workerUrl;
cfg.frameUrl = workerUrl + '/?k=' + cfg.accessKey;
save();

// ------------------------------------------------------------------ bootstrap the settings
// The Worker answers once the new version and the ACCESS_KEY secret are live.
const api = settingsApi(workerUrl, cfg.accessKey);
let current = null;
for (let i = 0; i < 10 && !current; i++) {
  try { current = await api.get(); } catch { /* propagating */ }
  if (!current) await new Promise((res) => setTimeout(res, 3000));
}
function settingsFrom(doc) {
  // People: same id as the live member of the same name (keeps their chores/stars), else new
  const family = cfg.family.map((m) => {
    const live = doc.family.find((x) => x.id === m.id) || doc.family.find((x) => x.name.toLowerCase() === m.name.toLowerCase());
    return live ? { id: live.id, name: m.name, color: m.color || live.color, kid: !!m.kid } : { name: m.name, ...(m.color ? { color: m.color } : {}), kid: !!m.kid };
  });
  return {
    family,
    // whose = names here; ids for people added just now are assigned by the Worker, so those
    // calendars are written in a second pass below
    calendars: cfg.calendars.map((c) => {
      const keep = doc.calendars.find((x) => x.url === c.url);
      return { ...(keep ? { id: keep.id } : {}), url: c.url, name: c.name, color: c.color || null, people: [] };
    }),
    albums: cfg.albums.map((a) => {
      const keep = doc.albums.find((x) => x.url === a.url);
      return { ...(keep ? { id: keep.id } : {}), url: a.url, ...(a.name ? { name: a.name } : {}) };
    }),
    location: cfg.lat != null && cfg.lon != null ? { city: (cfg.city || '').slice(0, LIMITS.city), lat: cfg.lat, lon: cfg.lon } : null,
    ...(cfg.units === 'fahrenheit' || cfg.units === 'celsius' ? { units: cfg.units } : {}),
    haUrl: cfg.haUrl || '',
  };
}
async function putSettings(build) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await api.get();
    const r = await api.put({ rev: doc.rev, ...build(doc) });
    if (r.status === 200) return r.body;
    if (r.status !== 409) throw new Error(r.body.error || 'HTTP ' + r.status);
  }
  throw new Error('the settings kept changing while saving — run setup again');
}
let written = null;
if (!current) warn('The Worker didn’t answer yet — give it a minute and run npm run setup again to write your answers.');
else {
  try {
    await putSettings(settingsFrom);
    // Second pass: whose (names → the ids the Worker now has)
    written = await putSettings((doc) => ({
      calendars: doc.calendars.map((c) => {
        const mine = cfg.calendars.find((x) => x.url === c.url) || { people: [] };
        return { ...c, people: mine.people.map((n) => (doc.family.find((m) => m.name === n) || {}).id).filter(Boolean) };
      }),
    }));
    ok('Settings saved: ' + written.family.length + ' people, ' + written.calendars.length + ' calendars, ' + written.albums.length + ' albums');
    cfg.family = written.family;
    cfg.calendars = written.calendars;
    cfg.albums = written.albums;
    save();
  } catch (e) { warn('Couldn’t save the settings: ' + e.message); }
}
// Calendar/album links used to be Worker secrets; they live in the settings now.
if (written) {
  for (const k of ['GCAL_ICS', 'ICLOUD_ALBUMS']) {
    const r = await wrangler(['secret', 'delete', k], { input: 'y\n', capture: true, echo: false });
    if (r.code === 0) ok('Removed the old ' + k + ' secret (now in Settings)');
  }
}

// Smoke test the live Worker
const auth = { headers: { Authorization: 'Bearer ' + cfg.accessKey } };
let liveCfg = null;
try {
  const r = await fetchWithTimeout(workerUrl + '/api/config', auth, 10000);
  if (r.ok) liveCfg = await r.json();
} catch { /* reported below */ }
if (liveCfg) {
  try {
    const c = await (await fetchWithTimeout(workerUrl + '/api/calendar', auth, 30000)).json();
    const res = expandFeeds({ calendars: c.calendars || [], win: { from: c.from, to: c.to, tz: c.tz }, order: liveCfg.family.map((m) => m.id) });
    const bad = (c.calendars || []).map((x, i) => ({ name: x.name, error: res.errors[i] })).filter((x) => x.error);
    ok(res.events.length + ' calendar events in the dashboard window' + (bad.length ? red(' — failing: ' + bad.map((x) => x.name + ' (' + x.error + ')').join(', ')) : ''));
  } catch { warn('Calendar check timed out (it will retry on the frame)'); }
} else warn('The Worker didn’t answer yet — give it a minute, then open the link below.');

console.log('\n' + bold('Open this on the photo frame (it remembers the key):'));
console.log('  ' + green(cfg.frameUrl));
console.log(dim('  Saved in dashboard/.frame-config.json. The same link works on family phones.'));

// Photo frame on USB? Hand it the link directly.
const found = await findFrame();
if (found.frame) {
  const sent = await sendToFrame(found.frame.serial, cfg.frameUrl);
  if (sent.ok) ok('Sent the link to the photo frame over USB (' + found.frame.serial + ') — it will keep it across reboots');
  else { warn('Couldn’t send it to the frame: ' + (sent.out || 'adb failed')); console.log('  Try: ' + manualCommand(cfg.frameUrl)); }
} else {
  console.log('\n  ' + (found.count > 1 ? 'More than one photo frame is attached.' : 'No photo frame attached over USB' + (found.error ? ' (' + found.error + ')' : '') + '.') +
    ' To send it the link later, plug it in and run:');
  console.log('  ' + manualCommand(cfg.frameUrl));
}
console.log('\n' + bold('From now on, make changes in Settings') + ' (⚙ at the bottom of the left rail, on the frame or any phone\n' +
  '  with the link): family, calendars, photo albums, display, weather location and Home Assistant.\n' +
  '  Run npm run setup again only to redeploy or to change the time zone or access key.');
console.log(dim('  On the frame: Settings → Home Assistant → Connect, once.'));
