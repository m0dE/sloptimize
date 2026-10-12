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

// ── Frame pacing: a reduced-rate loop is not a stream of hitches ───────────
// A sim stepped at a reduced rate alternates short and long frames — tier 1
// on a field build read 5 ms / 60 ms, one long frame in two. The rolling
// median lands between (15.4 ms) and every long frame clears 2× it: 205
// "hitches" for one steady pattern, and a median that describes no frame.
// So a window is checked for PACING: two clusters far apart, the long one
// tight, and the long frames recurring on a stride. Then it is said once —
// lows, highs, the stride, the mean and the p95 — and a frame inside the
// long band is a paced frame, not a hitch. A frame well past the band is
// still a hitch: a stall on top of the pacing is a stall.

/** Fewest intervals a window needs before pacing is judged. */
export const PACING_MIN_FRAMES = 60;

/**
 * @param {ArrayLike<number>} intervals  frame times, oldest first
 * @returns {{lowMs:number, highMs:number, every:number, longShare:number, meanMs:number, p95Ms:number, medianMs:number, bandMs:[number, number]} | null}
 */
export function framePacing(intervals) {
  const xs = [];
  for (let i = 0; i < (intervals?.length ?? 0); i++) { const x = +intervals[i]; if (x > 0 && x <= 1000) xs.push(x); }
  if (xs.length < PACING_MIN_FRAMES) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  // The split: the biggest ratio between neighbours, with at least 15% of
  // frames on each side of it.
  let cut = -1, best = 0;
  for (let i = Math.ceil(0.15 * n) - 1; i < Math.floor(0.85 * n); i++) {
    const r = s[i + 1] / Math.max(s[i], 0.5);
    if (r > best) { best = r; cut = i; }
  }
  if (cut < 0 || best < 1.6) return null;
  const lo = s.slice(0, cut + 1), hi = s.slice(cut + 1);
  const med = (v) => v[v.length >> 1];
  const lowMs = med(lo), highMs = med(hi);
  // Long frames must matter (over 25 ms) and stand well apart from the short ones.
  if (highMs < 25 || highMs / lowMs < 2.5) return null;
  // A TIGHT long cluster: a steady step, not a scatter of stalls.
  const p = (v, q) => v[Math.min(v.length - 1, Math.floor(q * v.length))];
  if (p(hi, 0.9) / p(hi, 0.1) > 1.5) return null;
  // On a stride: the gaps between long frames agree within one frame.
  const bar = s[cut + 1];
  const at = [];
  for (let i = 0; i < xs.length; i++) if (xs[i] >= bar) at.push(i);
  const gaps = [];
  for (let k = 1; k < at.length; k++) gaps.push(at[k] - at[k - 1]);
  if (gaps.length < 8) return null;
  const g = [...gaps].sort((a, b) => a - b), every = g[g.length >> 1];
  let near = 0;
  for (const d of gaps) if (Math.abs(d - every) <= 1) near++;
  if (near / gaps.length < 0.8) return null;
  let sum = 0;
  for (const x of xs) sum += x;
  return { lowMs: +lowMs.toFixed(1), highMs: +highMs.toFixed(1), every, longShare: +(hi.length / n).toFixed(2), meanMs: +(sum / n).toFixed(1),
    p95Ms: +p(s, 0.95).toFixed(1), medianMs: +med(s).toFixed(1), bandMs: [+(p(hi, 0.1) * 0.8).toFixed(1), +(p(hi, 0.9) * 1.25).toFixed(1)] };
}

/** "alternating ~5 / ~60 ms frames (1 long in 2)". */
export function pacingText(p) {
  return `${p.every === 2 ? 'alternating' : 'paced'} ~${p.lowMs} / ~${p.highMs} ms frames (1 long in ${p.every}) — mean ${p.meanMs} ms, p95 ${p.p95Ms} ms, median ${p.medianMs} ms`;
}

/** Has pacing changed enough to be said again? */
export function pacingMoved(a, b) {
  if (!a || !b) return a !== b;
  return a.every !== b.every || Math.abs(a.highMs - b.highMs) > 0.25 * a.highMs || Math.abs(a.lowMs - b.lowMs) > Math.max(2, 0.5 * a.lowMs);
}
