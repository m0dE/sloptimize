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
// A cadence must be EARNED, though. The first version asked only "do enough
// hitches have another one P later?" — and among a few hundred hitches some
// always do: purely random times came back "timer-driven" 20 times out of
// 20, and a load's reduced-rate frames read as "every 543 ms", "every
// 1.07 s", "every 321 ms" on three runs of the same pattern. So:
//   · only hitches of one KIND share a cadence: one phase, and frame times
//     within a band (a 2.6 s load stall is not an occurrence of a 75 ms
//     autosave);
//   · the matches must beat CHANCE: with n hitches over a span T, a hitch
//     has a neighbour within ±tol of t + P by luck with probability
//     ≈ n·2·tol/T — a period is kept only when its pairs clear that
//     expectation by four standard deviations and a pair and a half more
//     (every candidate period is a try, and the margin pays for them all);
//   · and the members must keep the period with each other — successive
//     members one to three periods apart — not be a scatter of pairs.
// Pure; the pipeline feeds it hitches, the report reads its records.

/** Fewest members a cadence needs before it is called one. */
export const PERIOD_MIN_MEMBERS = 4;
/** Periods outside this are not a timer's (a frame cadence, or one per session). */
const MIN_PERIOD_MS = 500, MAX_PERIOD_MS = 10 * 60_000;
/** A gap this wide (as a ratio) between sorted frame times separates two kinds of hitch. */
const BAND_GAP = 1.3;

// A hitch's time is its frame's end, so it jitters by about a frame; a
// timer drifts little more over a long period.
const tolOf = (p) => Math.max(35, 0.003 * p);

/**
 * The dominant period among event times (ms, any order) — or null when no
 * period beats chance.
 * @param {number[]} times
 * @param {{minMembers?:number}} [o]
 * @returns {{periodMs:number, members:number[], spanMs:number} | null}
 *   `members`: indexes into `times` that sit one period from another member.
 */
export function findPeriod(times, { minMembers = PERIOD_MIN_MEMBERS } = {}) {
  const ts = times.map((t, i) => [t, i]).filter(([t]) => Number.isFinite(t)).sort((a, b) => a[0] - b[0]);
  const n = ts.length;
  if (n < minMembers) return null;
  const T = ts[n - 1][0] - ts[0][0];
  if (!(T > 0)) return null;
  // Candidates: the spacing to each of the next few events (an unrelated
  // hitch in between must not hide the timer's own spacing).
  const cands = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < Math.min(n, i + 5); j++) {
      const d = ts[j][0] - ts[i][0];
      if (d >= MIN_PERIOD_MS && d <= MAX_PERIOD_MS) cands.push(d);
    }
  }
  cands.sort((a, b) => a - b);
  const uniq = [];
  for (const d of cands) if (!uniq.length || d - uniq.at(-1) > tolOf(uniq.at(-1)) / 2) uniq.push(d);
  let best = null;
  for (const p of uniq) {
    const tol = tolOf(p);
    // By chance, a hitch finds a partner at t + p with this probability.
    const chance = Math.min(1, ((n - 1) * 2 * tol) / T);
    const member = new Set();
    let pairs = 0;
    let j = 0;
    for (let i = 0; i < n; i++) {
      const want = ts[i][0] + p;
      while (j < n && ts[j][0] < want - tol) j++;
      if (j < n && Math.abs(ts[j][0] - want) <= tol) { member.add(i); member.add(j); pairs++; }
    }
    // Forward pairs possible: those whose t + p still falls inside the span.
    let room = 0;
    for (let i = 0; i < n; i++) if (ts[i][0] + p <= ts[n - 1][0] + tol) room++;
    const expected = room * chance;
    const beats = pairs >= expected + 4 * Math.sqrt(expected) + 1.5;
    // Successive members one to three periods apart: a chain, not a scatter.
    const m = [...member].sort((a, b) => a - b);
    let kept = 0;
    for (let k = 1; k < m.length; k++) {
      const d = (ts[m[k]][0] - ts[m[k - 1]][0]) / p, r = Math.round(d);
      if (r >= 1 && r <= 3 && Math.abs(d - r) * p <= tol * r) kept++;
    }
    const chained = m.length >= minMembers && kept >= 0.75 * (m.length - 1);
    // Most members wins; a tie goes to the shorter period (2P fits every
    // event P does only when none was missed).
    if (beats && chained && (!best || member.size > best.member.size)) best = { p, member };
  }
  if (!best) return null;
  const idx = [...best.member].sort((a, b) => a - b);
  // Refined: the median spacing per period step between successive members.
  const steps = [];
  for (let k = 1; k < idx.length; k++) {
    const d = ts[idx[k]][0] - ts[idx[k - 1]][0];
    const m = Math.round(d / best.p);
    if (m >= 1) steps.push(d / m);
  }
  steps.sort((a, b) => a - b);
  const periodMs = steps.length ? steps[steps.length >> 1] : best.p;
  const span = ts[idx.at(-1)][0] - ts[idx[0]][0];
  if (span < (minMembers - 1) * periodMs * 0.9) return null;
  return { periodMs: +periodMs.toFixed(0), members: idx.map((k) => ts[k][1]), spanMs: +span.toFixed(0) };
}

/**
 * Cadences among hitches, each from ONE kind of hitch: one phase, one band
 * of frame times. `events`: `{t, ms, phase?}`.
 * @returns {{periodMs:number, members:number[], spanMs:number, phase?:string, msMin:number, msMax:number}[]}
 *   biggest first; `members` index `events`.
 */
export function findCadences(events, o = {}) {
  const byPhase = new Map();
  events.forEach((e, i) => {
    if (!Number.isFinite(e?.t) || !(e.ms > 0)) return;
    const k = e.phase ?? '';
    (byPhase.get(k) ?? byPhase.set(k, []).get(k)).push(i);
  });
  const out = [];
  for (const [phase, idx] of byPhase) {
    // Bands of frame time: sorted, split at every gap of BAND_GAP× — a 2.6 s
    // stall is its own band, a 75 ms autosave and its neighbours one.
    const sorted = [...idx].sort((a, b) => events[a].ms - events[b].ms);
    let band = [];
    const flush = () => {
      if (band.length >= (o.minMembers ?? PERIOD_MIN_MEMBERS)) {
        const r = findPeriod(band.map((i) => events[i].t), o);
        if (r) {
          const members = r.members.map((k) => band[k]);
          const ms = members.map((i) => events[i].ms);
          out.push({ ...r, members, ...(phase ? { phase } : {}), msMin: Math.min(...ms), msMax: Math.max(...ms) });
        }
      }
      band = [];
    };
    for (const i of sorted) {
      // …and wider than two frames: a rAF interval snaps to whole vsyncs, so
      // one timer's frames read 50 and 66.7 ms by turns.
      const prev = band.length ? events[band.at(-1)].ms : 0;
      if (band.length && events[i].ms > BAND_GAP * prev && events[i].ms - prev > 40) flush();
      band.push(i);
    }
    flush();
  }
  return out.sort((a, b) => b.members.length - a.members.length);
}

/** "every 15.0 s", "every 750 ms". */
export function periodText(ms) {
  return ms >= 1000 ? `every ${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s` : `every ${Math.round(ms)} ms`;
}
