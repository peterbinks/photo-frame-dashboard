// Hand the dashboard link to the photo frame over USB (adb). The kiosk app remembers the last
// VIEW URL across reboots. Used by setup.mjs.
import { spawn } from 'node:child_process';

const MODEL = 'AEEZO'; // the BIUFRAME as adb reports it
// Homebrew's current adb crashes in its mDNS thread on this macOS; mDNS isn't needed for USB.
const ENV = { ...process.env, ADB_MDNS: '0' };

function adb(args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawn('adb', args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { return resolve({ code: -1, out: '' }); }
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** → { frame: {serial, model} | null, count, error? } — frame is set only if exactly one is attached. */
export async function findFrame() {
  const r = await adb(['devices', '-l']);
  if (r.code !== 0) return { frame: null, count: 0, error: r.code === -1 ? 'adb not installed' : r.out.trim() };
  const devices = r.out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state] = l.split(/\s+/);
    return { serial, state, model: (l.match(/\bmodel:(\S+)/) || [])[1] || '' };
  });
  const frames = devices.filter((d) => d.model === MODEL && d.state === 'device');
  return { frame: frames.length === 1 ? frames[0] : null, count: frames.length };
}

/** The shell command run on the frame. */
export function remoteCommand(url) {
  if (/["'\\\s`$]/.test(url)) throw new Error('Unexpected characters in the frame URL');
  return 'am start -a android.intent.action.VIEW -d "' + url + '" -n com.wesbos.homehq/.MainActivity';
}

/** What to run by hand when no frame is attached. */
export function manualCommand(url) {
  return "ADB_MDNS=0 adb -d shell '" + remoteCommand(url) + "'";
}

export async function sendToFrame(serial, url) {
  const r = await adb(['-s', serial, 'shell', remoteCommand(url)]);
  return { ok: r.code === 0 && !/\bError\b/.test(r.out), out: r.out.trim() };
}
