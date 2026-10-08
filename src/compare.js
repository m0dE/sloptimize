// ============================================================
// compare.js — A vs B, each metric against its own noise floor
// ============================================================
// One global "within noise" hides exactly the signal that is provable. The
// field A/B that asked for this: frame deltas of +0.20, +0.48 and +0.79 ms,
// all inside a ~1.2 ms frame noise floor — unprovable; and one loop section
// (collision, +0.24 ms) that reproduced to two decimals across both reps,
// because its own run-to-run spread is an order of magnitude smaller. So a
// side is a set of RUNS (one attach session / one tier-1 session each), every
// metric is read per run, and every metric gets its own floor: the larger of
// the two sides' run-to-run ranges.
//
// A delta is `significant` when every run of B lies beyond every run of A
// AND the delta exceeds twice that floor. Separation alone is weak at two
// reps a side (4 values fall fully apart by chance one time in three); the
// floor multiple is what makes "reproduced to two decimals" count. A side
// with one run has no floor at all, and the row says so rather than guess.
//
// The same runs answer the machine question. A code regression moves the
// COMPOSITION — the function (or loop section) that got slower takes a
// larger share. A machine that got slower (the dev build sharing the GPU:
// once reported as a +46% regression) scales everything and leaves the
// shares where they were. Uniform change + unchanged composition is flagged.
//
// And before any of that: were the two sides measured under the same
// conditions at all (conditions.js)? A different display, instrument, GPU or
// run mode is not a delta to judge — `conditions.comparable` is false and the
// CLI refuses (exit 3) unless told --allow-mismatch.
//
// Pure: the CLI reads perf.jsonl + runs/*.json and hands them to
// resolveSide; a test hands a fixture.

import { stableFile } from './footprint.js';
import { runBucket, emptyTally, foldTally, ratesOf } from './runs.js';
import { runConditions, compareConditions } from './conditions.js';
import { phaseSpans, spanTable, oneOf, sectionVerdict } from './spans.js';
import { threadRows } from './threads.js';

function median(vals) {
  if (vals.length === 0) return undefined;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// Three decimals, but never fewer than 4 significant figures: a cost per
// unit or per call of 0.0049 ms must not compare as 0.005 against 0.005.
const r3 = (x) => (x === undefined ? undefined : x !== 0 && Math.abs(x) < 1 ? +x.toPrecision(4) : +x.toFixed(3));

/** Composition moved less than this (total variation distance of the share
 *  vectors) while the frame moved ≥ UNIFORM_RATIO: the machine, not the code. */
export const COMPOSITION_STILL = 0.05;
export const UNIFORM_RATIO = 1.1;
/** A function joins the per-metric rows at ≥1% of JS samples on either side. */
const FN_ROW_SHARE = 0.01;
const FN_ROWS = 15;

/**
 * Everything one run measured, as flat metrics. `records` are that run's
 * ledger lines (already phase-filtered); `run` its runs/<session>.json, if
 * attach wrote one.
 * @returns {{session:string, tier?:number, metrics:Record<string,number>, fnShares?:Map<string,number>, sectionShares?:Map<string,number>}}
 */
export function runMetrics(session, records, run, phases = null, conditionLines = []) {
  const beats = records.filter((r) => r.type === 'heartbeat');
  const profiles = records.filter((r) => r.type === 'profile' && (r.sections || r.counts));
  const hitches = records.filter((r) => r.type === 'hitch' && typeof r.frameMs === 'number');
  const nums = (xs) => xs.filter((v) => typeof v === 'number');
  const bucket = run ? runBucket(run, phases) : null;
  const m = {};
  const put = (k, v) => { if (v !== undefined && Number.isFinite(v)) m[k] = v; };
  // Tier 0's run file folds every 120-frame window of the run; the beats hold
  // one 600-frame ring a minute. The fuller one wins.
  put('frame median ms', bucket?.frame?.medianMs ?? median(nums([...beats.map((b) => b.medianFrameMs), ...profiles.map((p) => p.frame?.medianMs)])));
  put('frame p95 ms', bucket?.frame?.p95Ms ?? median(nums([...beats.map((b) => b.p95Ms), ...profiles.map((p) => p.frame?.p95Ms)])));
  put('frame body ms', median(nums(profiles.map((p) => p.frame?.bodyMs))));
  put('draw calls', bucket?.frame?.calls ?? median(nums(beats.map((b) => b.calls))));
  put('triangles', median(nums(beats.map((b) => b.triangles))));
  const times = records.map((r) => Date.parse(r.at)).filter(Number.isFinite);
  if (run?.from) times.push(Date.parse(run.from), Date.parse(run.to));
  if (times.length && (beats.length || hitches.length || bucket?.frame)) {
    const hours = Math.max((Math.max(...times) - Math.min(...times)) / 3_600_000, 1 / 60);
    put('hitches/h', +(hitches.length / hours).toFixed(1));
  }
  const sections = new Map();
  for (const p of profiles) for (const [k, v] of Object.entries(p.sections ?? {})) if (typeof v === 'number') (sections.get(k) ?? sections.set(k, []).get(k)).push(v);
  let sectionShares;
  if (sections.size) {
    const meds = [...sections].map(([k, v]) => [k, median(v)]);
    for (const [k, v] of meds) put(`section ${k} ms`, v);
    const sum = meds.reduce((a, [, v]) => a + Math.max(v, 0), 0);
    if (sum > 0) sectionShares = new Map(meds.map(([k, v]) => [k, Math.max(v, 0) / sum]));
  }
  // The game's counters as rates over its own clock (SPEC §3.11), one row
  // each: a tier-0 run's from its run file, a tier-1 host's from its lines.
  const tally = bucket?.tally ?? emptyTally();
  for (const r of records) if (r.type === 'profile' && r.tally && !(run && r.tier === 0)) foldTally(tally, r);
  const rates = ratesOf(tally);
  if (rates) for (const [k, v] of Object.entries(rates.values)) put(`rate ${k} /${rates.per}`, v);
  // Phases as spans (spans.js): how long each took, per unit of what it
  // worked on, and the host's sections as total ms × calls. A section name
  // reported in two phases is two sections, phase-qualified.
  const table = spanTable(phaseSpans(records));
  const scales = {}, sectionPhase = {};
  const named = new Map();
  for (const [, t] of table) for (const name of t.sections.keys()) named.set(name, (named.get(name) ?? 0) + 1);
  for (const [ph, t] of table) {
    if (t.ms !== undefined) put(`phase ${ph} ms`, t.ms);
    if (Object.keys(t.scale).length) scales[ph] = t.scale;
    for (const [u, v] of Object.entries(t.perUnit)) put(`phase ${ph} ms/${oneOf(u)}`, v);
    for (const [name, e] of t.sections) {
      const k = named.get(name) > 1 ? `${ph}/${name}` : name;
      sectionPhase[k] = ph;
      put(`section ${k} total ms`, e.ms);
      if (e.calls > 0) { put(`section ${k} calls`, e.calls); put(`section ${k} ms/call`, e.perCall); }
    }
  }
  // Threads (SPEC §3.18): each one's busy share and ms of the frame, so a
  // sim that moved into a worker is a row of its own, not a disappearance.
  for (const t of bucket ? threadRows(bucket, m['frame median ms']) : []) {
    put(`thread ${t.name} busy %`, +(t.busy * 100).toFixed(1));
    if (t.perFrameMs !== undefined) put(`thread ${t.name} ms/frame`, t.perFrameMs);
  }
  let fnShares;
  const js = bucket ? bucket.samples - bucket.program - bucket.gc : 0;
  if (bucket && js > 0) {
    // By NAME and hash-stripped file, never by position: A and B are two
    // bundles, and every line moved.
    fnShares = new Map();
    for (const r of bucket.fns.values()) {
      if (!r.self) continue;
      const k = `${r.fn}@${stableFile(r.url) || '?'}`;
      fnShares.set(k, (fnShares.get(k) ?? 0) + r.self / js);
    }
  }
  // A worker's functions, each under its thread and a share of THAT thread's
  // JS: a sim worker's step() is not a slice of the page. Rows of their own;
  // the page's composition check reads the page's shares only.
  let workerFnShares;
  if (bucket?.threads?.size) {
    workerFnShares = new Map();
    for (const [name, t] of bucket.threads) {
      const tjs = t.samples - t.program - t.gc;
      if (!(tjs > 0)) continue;
      for (const r of t.fns.values()) {
        if (!r.self) continue;
        const k = `${name}:${r.fn}@${stableFile(r.url) || '?'}`;
        workerFnShares.set(k, (workerFnShares.get(k) ?? 0) + r.self / tjs);
      }
    }
  }
  const tier = records.some((r) => r.tier === 0) || run ? 0 : records.some((r) => r.type === 'heartbeat' || r.type === 'profile') ? 1 : undefined;
  const conditions = runConditions([...records, ...conditionLines], run);
  const spans = Object.keys(scales).length || Object.keys(sectionPhase).length ? { scales, sectionPhase } : undefined;
  return { session, ...(tier !== undefined ? { tier } : {}), metrics: m, conditions, ...(fnShares ? { fnShares } : {}), ...(sectionShares ? { sectionShares } : {}), ...(spans ? { spans } : {}), ...(workerFnShares?.size ? { workerFnShares } : {}) };
}

function spread(vals) {
  if (vals.length === 0) return undefined;
  return { n: vals.length, median: r3(median(vals)), lo: r3(Math.min(...vals)), hi: r3(Math.max(...vals)) };
}

/** Half the L1 distance of two share maps — 0 identical, 1 disjoint. */
export function tvd(a, b) {
  let d = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) d += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return d / 2;
}

/** The side's shares, averaged over its runs. */
function meanShares(list) {
  const out = new Map();
  for (const m of list) for (const [k, v] of m) out.set(k, (out.get(k) ?? 0) + v / list.length);
  return out;
}

function row(metric, av, bv) {
  const a = spread(av), b = spread(bv);
  const delta = r3(b.median - a.median);
  const r = { metric, a, b, delta };
  if (a.n < 2 || b.n < 2) { r.verdict = 'unproven'; r.why = `n=${Math.min(a.n, b.n)} on a side: no noise floor`; return r; }
  const noise = r3(Math.max(a.hi - a.lo, b.hi - b.lo));
  r.noise = noise;
  const apart = a.hi < b.lo || b.hi < a.lo;
  r.verdict = apart && Math.abs(delta) > 2 * noise ? 'significant' : 'within noise';
  return r;
}

/**
 * @param {{label:string, runs:ReturnType<typeof runMetrics>[]}} A
 * @param {{label:string, runs:ReturnType<typeof runMetrics>[]}} B
 */
export function compareSides(A, B, { phaseScoped = false } = {}) {
  const names = [];
  for (const r of [...A.runs, ...B.runs]) for (const k of Object.keys(r.metrics)) if (!names.includes(k)) names.push(k);
  const rows = [];
  const vals = (side, k) => side.runs.map((r) => r.metrics[k]).filter((v) => v !== undefined);
  for (const k of names) {
    const av = vals(A, k), bv = vals(B, k);
    if (av.length && bv.length) rows.push(row(k, av, bv));
  }
  // Functions, as rows of their own: each is a metric with its own floor —
  // the per-function compare the diff script was written for.
  const fa = A.runs.filter((r) => r.fnShares), fb = B.runs.filter((r) => r.fnShares);
  const out = { a: { label: A.label, runs: A.runs.map((r) => r.session) }, b: { label: B.label, runs: B.runs.map((r) => r.session) }, rows, warnings: [] };
  // A run built by hand (a test, an old caller) still says its instrument.
  const condOf = (r) => r.conditions ?? (r.tier === 0 ? { instrument: 'attach' } : r.tier === 1 ? { instrument: 'in-app' } : {});
  const ca = A.runs.map(condOf), cb = B.runs.map(condOf);
  out.conditions = { a: ca, b: cb, ...compareConditions(ca, cb, { phaseScoped }) };
  if (fa.length && fb.length) {
    const ma = meanShares(fa.map((r) => r.fnShares)), mb = meanShares(fb.map((r) => r.fnShares));
    const keys = [...new Set([...ma.keys(), ...mb.keys()])]
      .filter((k) => Math.max(ma.get(k) ?? 0, mb.get(k) ?? 0) >= FN_ROW_SHARE)
      .sort((x, y) => Math.max(mb.get(y) ?? 0, ma.get(y) ?? 0) - Math.max(mb.get(x) ?? 0, ma.get(x) ?? 0))
      .slice(0, FN_ROWS);
    for (const k of keys) rows.push(row(`fn ${k} %js`, fa.map((r) => +((r.fnShares.get(k) ?? 0) * 100).toFixed(2)), fb.map((r) => +((r.fnShares.get(k) ?? 0) * 100).toFixed(2))));
  }
  // Worker functions (SPEC §3.18): the same rows, each a share of its thread.
  const wa = A.runs.filter((r) => r.workerFnShares), wb = B.runs.filter((r) => r.workerFnShares);
  if (wa.length && wb.length) {
    const ma = meanShares(wa.map((r) => r.workerFnShares)), mb = meanShares(wb.map((r) => r.workerFnShares));
    const keys = [...new Set([...ma.keys(), ...mb.keys()])]
      .filter((k) => Math.max(ma.get(k) ?? 0, mb.get(k) ?? 0) >= FN_ROW_SHARE)
      .sort((x, y) => Math.max(mb.get(y) ?? 0, ma.get(y) ?? 0) - Math.max(mb.get(x) ?? 0, ma.get(x) ?? 0))
      .slice(0, FN_ROWS);
    for (const k of keys) rows.push(row(`fn ${k} %thread`, wa.map((r) => +((r.workerFnShares.get(k) ?? 0) * 100).toFixed(2)), wb.map((r) => +((r.workerFnShares.get(k) ?? 0) * 100).toFixed(2))));
  }
  // Composition: sections when the host measured them (exact), else the
  // sampled function shares. `within` is the largest distance between two
  // runs of ONE side — the composition's own noise.
  const comp = (key) => {
    const ra = A.runs.filter((r) => r[key]).map((r) => r[key]), rb = B.runs.filter((r) => r[key]).map((r) => r[key]);
    if (!ra.length || !rb.length) return undefined;
    let within = 0;
    for (const side of [ra, rb]) for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) within = Math.max(within, tvd(side[i], side[j]));
    return { by: key === 'sectionShares' ? 'sections' : 'functions', moved: r3(tvd(meanShares(ra), meanShares(rb))), ...(ra.length + rb.length > 2 ? { within: r3(within) } : {}) };
  };
  spanFindings(A, B, out);
  const composition = comp('sectionShares') ?? comp('fnShares');
  if (composition) out.composition = composition;
  const frame = rows.find((r) => r.metric === 'frame body ms') ?? rows.find((r) => r.metric === 'frame median ms');
  if (frame && composition && frame.a.median > 0) {
    const ratio = frame.b.median / frame.a.median;
    const calls = rows.find((r) => r.metric === 'draw calls');
    const sameDraws = !calls || Math.abs(calls.b.median - calls.a.median) <= 0.02 * Math.max(calls.a.median, 1);
    const still = composition.moved < Math.max(COMPOSITION_STILL, 1.5 * (composition.within ?? 0));
    if ((ratio >= UNIFORM_RATIO || ratio <= 1 / UNIFORM_RATIO) && still && sameDraws) {
      const pct = Math.round((ratio - 1) * 100);
      out.hostSuspect = { ratio: r3(ratio), metric: frame.metric, moved: composition.moved };
      out.warnings.push(`uniform ${pct > 0 ? 'slowdown' : 'speedup'} (${frame.metric.replace(/ ms$/, '')} ${pct > 0 ? '+' : ''}${pct}%) with unchanged composition (${composition.by} shares moved ${+(composition.moved * 100).toFixed(1)}%${calls ? ', draw calls equal' : ''}) — suspect the machine (another process on the GPU/CPU, thermals, power), not the code: a code change moves shares`);
    }
  }
  const tiers = (side) => new Set(side.runs.map((r) => r.tier).filter((t) => t !== undefined));
  const ta = tiers(A), tb = tiers(B);
  if (ta.size && tb.size && [...ta, ...tb].some((t) => !ta.has(t) || !tb.has(t))) {
    out.warnings.push(`the sides were measured by different instruments (tier ${[...ta].join('/')} vs tier ${[...tb].join('/')}) — an attached run pays for its recorder and reads rAF intervals; its timings do not compare with an unattached run's`);
  }
  return out;
}

/** Sizes that differ by more than this are different inputs. */
const SCALE_SAME = 0.01;

/**
 * The span half of a compare (spans.js), onto `out`:
 *   · a phase whose two sides worked on different SIZES — a 286-road save
 *     against a 1469-road one — has its absolute rows (`phase X ms`, a
 *     section's total and calls) marked `unlike`: never significant, never a
 *     regression. Its per-unit row is the comparison; that reading assumes
 *     cost linear in the unit, which runs of one build at two sizes check.
 *   · every section measured on both sides gets a verdict on WHICH factor
 *     moved — the call count or the ms per call (`out.sections`).
 */
function spanFindings(A, B, out) {
  const med = (side, f) => median(side.runs.map(f).filter((v) => v !== undefined));
  const phases = new Set([...A.runs, ...B.runs].flatMap((r) => Object.keys(r.spans?.scales ?? {})));
  const unlike = new Map();   // phase → why
  const unlikeBy = new Map(); // phase → [unit, A size, B size]: the first that differs
  for (const ph of phases) {
    const units = new Set([...A.runs, ...B.runs].flatMap((r) => Object.keys(r.spans?.scales?.[ph] ?? {})));
    for (const u of units) {
      const a = med(A, (r) => r.spans?.scales?.[ph]?.[u]), b = med(B, (r) => r.spans?.scales?.[ph]?.[u]);
      if (a === undefined || b === undefined) {
        out.warnings.push(`phase ${ph}: only ${a === undefined ? 'B' : 'A'} declared its size in ${u} — its absolute time compares against an input of unknown size (__sloptimizeScale('${u}', n) on both)`);
        continue;
      }
      if (Math.abs(b - a) <= SCALE_SAME * Math.max(a, b)) continue;
      const why = `different sizes: ${u} ${+a.toFixed(2)} vs ${+b.toFixed(2)}`;
      if (!unlikeBy.has(ph)) unlikeBy.set(ph, [u, a, b]);
      unlike.set(ph, unlike.has(ph) ? `${unlike.get(ph)}, ${u} ${+a.toFixed(2)} vs ${+b.toFixed(2)}` : why);
    }
  }
  const phaseOfSection = (name) => A.runs.concat(B.runs).map((r) => r.spans?.sectionPhase?.[name]).find((x) => x !== undefined);
  for (const r of out.rows) {
    let ph = /^phase (.+) ms$/.exec(r.metric)?.[1];
    const sec = /^section (.+) (total ms|calls)$/.exec(r.metric);
    if (sec) ph = phaseOfSection(sec[1]);
    if (ph !== undefined && unlike.has(ph)) { r.verdict = 'unlike'; r.why = `${unlike.get(ph)} — read the per-unit row`; }
  }
  for (const [ph, why] of unlike) {
    const per = out.rows.filter((r) => r.metric.startsWith(`phase ${ph} ms/`)).map((r) => r.metric.slice(`phase ${ph} `.length));
    out.warnings.push(`phase ${ph}: the sides worked on ${why} — its absolute time and section totals compare unlike inputs; ${per.length ? `${per.join(', ')} is the comparison` : 'no per-unit row'} (per unit assumes cost linear in size: runs of one build at two sizes check it)`);
  }
  const names = new Set();
  for (const r of out.rows) { const m = /^section (.+) total ms$/.exec(r.metric); if (m) names.add(m[1]); }
  const sections = [];
  for (const name of names) {
    const side = (S) => {
      const ms = med(S, (r) => r.metrics[`section ${name} total ms`]), calls = med(S, (r) => r.metrics[`section ${name} calls`]);
      return ms === undefined ? undefined : { ms: r3(ms), ...(calls !== undefined ? { calls: r3(calls), perCall: +(ms / calls).toPrecision(4) } : {}) };
    };
    const a = side(A), b = side(B);
    if (!a || !b) continue;
    const ph = phaseOfSection(name);
    // Unlike sizes: more roads means more calls. The verdict reads calls PER
    // UNIT against ms per call, so a bigger save is not "called more".
    const by = ph !== undefined ? unlikeBy.get(ph) : undefined;
    const per = (x, n) => ({ ms: x.ms / n, ...(x.calls !== undefined ? { calls: x.calls / n } : {}) });
    const v = by ? sectionVerdict(per(a, by[1]), per(b, by[2])) : sectionVerdict(a, b);
    sections.push({ name, a, b, moved: v.moved, text: by ? `per ${oneOf(by[0])}: ${v.text}` : v.text, ...(by ? { unlike: unlike.get(ph) } : {}) });
  }
  if (sections.length) out.sections = sections;
}

/** Silence that ends a run of records carrying no `session` (tier-1 ledger
 *  lines) — the same five minutes `history` cuts runs at. */
const RUN_GAP_MS = 5 * 60_000;

/**
 * One side of a compare, from a spec: a build, a session id, an
 * `<ISO>..<ISO>` window, or a comma list of those (their runs pooled — how
 * back-to-back sessionless runs are named one by one). Runs are sessions;
 * records with no session are cut into runs at RUN_GAP_MS silences, except
 * inside one window element, which is one run by construction.
 * `conditionLines` are the ledger's `conditions` records, unfiltered by phase
 * (a --phase read must not drop what the run was measured under).
 * @returns {{label:string, runs:object[]} | {error:string}}
 */
export function resolveSide(spec, records, runFiles, phases = null, conditionLines = []) {
  const runs = [];
  for (const el of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
    let recs, files, window = false, byBuild = false;
    if (el.includes('..')) {
      const [a, b] = el.split('..').map((x) => Date.parse(x));
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return { error: `bad window "${el}" — want <ISO>..<ISO>` };
      recs = records.filter((r) => { const t = Date.parse(r.at); return t >= a && t <= b; });
      files = runFiles.filter((r) => Date.parse(r.from) <= b && Date.parse(r.to) >= a);
      window = true;
    } else {
      byBuild = records.some((r) => r.build === el) || runFiles.some((r) => r.build === el);
      const pick = (r) => (byBuild ? r.build === el : r.session === el);
      recs = records.filter(pick); files = runFiles.filter(pick);
    }
    const groups = new Map();
    for (const r of recs) if (r.session) (groups.get(r.session) ?? groups.set(r.session, []).get(r.session)).push(r);
    for (const f of files) if (!groups.has(f.session)) groups.set(f.session, []);
    const loose = recs.filter((r) => !r.session && Number.isFinite(Date.parse(r.at))).sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
    let cut = [], n = 0;
    const flush = () => { if (cut.length) groups.set(`(run ${++n}${window ? ` of ${el}` : ''})`, cut); cut = []; };
    for (const r of loose) {
      if (!window && cut.length && Date.parse(r.at) - Date.parse(cut.at(-1).at) > RUN_GAP_MS) flush();
      cut.push(r);
    }
    flush();
    for (const [session, list] of groups) {
      // A session's own lines; a sessionless run takes the last sessionless
      // line written before its own last record.
      const endMs = Math.max(...list.map((r) => Date.parse(r.at)).filter(Number.isFinite), -Infinity);
      const named = list.some((r) => r.session === session) || files.some((f) => f.session === session);
      const lines = named ? conditionLines.filter((c) => c.session === session)
        : conditionLines.filter((c) => !c.session && Date.parse(c.at) <= endMs).slice(-1);
      const m = runMetrics(session, list, files.find((f) => f.session === session), phases, lines);
      // A coverage run recorded under the build's id is not one of its timing
      // runs; named by its own session it is kept — and then refused.
      if ((byBuild || window) && m.conditions?.mode === 'coverage') continue;
      if (Object.keys(m.metrics).length || m.fnShares) runs.push(m);
    }
  }
  if (runs.length === 0) {
    const builds = [...new Set([...records.map((r) => r.build), ...runFiles.map((r) => r.build)].filter(Boolean))];
    return { error: `no measured run for "${spec}" — builds on this ledger: ${builds.join(', ') || 'none'} (a session id, <ISO>..<ISO>, or a comma list of them also works)` };
  }
  return { label: spec, runs };
}
