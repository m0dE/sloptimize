// ============================================================
// cadence.js — the display's refresh rate, read off rAF intervals
// ============================================================
// A rAF interval is not a frame's cost. The browser presents on vsync, so a
// frame lasts a WHOLE number of refresh periods: on a 60 Hz display a frame
// whose work took 26.4 ms presents at 33.3 ms, and the interval reads 33.3.
// A field comparison once put an in-app frame body (26.37 ms) beside an
// attached run's rAF interval (34.7 ms) and reported "+27% attach overhead";
// the real residual was ~1.4 ms, and the rest was the second vsync. One line
// saying "60 Hz" would have stopped it, and two runs on different displays
// are not comparable at all — the same work lands on different steps.
//
// No web API states the refresh rate. rAF timestamps are vsync-aligned in
// every engine that matters, so the intervals cluster on multiples of the
// period: the estimate is the LOWEST common rate that explains nearly every
// interval of a window. Lowest, because every multiple of 60 Hz is also a
// multiple of 120 Hz's period — a 60 Hz display always "fits" 120 too.
//
// Honest limits, carried in the output rather than papered over:
//   · a page that never presents faster than every second vsync reads as half
//     the rate (a steady 33.3 ms game on 60 Hz says 30 Hz) until one frame
//     lands on the single period — the tracker only ever rises on evidence;
//   · a variable-refresh display (G-Sync, FreeSync, ProMotion) has no fixed
//     period, and the answer is `null` with `cadence: 'variable'`, not a guess.
//
// Pure and self-contained: attach.mjs concatenates this file (exports
// stripped) into the injected page script, and a tier-1 host imports it.

/** Refresh rates displays ship with, lowest first (the lowest fit wins). */
export const REFRESH_RATES = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240, 360];
/** Fraction of a window's intervals a rate must explain to be the answer. */
export const REFRESH_FIT = 0.9;
/** Fewest usable intervals a window needs before it says anything. */
export const REFRESH_MIN_INTERVALS = 30;
/** Intervals above this are stalls or hidden-tab gaps, not cadence. */
const MAX_INTERVAL_MS = 250;

/**
 * The display rate one window of rAF intervals implies.
 * @param {ArrayLike<number>} intervals  rAF-to-rAF milliseconds
 * @returns {{hz:number, periodMs:number, fit:number, n:number} | {hz:null, n:number} | null}
 *   null: too few usable intervals to say; `hz: null`: enough, and no fixed rate explains them
 */
export function refreshFromIntervals(intervals) {
  const xs = [];
  for (let i = 0; i < (intervals?.length ?? 0); i++) {
    const x = +intervals[i];
    if (x > 2 && x <= MAX_INTERVAL_MS) xs.push(x);
  }
  if (xs.length < REFRESH_MIN_INTERVALS) return null;
  for (const hz of REFRESH_RATES) {
    const p = 1000 / hz;
    // A vsync-aligned timestamp jitters well under a millisecond; scale the
    // tolerance with the period so a 30 Hz step is not held to 120 Hz's.
    const tol = Math.max(1, 0.08 * p);
    let hit = 0;
    for (const x of xs) {
      const k = Math.round(x / p);
      if (k >= 1 && Math.abs(x - k * p) <= tol) hit++;
    }
    const fit = hit / xs.length;
    if (fit >= REFRESH_FIT) return { hz, periodMs: +p.toFixed(3), fit: +fit.toFixed(3), n: xs.length };
  }
  return { hz: null, n: xs.length };
}

/** Windows with no fixed cadence before the tracker says "variable". */
const VARIABLE_AFTER = 5;

/**
 * A run's estimate, window by window. A rate becomes the answer once two
 * windows agreed on it, and the answer is the highest such rate (a window of
 * 33.3 ms frames says 30 on a 60 Hz display; one window of 16.7 ms frames
 * and its successor say 60, and 60 stands). Until any rate is confirmed the
 * first estimate stands, provisionally.
 */
export function createRefreshTracker() {
  const seen = new Map();
  let hz, windows = 0, fitted = 0;
  return {
    /** @returns {boolean} the answer changed */
    observe(intervals) {
      const e = refreshFromIntervals(intervals);
      if (e === null) return false;
      const before = this.state();
      windows++;
      if (e.hz !== null) {
        fitted++;
        seen.set(e.hz, (seen.get(e.hz) ?? 0) + 1);
        let next;
        for (const [h, n] of seen) if (n >= 2 && (next === undefined || h > next)) next = h;
        hz = next ?? hz ?? e.hz;
      }
      const after = this.state();
      return before?.refreshHz !== after?.refreshHz || before?.cadence !== after?.cadence;
    },
    /** `{refreshHz, periodMs, from}`, `{refreshHz:null, cadence:'variable', from}`, or null (not enough frames yet). */
    state() {
      if (hz !== undefined) return { refreshHz: hz, periodMs: +(1000 / hz).toFixed(3), from: 'raf-cadence', confirmed: (seen.get(hz) ?? 0) >= 2 };
      if (windows >= VARIABLE_AFTER && fitted === 0) return { refreshHz: null, cadence: 'variable', from: 'raf-cadence' };
      return null;
    },
  };
}
