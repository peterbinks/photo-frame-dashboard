// `?fresh=1` (the Refresh buttons in Settings) bypasses the Worker caches. Throttled per source so a
// stuck finger or several screens refreshing at once can't hammer Google or Apple.
export const FRESH_WINDOW_MS = 20000;

/** → allow(key, now?) that returns true at most once per `windowMs` per key. */
export function createThrottle(windowMs = FRESH_WINDOW_MS) {
  const last = new Map();
  return function allow(key, now = Date.now()) {
    const t = last.get(key);
    if (t !== undefined && now - t < windowMs) return false;
    last.set(key, now);
    return true;
  };
}
