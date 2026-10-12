// ============================================================
// periodic.js — hitches that recur on a clock (SPEC-attach §2, cadence)
// ============================================================
// A field run had 70–78 ms hitches exactly 15.0 s apart, every one of them
// "unattributed (below-floor)": each is under the 80 ms attribution floor,
// so no single one is worth a profiler rotation, and seven samples a frame
// would name nothing anyway. Together they are one cause on a timer — a
// setInterval autosave, a periodic GC of a pool, a network poll — and the
// cadence alone says so. Pooled, a dozen 75 ms frames are ~90 samples: as
// attributable as one 900 ms stall.
//
// So: find the period (the spacing most hitches share with a neighbour,
// within a frame or two of jitter), say it, and pool the members' samples.
// Pure; the pipeline feeds it hitch times, the report reads its records.

/** Fewest members a cadence needs before it is called one. */
export const PERIOD_MIN_MEMBERS = 4;
/** Periods outside this are not a timer's (a frame cadence, or one per session). */
const MIN_PERIOD_MS = 500, MAX_PERIOD_MS = 10 * 60_000;

const tolOf = (p) => Math.max(50, 0.02 * p);

/**
 * The dominant period among event times (ms, any order).
 * @param {number[]} times
 * @param {{minMembers?:number}} [o]
 * @returns {{periodMs:number, members:number[], spanMs:number} | null}
 *   `members`: indexes into `times` that sit one period from another member.
 */
export function findPeriod(times, { minMembers = PERIOD_MIN_MEMBERS } = {}) {
  const ts = times.map((t, i) => [t, i]).filter(([t]) => Number.isFinite(t)).sort((a, b) => a[0] - b[0]);
  if (ts.length < minMembers) return null;
  // Candidates: the spacing to each of the next few events (an unrelated
  // hitch in between must not hide the timer's own spacing).
  const cands = [];
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < Math.min(ts.length, i + 5); j++) {
      const d = ts[j][0] - ts[i][0];
      if (d >= MIN_PERIOD_MS && d <= MAX_PERIOD_MS) cands.push(d);
    }
  }
  cands.sort((a, b) => a - b);
  // Each distinct candidate once (within tolerance of the last kept).
  const uniq = [];
  for (const d of cands) if (!uniq.length || d - uniq.at(-1) > tolOf(uniq.at(-1)) / 2) uniq.push(d);
  let best = null;
  for (const p of uniq) {
    const tol = tolOf(p);
    const member = new Set();
    // Two pointers: for each event, is there one at t + p?
    let j = 0;
    for (let i = 0; i < ts.length; i++) {
      const want = ts[i][0] + p;
      while (j < ts.length && ts[j][0] < want - tol) j++;
      if (j < ts.length && Math.abs(ts[j][0] - want) <= tol) { member.add(i); member.add(j); }
    }
    // Most members wins; a near-tie goes to the shorter period (2P fits every
    // event P does only when none was missed).
    if (member.size >= minMembers && (!best || member.size > best.member.size)) best = { p, member };
  }
  if (!best) return null;
  const idx = [...best.member].sort((a, b) => a - b);
  // Refined: the median spacing per period step between successive members.
  const steps = [];
  for (let k = 1; k < idx.length; k++) {
    const d = ts[idx[k]][0] - ts[idx[k - 1]][0];
    const n = Math.round(d / best.p);
    if (n >= 1) steps.push(d / n);
  }
  steps.sort((a, b) => a - b);
  const periodMs = steps.length ? steps[steps.length >> 1] : best.p;
  const span = ts[idx.at(-1)][0] - ts[idx[0]][0];
  if (span < (minMembers - 1) * periodMs * 0.9) return null;
  return { periodMs: +periodMs.toFixed(0), members: idx.map((k) => ts[k][1]), spanMs: +span.toFixed(0) };
}

/** "every 15.0 s", "every 750 ms". */
export function periodText(ms) {
  return ms >= 1000 ? `every ${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s` : `every ${Math.round(ms)} ms`;
}
