// When a newly deployed version may reload the screen (pure; js/version.js wires it up).
export var QUIET_MS = 2 * 60 * 1000;

/**
 * @param {{current: string, latest: string|null, now: number, lastTouch: number, sheetOpen: boolean,
 *          typing: boolean, haLogin: boolean, takeover: boolean}} s
 * @returns {'none' | 'wait' | 'reload'}  none = nothing new; wait = new version, not a quiet moment
 */
export function reloadDecision(s) {
  if (!s.latest || !s.current || s.current === 'dev' || s.latest === s.current) return 'none';
  if (s.haLogin || s.sheetOpen || s.typing || s.takeover) return 'wait';
  if (s.now - s.lastTouch < QUIET_MS) return 'wait';
  return 'reload';
}
