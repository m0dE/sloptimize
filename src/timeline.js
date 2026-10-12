// ============================================================
// timeline.js — a metric across commits: a staircase or a cliff (SPEC §3.19)
// ============================================================
// A 12-day regression was found by hand: check out a commit, build it,
// launch it, attach, write the number down, next commit. `sloptimize
// timeline` does that loop — commits, a build command, a launch command, one
// attached session each (the same settle-then-measure window every time) —
// and reads the result the way the hunt needs it read:
//   · a CLIFF: one step carries most of the change — that commit is the
//     regression, and the per-step profile diff says where it went;
//   · a STAIRCASE: several steps each moved it — no single culprit, and
//     reverting one commit will not bring it back;
//   · FLAT or DRIFT: nothing above the noise, or a slope no step explains.
// The noise is measured, not assumed: the spread of a commit's own runs
// when there are several, else the typical step between neighbouring
// commits (most commits in a range change nothing). A step counts only when
// it clears that floor.
//
// Pure: the CLI drives git, the build and attach; this reads what they left.

import { runMetrics, compareSides } from './compare.js';
import { runBucket } from './runs.js';
import { phaseSpans, spanTable } from './spans.js';
import { stableFile } from './footprint.js';

export const TIMELINE_PHASE = 'timeline';
/** A step carrying this share of the whole change is the cliff. */
const CLIFF_SHARE = 0.6;

/**
 * The drive each step runs (attach's drive api): settle, then measure in
 * the `timeline` phase — the same window for every commit.
 */
export function stepDrive({ settleS = 5, measureS = 20 } = {}) {
  async function timelineStep(api) {
    await api.phase('timeline-settle');
    await api.wait(settleS * 1000);
    await api.phase(TIMELINE_PHASE);
    await api.wait(measureS * 1000);
    await api.phase('timeline-done');
  }
  return timelineStep;
}

/** Metrics a timeline reads by default, best first: the app's own frame
 *  timer, else the sampled main-thread work per frame — a tier-0 frame
 *  interval is vsync-quantized, and 2 ms → 8 ms of work both present at 16.7. */
export const DEFAULT_METRICS = ['frame body ms', 'main busy ms/frame'];

/** One session's metrics (compare.js), plus the two a timeline adds. */
export function stepMetrics(session, records, runFile, phases, conditionLines = []) {
  const recs = records.filter((r) => r.session === session);
  const m = runMetrics(session, recs, runFile, phases, conditionLines.filter((c) => c.session === session));
  const b = runFile ? runBucket(runFile, phases) : null;
  const table = spanTable(phaseSpans(recs));
  const span = phases ? [...phases].map((p) => table.get(p)).find((t) => t?.frameMs !== undefined) : undefined;
  const frameMs = span?.frameMs ?? b?.frame?.medianMs;
  if (frameMs !== undefined) m.metrics['frame mean ms'] = frameMs;
  if (b && b.wallMs > 0 && frameMs) m.metrics['main busy ms/frame'] = r3(Math.min(1, b.busyMs / b.wallMs) * frameMs);
  // Each function's time per frame of the span, self AND inclusive: a cost
  // that lands in a shared helper (inlined, or a util every caller uses) is
  // only visible as the caller's inclusive time.
  if (b && runFile.intervalUs && span?.frames > 0) {
    m.fnMs = new Map();
    for (const r of b.fns.values()) {
      const k = `${r.fn}@${stableFile(r.url) || '?'}`;
      const e = m.fnMs.get(k) ?? m.fnMs.set(k, { self: 0, total: 0 }).get(k);
      e.self += r.self * runFile.intervalUs / 1000 / span.frames;
      e.total += r.total * runFile.intervalUs / 1000 / span.frames;
    }
    m.fnPer = 'frame';
  }
  return m;
}

/** The functions that moved most between two steps, ms per frame, self and inclusive. */
function fnMoves(aRuns, bRuns, limit = 4) {
  const mean = (runs) => {
    const out = new Map(), with_ = runs.filter((r) => r.fnMs);
    for (const r of with_) for (const [k, v] of r.fnMs) { const e = out.get(k) ?? out.set(k, { self: 0, total: 0 }).get(k); e.self += v.self / with_.length; e.total += v.total / with_.length; }
    return with_.length ? out : null;
  };
  const A = mean(aRuns), B = mean(bRuns);
  if (!A || !B) return [];
  const rows = [...new Set([...A.keys(), ...B.keys()])].map((k) => {
    const a = A.get(k) ?? { self: 0, total: 0 }, b = B.get(k) ?? { self: 0, total: 0 };
    return { fn: k, self: r3(b.self - a.self), total: r3(b.total - a.total), a: r3(a.total), b: r3(b.total) };
  });
  const pick = new Map();
  for (const r of [...rows].sort((x, y) => Math.abs(y.self) - Math.abs(x.self)).slice(0, 2)) pick.set(r.fn, r);
  for (const r of [...rows].sort((x, y) => Math.abs(y.total) - Math.abs(x.total))) { if (pick.size >= limit) break; pick.set(r.fn, r); }
  return [...pick.values()].filter((r) => r.self !== 0 || r.total !== 0);
}

const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (x) => +x.toFixed(3);

/**
 * @param {{sha:string, subject?:string, sessions:string[], status?:string}[]} steps  oldest first
 * @param {object[]} records   the ledger
 * @param {object[]} runFiles  runs/*.json
 * @param {{metric?:string, phases?:Set<string>|null, conditionLines?:object[]}} [o]
 */
export function timelineTable(steps, records, runFiles, { metric, phases = new Set([TIMELINE_PHASE]), conditionLines = [] } = {}) {
  const per = steps.map((st) => ({ sha: st.sha, subject: st.subject, status: st.status,
    runs: (st.sessions ?? []).map((s) => stepMetrics(s, records, runFiles.find((f) => f.session === s), phases, conditionLines)) }));
  // The metric: asked for, else the best default every measured step has.
  const has = (k) => per.filter((p) => p.runs.length).every((p) => p.runs.some((r) => typeof r.metrics[k] === 'number'));
  metric ??= DEFAULT_METRICS.find(has) ?? 'frame median ms';
  for (const p of per) {
    p.vals = p.runs.map((r) => r.metrics[metric]).filter((v) => typeof v === 'number');
    p.value = p.vals.length ? r3(median(p.vals)) : undefined;
  }
  const measured = per.filter((p) => p.value !== undefined);
  const out = { metric, steps: per.map((p) => ({ sha: p.sha, subject: p.subject, ...(p.status ? { status: p.status } : {}), value: p.value, runs: p.vals.length })) };
  if (measured.length < 2) return { ...out, shape: { kind: 'unmeasured', text: `${measured.length} of ${per.length} commits measured ${metric} — nothing to read a shape from` } };
  // Steps between MEASURED neighbours: a commit that failed to build is skipped over.
  const deltas = [];
  for (let i = 1; i < measured.length; i++) deltas.push({ from: measured[i - 1], to: measured[i], d: r3(measured[i].value - measured[i - 1].value) });
  const within = Math.max(0, ...measured.filter((p) => p.vals.length > 1).map((p) => Math.max(...p.vals) - Math.min(...p.vals)));
  const typical = median(deltas.map((x) => Math.abs(x.d)));
  const first = measured[0].value, last = measured.at(-1).value;
  const total = r3(last - first);
  // Measured when it can be: a commit's own runs, else the typical step of a
  // range long enough that most of its steps changed nothing. Otherwise
  // assumed, and said so.
  const mid = median(measured.map((p) => Math.abs(p.value)));
  const from = within > 0 ? 'runs of one commit' : deltas.length >= 4 ? 'the typical step between commits' : 'assumed 10% (one run a commit, under 5 commits: --runs 2 measures it)';
  const noise = r3(Math.max(within > 0 ? 2 * within : deltas.length >= 4 ? 3 * typical : 0.1 * mid, 0.02 * mid));
  out.noise = { floor: noise, from, within: r3(within), typicalStep: r3(typical) };
  out.total = total;
  const sig = deltas.filter((x) => Math.abs(x.d) > noise && Math.sign(x.d) === Math.sign(total));
  for (const s of out.steps) {
    const x = deltas.find((d) => d.to.sha === s.sha);
    if (x) { s.delta = x.d; if (sig.includes(x)) s.significant = true; }
  }
  const word = (d) => `${d > 0 ? '+' : ''}${+d.toFixed(2)}`;
  if (Math.abs(total) <= noise) {
    out.shape = { kind: 'flat', text: `flat: ${word(total)} first to last, inside the ${noise} noise floor` };
  } else {
    const big = sig.find((x) => Math.abs(x.d) >= CLIFF_SHARE * Math.abs(total));
    // A share past 100%: the steps around it went the other way (a noisy first run, a partial fix) — said as the two numbers.
    const of = (d) => (Math.abs(d) <= Math.abs(total) ? `${word(d)} of ${word(total)}, ${Math.round(100 * d / total)}%` : `${word(d)}; first to last ${word(total)}`);
    if (big) out.shape = { kind: 'cliff', at: big.to.sha, from: big.from.sha, delta: big.d, share: r3(big.d / total), text: `CLIFF at ${big.to.sha.slice(0, 10)} (${of(big.d)})${big.to.subject ? ` — ${big.to.subject}` : ''}` };
    else if (sig.length >= 2) out.shape = { kind: 'staircase', steps: sig.map((x) => ({ at: x.to.sha, delta: x.d })), text: `STAIRCASE: ${sig.length} steps — ${sig.map((x) => `${x.to.sha.slice(0, 10)} ${word(x.d)}`).join(', ')} of ${word(total)}; no single commit to revert` };
    else if (sig.length === 1) out.shape = { kind: 'step', at: sig[0].to.sha, delta: sig[0].d, share: r3(sig[0].d / total), text: `one step above the noise at ${sig[0].to.sha.slice(0, 10)} (${word(sig[0].d)} of ${word(total)}); the rest is drift` };
    else out.shape = { kind: 'drift', text: `DRIFT: ${word(total)} first to last with no step above the ${noise} noise floor — many small changes, or a slow environment` };
  }
  // The per-step profile diff, for every step that moved: the functions
  // (ms per frame, self and inclusive) and the host's sections and threads
  // that moved most from the commit before.
  out.diffs = {};
  for (const x of sig) {
    const c = compareSides({ label: x.from.sha, runs: x.from.runs }, { label: x.to.sha, runs: x.to.runs }, { phaseScoped: true });
    const other = c.rows.filter((r) => /^(section|thread) /.test(r.metric) && r.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3)
      .map((r) => ({ metric: r.metric, a: r.a.median, b: r.b.median, delta: r.delta }));
    out.diffs[x.to.sha] = { fns: fnMoves(x.from.runs, x.to.runs), other };
  }
  return out;
}
