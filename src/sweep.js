// ============================================================
// sweep.js — cost against N, per phase, with a fitted exponent (SPEC §3.17)
// ============================================================
// A profile at one agent count says which phase is BIGGEST; it cannot say
// which is WORST BEHAVED, and those are different questions: a phase that
// is 2 ms and quadratic beats one that is 20 ms and linear as soon as the
// player builds a bigger city. So the game exposes a knob —
// `__sloptimizeKnob('cars', (n) => sim.setCarCount(n))` — and `sloptimize
// sweep --knob cars --values 1000,3000,5000,9000` measures each level in its
// own attached session (the page reloads per level: no pool or cache grown
// at 9k leaks into the 1k reading), settles, measures, and reports each
// metric against N.
//
// The fit is honest about what four points can say:
//   · the exponent is a log-log least-squares slope WITH its 95% interval
//     (every run is a point; ≥2 runs a level give it a spread) — and a label
//     only when the interval is narrow enough to deserve one;
//   · the slope between each pair of adjacent levels is printed too: a
//     fixed per-phase overhead flattens the low end, so one global exponent
//     understates a curve that bends upward, and the last step is the one
//     that predicts the next size;
//   · n·log n over one decade looks like n^1.15 — "QUADRATIC" is said only
//     from 1.8.
// The frame's curve, inverted, answers "how many agents can I have" — at a
// frame budget, interpolated between levels or, past the last one,
// extrapolated from the last step and labelled so.
//
// Metrics per level, all from the `sweep` phase of each run:
//   frame ms               the measured span's mean frame (ms / frames)
//   section <n> ms/call    the host's __sloptimizeSection (called once a
//                          tick: ms per tick)
//   fn <n> ms/frame        a function's sampled self time per frame of the span
//   thread <n> ms/frame    a worker's busy share of the frame (SPEC §3.18)

import { runBucket } from './runs.js';
import { phaseSpans, spanTable } from './spans.js';
import { threadRows } from './threads.js';
import { stableFile } from './footprint.js';

export const SWEEP_PHASE = 'sweep';
/** Top functions tracked across levels, chosen at the largest level. */
const FN_ROWS = 8;
/** Two-sided 95% t quantiles by degrees of freedom. */
const T95 = { 1: 12.71, 2: 4.3, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23 };

/**
 * The drive a sweep level runs (attach's drive api, SPEC §3.13): wait for the
 * game to register the knob, set it, settle, then measure in the `sweep`
 * phase with the knob as the phase's scale (SPEC §3.15).
 */
export function levelDrive(knob, value, { settleS = 5, measureS = 20 } = {}) {
  const k = JSON.stringify(String(knob));
  async function sweepLevel(api) {
    try {
      await api.until(`typeof globalThis.__sloptimizeKnobs === 'object' && typeof globalThis.__sloptimizeKnobs[${k}] === 'function'`, { timeoutMs: 60_000 });
    } catch {
      throw new Error(`the page never registered knob ${k} — the game calls window.__sloptimizeKnob(${k}, (n) => …set it to n…)`);
    }
    await api.eval(`globalThis.__sloptimizeKnobs[${k}](${Number(value)})`);
    await api.phase('sweep-settle');
    await api.wait(settleS * 1000);
    await api.phase(SWEEP_PHASE);
    await api.eval(`globalThis.__sloptimizeScale(${k}, ${Number(value)})`);
    await api.wait(measureS * 1000);
    await api.phase('sweep-done');
  }
  return sweepLevel;
}

/** One run's metrics in the sweep phase. */
export function levelMetrics(records, run) {
  const m = {};
  const ph = new Set([SWEEP_PHASE]);
  const bucket = run ? runBucket(run, ph) : null;
  const t = spanTable(phaseSpans(records.filter((r) => r.phase === SWEEP_PHASE))).get(SWEEP_PHASE);
  // The mean frame of the measured span (its ms over its frames): a 120-frame
  // window may never close at a large N, the span always does.
  const frame = t?.frameMs ?? bucket?.frame?.medianMs;
  if (frame !== undefined) m['frame ms'] = frame;
  for (const [name, e] of t?.sections ?? []) if (e.perCall !== undefined) m[`section ${name} ms/call`] = e.perCall;
  // Per FRAME, not per second: as N grows the frames lengthen and a
  // per-second figure flattens exactly the curve the sweep is for.
  const fns = {};
  const frames = t?.frames;
  if (bucket && frames > 0 && run.intervalUs) {
    for (const r of bucket.fns.values()) {
      if (!r.self) continue;
      const k = `fn ${r.fn}@${stableFile(r.url) || '?'} ms/frame`;
      fns[k] = (fns[k] ?? 0) + r.self * run.intervalUs / 1000 / frames;
    }
  }
  for (const tr of bucket ? threadRows(bucket, m['frame ms']) : []) if (tr.name !== 'main' && tr.perFrameMs !== undefined) m[`thread ${tr.name} ms/frame`] = tr.perFrameMs;
  return { metrics: m, fns };
}

/** Log-log least squares over (n, y) points: the exponent and its 95% interval. */
export function fitExponent(points) {
  const pts = points.filter(([n, y]) => n > 0 && y > 0).map(([n, y]) => [Math.log(n), Math.log(y)]);
  const xs = new Set(pts.map(([x]) => x));
  if (xs.size < 2) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / pts.length, my = pts.reduce((s, [, y]) => s + y, 0) / pts.length;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  const k = sxy / sxx;
  const out = { k: +k.toFixed(2), n: pts.length };
  if (pts.length > 2 && xs.size >= 3) {
    let ss = 0;
    for (const [x, y] of pts) ss += (y - (my + k * (x - mx))) ** 2;
    const se = Math.sqrt(ss / (pts.length - 2) / sxx);
    const t = T95[pts.length - 2] ?? 2;
    out.lo = +(k - t * se).toFixed(2); out.hi = +(k + t * se).toFixed(2);
  }
  return out;
}

/** The fit, in words — only as strong as its interval allows. */
export function shapeOf(fit, steps = []) {
  if (!fit) return 'one level: no shape';
  if (fit.lo === undefined) return 'two levels: a slope, no interval — add a third level';
  if (fit.hi - fit.lo > 0.6) return 'noisy — more runs a level';
  const k = fit.k;
  const word = k < 0.8 ? 'sub-linear' : k <= 1.2 ? 'linear' : k < 1.8 ? 'SUPER-LINEAR' : 'QUADRATIC or worse';
  const bend = steps.length >= 2 && steps.at(-1) - steps[0] >= 0.4 ? ', bending upward' : '';
  return `${word}${bend}`;
}

const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * The sweep table: every metric against N.
 * @param {{value:number, sessions:string[]}[]} levels
 * @param {object[]} records  the ledger (perf.jsonl)
 * @param {object[]} runFiles runs/*.json
 * @param {{frameBudgetMs?:number}} [o]
 */
export function sweepTable(levels, records, runFiles, { frameBudgetMs = 1000 / 60 } = {}) {
  const per = levels.map((L) => ({
    value: L.value,
    runs: L.sessions.map((s) => levelMetrics(records.filter((r) => r.session === s), runFiles.find((f) => f.session === s))),
  }));
  // Functions: the heaviest at the largest level, followed down the levels.
  const top = per.at(-1)?.runs.flatMap((r) => Object.entries(r.fns)) ?? [];
  const fnKeys = [...new Map(top.sort((a, b) => b[1] - a[1])).keys()].slice(0, FN_ROWS);
  // A level whose sweep phase was sampled and never ran the function read 0;
  // a level with no samples in the phase at all reads nothing.
  for (const L of per) for (const r of L.runs) if (Object.keys(r.fns).length) for (const k of fnKeys) r.metrics[k] = r.fns[k] ?? 0;
  const names = [];
  for (const L of per) for (const r of L.runs) for (const k of Object.keys(r.metrics)) if (!names.includes(k)) names.push(k);
  const rows = names.map((metric) => {
    const cells = per.map((L) => {
      const v = L.runs.map((r) => r.metrics[metric]).filter((x) => typeof x === 'number');
      return v.length ? { median: +median(v).toPrecision(4), lo: Math.min(...v), hi: Math.max(...v), n: v.length } : null;
    });
    const steps = [];
    for (let i = 1; i < per.length; i++) {
      const a = cells[i - 1], b = cells[i];
      steps.push(a && b && a.median > 0 && b.median > 0 ? +(Math.log(b.median / a.median) / Math.log(per[i].value / per[i - 1].value)).toFixed(2) : null);
    }
    const pts = per.flatMap((L, i) => L.runs.map((r) => [L.value, r.metrics[metric]]).filter(([, y]) => typeof y === 'number'));
    const fit = fitExponent(pts);
    return { metric, cells, steps, fit, shape: shapeOf(fit, steps.filter((x) => x !== null)) };
  });
  // Capacity: the largest level that holds the frame budget, and where it
  // crosses — interpolated only from a level clearly UNDER the budget (a
  // vsync-locked frame sits at it and says nothing about the slope), and
  // extrapolated past the last level only from the last step, labelled so.
  let capacity;
  const frame = rows.find((r) => r.metric === 'frame ms');
  if (frame && frameBudgetMs > 0) {
    const xs = per.map((L) => L.value), ys = frame.cells.map((c) => c?.median);
    const budgetMs = +frameBudgetMs.toFixed(1);
    const over = (y) => y !== undefined && y > frameBudgetMs * 1.03;
    const i = ys.findIndex(over);
    if (i === 0) capacity = { budgetMs, holds: null, over: xs[0], overMs: ys[0] };
    else if (i > 0) {
      capacity = { budgetMs, holds: xs[i - 1], over: xs[i], overMs: ys[i] };
      const y0 = ys[i - 1];
      if (y0 !== undefined && y0 < frameBudgetMs * 0.97) {
        const k = Math.log(ys[i] / y0) / Math.log(xs[i] / xs[i - 1]);
        if (k > 0) capacity.n = Math.round(xs[i - 1] * (frameBudgetMs / y0) ** (1 / k));
      }
    } else {
      capacity = { budgetMs, holds: xs.at(-1), over: null };
      const k = frame.steps.filter((x) => x !== null).at(-1);
      const yl = ys.at(-1);
      // A frame that barely grows (vsync-bound, k ≈ 0) has no honest crossing.
      if (k > 0.1 && yl > 0 && yl < frameBudgetMs * 0.97) { capacity.n = Math.round(xs.at(-1) * (frameBudgetMs / yl) ** (1 / k)); capacity.extrapolated = true; }
    }
  }
  return { levels: per.map((L) => ({ value: L.value, runs: L.runs.length })), rows, ...(capacity ? { capacity } : {}) };
}
