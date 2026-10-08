// ============================================================
// gate.js — budgets judged over a whole RUN, per phase (SPEC §7.1)
// ============================================================
// `check` began as one snapshot against global ceilings: profile.json, the
// last 120 frames of whatever phase happened to be running. Both of one
// field week's real findings were PHASE ceilings — a load-phase worst frame
// (a shader stall) and a steady-state regression — and a snapshot of the
// steady state cannot see the first, while a global p95 dilutes the second.
// So a budget may name its phase, `perf.budget.<phase>.<metric>` (`*`: every
// phase the run carried), and is judged over every record of the run in
// that phase.
//
// Hitch budgets are the trap. Detection is RELATIVE — a frame is a hitch at
// twice the rolling median — so a build that is uniformly 20% slower lifts
// its own bar, clears it less often and reports FEWER hitches: a hitch-rate
// budget goes green while the game gets worse everywhere (the same inversion
// as a load slow from its first frame producing zero hitches). The gate
// therefore counts frames over FIXED bars (`frames_over_<N>ms_per_min`,
// counted in the page per window) and allows the relative `hitches_per_h`
// only beside a median or p95 budget for the same phase, which catches the
// uniform slowdown the relative count hides.
//
// A build is several runs; each metric is read per run and the build's
// value is the median, with the range said. Too few runs is its own answer,
// never a pass.
//
// Pure: the CLI hands records and run files in.

import { emptyTally, foldTally, ratesOf } from './runs.js';
import { CONDITION_FIELDS } from './conditions.js';
import { UNIFORM_RATIO } from './compare.js';
import { phaseSpans, spanTable, oneOf } from './spans.js';

const median = (v) => {
  if (!v.length) return undefined;
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (x) => (x === undefined ? undefined : +x.toFixed(2));

/** The fixed bars the tier-0 page counts frames over (inject-body.js). */
export const OVER_BARS = [50, 100, 200, 500, 1000];

/** Legacy global keys → the per-phase metric they name. */
const LEGACY = { draw_calls: 'draw_calls', triangles: 'triangles', frame_ms_p95: 'p95_ms', programs: 'programs' };

const METRICS = {
  median_ms: 'median frame (ms)', p95_ms: 'p95 frame (ms)', worst_ms: 'worst frame (ms)',
  draw_calls: 'draw calls', triangles: 'triangles', programs: 'programs',
  hitches_per_h: 'hitches/h (relative: 2× rolling median)',
  phase_ms: 'the phase\'s duration (ms, its span — SPEC §3.15)',
};

/**
 * budgets.json → budget rows. `perf.budget.<metric>` (global, the legacy
 * shape) or `perf.budget.<phase>.<metric>`; a number is a ceiling, `{max}` /
 * `{min}` says so explicitly (`{min}` for a rate: more is better).
 * Section budgets: `perf.budget.<phase>.section.<name>` (the host's own loop
 * sections, ms per frame). Rates: `perf.budget.<phase>.rate.<name>`.
 * Cost per unit of work: `perf.budget.<phase>.ms_per.<unit>` — the phase's
 * ms over the size the page declared (`__sloptimizeScale('roads', n)`; the
 * unit singular or as declared), the one budget that holds across inputs.
 * @returns {{rows:object[], errors:string[]}}
 */
export function parseBudgets(budgets = {}) {
  const rows = [], errors = [];
  for (const [key, raw] of Object.entries(budgets ?? {})) {
    if (key === 'perf.conditions') {
      // What the budgets were set for: an object of known condition keys. A
      // typo here would otherwise refuse every run as "other conditions".
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push(`perf.conditions: an object of conditions, e.g. { "refreshHz": 60, "regime": "hardware" }`);
      else for (const k of Object.keys(raw)) if (!CONDITION_FIELDS.some((f) => f.key === k)) errors.push(`perf.conditions.${k}: not a condition — ${CONDITION_FIELDS.map((f) => f.key).join(', ')}`);
      continue;
    }
    // A typo must not read as "no budget": a perf.* key this file does not
    // know is an error, not a skip (other tools' keys pass through).
    if (!key.startsWith('perf.budget.')) { if (key.startsWith('perf.')) errors.push(`${key}: unknown key — budgets are perf.budget.*, conditions perf.conditions`); continue; }
    const lim = typeof raw === 'number' ? { max: raw } : raw && typeof raw === 'object' && (typeof raw.max === 'number' || typeof raw.min === 'number') ? { ...(typeof raw.max === 'number' ? { max: raw.max } : {}), ...(typeof raw.min === 'number' ? { min: raw.min } : {}) } : null;
    if (!lim) { errors.push(`${key}: a budget is a number (a ceiling) or {max}/{min}`); continue; }
    const rest = key.slice('perf.budget.'.length);
    if (Object.hasOwn(LEGACY, rest)) { rows.push({ key, phase: null, metric: LEGACY[rest], ...lim }); continue; }
    const dot = rest.indexOf('.');
    if (dot < 0) { errors.push(`${key}: unknown budget — global keys are ${Object.keys(LEGACY).map((k) => `perf.budget.${k}`).join(', ')}; per phase, perf.budget.<phase>.<metric>`); continue; }
    const phase = rest.slice(0, dot), metric = rest.slice(dot + 1);
    if (metric.startsWith('ms_per.')) {
      const name = metric.slice('ms_per.'.length);
      if (!name) { errors.push(`${key}: name the unit — perf.budget.<phase>.ms_per.<unit>, the unit the page declared with __sloptimizeScale`); continue; }
      rows.push({ key, phase, metric: 'ms_per', name, ...lim });
      continue;
    }
    if (metric.startsWith('section.') || metric.startsWith('rate.')) {
      const kind = metric.startsWith('section.') ? 'section' : 'rate';
      const name = metric.slice(kind.length + 1);
      if (!name) { errors.push(`${key}: name the ${kind}`); continue; }
      if (kind === 'rate' && typeof raw === 'number') { errors.push(`${key}: a rate budget says its direction — {"min": n} (more is better) or {"max": n}`); continue; }
      rows.push({ key, phase, metric: kind, name, ...lim });
      continue;
    }
    const over = /^frames_over_(\d+)ms_per_min$/.exec(metric);
    if (over) {
      if (!OVER_BARS.includes(+over[1])) { errors.push(`${key}: frames are counted over ${OVER_BARS.join(', ')} ms — pick one of those bars`); continue; }
      rows.push({ key, phase, metric: 'frames_over', bar: +over[1], ...lim });
      continue;
    }
    if (!Object.hasOwn(METRICS, metric)) { errors.push(`${key}: unknown metric "${metric}" — ${[...Object.keys(METRICS), 'frames_over_<N>ms_per_min', 'section.<name>', 'rate.<name>', 'ms_per.<unit>'].join(', ')}`); continue; }
    rows.push({ key, phase, metric, ...lim });
  }
  // The relative hitch count inverts under a uniform slowdown: only beside a
  // median/p95 ceiling for the same phase (or `*`), which catches that case.
  for (const r of rows.filter((x) => x.metric === 'hitches_per_h')) {
    const guarded = rows.some((x) => (x.metric === 'p95_ms' || x.metric === 'median_ms') && (x.phase === r.phase || x.phase === '*' || x.phase === null));
    if (!guarded) errors.push(`${r.key}: hitches are detected RELATIVE to the rolling median, so a uniformly slower build reports fewer of them and this budget would pass while the game got worse — add a p95_ms or median_ms budget for phase ${r.phase}, or budget frames_over_<N>ms_per_min (fixed bars) instead`);
  }
  return { rows, errors };
}

/**
 * One run's numbers, per phase: what its ledger lines (records of that run)
 * and its run file say. Phase `?` holds records with none.
 * @returns {Map<string, object>}
 */
export function runPhaseMetrics(records = [], run = null) {
  const ph = new Map();
  const at = (k) => {
    const key = typeof k === 'string' && k ? k : '?';
    return ph.get(key) ?? ph.set(key, { medians: [], p95s: [], calls: [], tris: [], programs: [], hitches: 0, worst: undefined, hitchMs: [], windowMax: undefined, hb: { medians: [], p95s: [], calls: [] }, seconds: 0, over: null, sections: new Map(), tally: emptyTally(), times: [] }).get(key);
  };
  const addOver = (b, over, seconds) => {
    if (!over || !(seconds > 0)) return;
    b.seconds += seconds;
    b.over ??= {};
    for (const [bar, n] of Object.entries(over)) if (typeof n === 'number') b.over[bar] = (b.over[bar] ?? 0) + n;
  };
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const b = at(r.phase);
    const t = Date.parse(r.at);
    if (Number.isFinite(t)) b.times.push(t);
    if (r.type === 'hitch' && typeof r.frameMs === 'number') {
      b.hitches++;
      b.hitchMs.push(r.frameMs);
      if (b.worst === undefined || r.frameMs > b.worst) b.worst = r.frameMs;
    } else if (r.type === 'heartbeat') {
      // Held apart: a heartbeat's frame figures are a rolling ring, and a run
      // file's (every window of the phase) win where both exist — as compare reads them.
      if (typeof r.medianFrameMs === 'number') b.hb.medians.push(r.medianFrameMs);
      if (typeof r.p95Ms === 'number') b.hb.p95s.push(r.p95Ms);
      if (typeof r.calls === 'number') b.hb.calls.push(r.calls);
      if (typeof r.triangles === 'number') b.tris.push(r.triangles);
      if (typeof r.programs === 'number') b.programs.push(r.programs);
    } else if (r.type === 'profile') {
      // Tier-1 profile lines (the host's own frame); a tier-0 run's windows
      // arrive through its run file instead, so they are not counted twice.
      if (run && r.tier === 0) continue;
      if (typeof r.frame?.medianMs === 'number') b.medians.push(r.frame.medianMs);
      if (typeof r.frame?.p95Ms === 'number') b.p95s.push(r.frame.p95Ms);
      if (typeof r.render?.calls === 'number') b.calls.push(r.render.calls);
      if (typeof r.frame?.maxMs === 'number' && !(b.windowMax >= r.frame.maxMs)) b.windowMax = r.frame.maxMs;
      for (const [k, v] of Object.entries(r.sections ?? {})) if (typeof v === 'number') (b.sections.get(k) ?? b.sections.set(k, []).get(k)).push(v);
      addOver(b, r.over, r.window?.seconds);
      foldTally(b.tally, r);
    }
  }
  // The run file: every 120-frame window of the run, folded (runs.js).
  for (const [k, p] of Object.entries(run?.phases ?? {})) {
    const b = at(k);
    if (p.frame) {
      // Medians of window medians — one value standing for its windows.
      if (typeof p.frame.medianMs === 'number') b.medians.push(p.frame.medianMs);
      if (typeof p.frame.p95Ms === 'number') b.p95s.push(p.frame.p95Ms);
      if (typeof p.frame.calls === 'number') b.calls.push(p.frame.calls);
    }
    if (p.over && p.seconds > 0) addOver(b, p.over, p.seconds);
    if (typeof p.maxMs === 'number' && !(b.windowMax >= p.maxMs)) b.windowMax = p.maxMs;
    if (p.counters) foldTally(b.tally, p.counters);
  }
  // Phases as spans: the duration and the cost per declared unit (spans.js).
  const spans = spanTable(phaseSpans(records));
  const out = new Map();
  for (const [k, b] of ph) {
    if (!b.medians.length) b.medians.push(...b.hb.medians);
    if (!b.p95s.length) b.p95s.push(...b.hb.p95s);
    if (!b.calls.length) b.calls.push(...b.hb.calls);
    const m = {};
    if (b.medians.length) m.median_ms = r2(median(b.medians));
    if (b.p95s.length) m.p95_ms = r2(median(b.p95s));
    if (b.calls.length) m.draw_calls = Math.round(median(b.calls));
    if (b.tris.length) m.triangles = Math.round(median(b.tris));
    if (b.programs.length) m.programs = Math.max(...b.programs);
    m.hitches = b.hitches;
    if (b.over) { m.over = b.over; m.seconds = r2(b.seconds); }
    // The worst frame, as an INTERVAL. Detection is relative, so a frame can
    // pass a fixed bar without becoming a hitch record: the longest hitch is
    // the worst frame only when every frame over the highest bar passed was
    // recorded. Otherwise the worst lies between that bar (or the longest
    // hitch, if higher) and the next bar up — and a budget inside that
    // interval cannot be judged either way.
    if (b.windowMax !== undefined) {
      // Every window's longest frame was recorded: the worst is exact (a
      // hitch credited to this phase from a window credited elsewhere still counts).
      const w = r2(Math.max(b.windowMax, b.worst ?? 0));
      m.worst = { lo: w, hi: w };
    } else if (b.over) {
      const bars = Object.keys(b.over).map(Number).sort((x, y) => x - y);
      const passed = bars.filter((x) => b.over[x] > 0).at(-1);
      const next = passed === undefined ? bars[0] : bars.find((x) => x > passed) ?? Infinity;
      const recordedOver = passed === undefined ? 0 : b.hitchMs.filter((ms) => ms > passed).length;
      if (passed !== undefined && b.worst !== undefined && recordedOver >= b.over[passed]) m.worst = { lo: r2(b.worst), hi: r2(b.worst) };
      else m.worst = { lo: r2(Math.max(passed ?? 0, b.worst ?? 0)), hi: next };
    } else if (b.worst !== undefined) m.worst = { lo: r2(b.worst), hi: r2(b.worst) };   // a host's own hitches, no bars to bound them
    if (m.worst?.lo === m.worst?.hi && m.worst) m.worst_ms = m.worst.lo;
    // Hours of the phase: the visible seconds the page counted, else the
    // span of its records (a beat-less, window-less run has no clock at all).
    const span = b.times.length > 1 ? (Math.max(...b.times) - Math.min(...b.times)) / 1000 : 0;
    const secs = b.seconds > 0 ? b.seconds : span;
    if (secs > 0) { m.phaseSeconds = r2(secs); m.hitches_per_h = r2(b.hitches / (secs / 3600)); }
    if (b.sections.size) m.sections = Object.fromEntries([...b.sections].map(([n, v]) => [n, r2(median(v))]));
    const rates = ratesOf(b.tally);
    if (rates) m.rates = rates;
    const sp = spans.get(k);
    if (sp?.ms !== undefined) m.phase_ms = sp.ms;
    if (sp && Object.keys(sp.perUnit).length) m.perUnit = sp.perUnit;
    out.set(k, m);
  }
  return out;
}

/** The value one budget row reads from one phase's metrics. */
function readRow(row, m) {
  if (!m) return undefined;
  if (row.metric === 'frames_over') {
    if (!m.over || !(m.seconds > 0) || m.over[row.bar] === undefined) return undefined;
    return r2(m.over[row.bar] / (m.seconds / 60));
  }
  if (row.metric === 'worst_ms') return m.worst;   // {lo, hi} — judged as an interval
  if (row.metric === 'section') return m.sections?.[row.name];
  if (row.metric === 'rate') return m.rates?.values[row.name];
  if (row.metric === 'ms_per') {
    const u = Object.keys(m.perUnit ?? {}).find((x) => x === row.name || oneOf(x) === row.name || oneOf(x) === oneOf(row.name));
    return u === undefined ? undefined : m.perUnit[u];
  }
  return m[row.metric];
}

/** A worst-frame budget over each run's interval: a breach needs the LOWER
 *  bound over the ceiling, a pass needs the UPPER bound under it; between,
 *  it is unmeasured and says the interval. A build's bounds are the medians
 *  of its runs'. */
function judgeWorst(row, phase, runs, phases, real) {
  const ivs = runs.map((r) => (phase === null ? undefined : r.get(phase)?.worst)).filter(Boolean);
  const res = { budget: row.phase === '*' ? row.key.replace('.*.', `.${phase}.`) : row.key, phase, metric: row.metric, ...(row.max !== undefined ? { max: row.max } : {}), ...(row.min !== undefined ? { min: row.min } : {}) };
  if (!ivs.length) {
    res.value = null;
    res.verdict = phase !== null && !phases.has(phase) ? `unmeasured — no record in phase ${phase} (phases: ${real.join(', ') || 'none'})` : 'unmeasured';
    return res;
  }
  const lo = r2(median(ivs.map((x) => x.lo))), hi = median(ivs.map((x) => x.hi));
  res.n = ivs.length;
  if (ivs.length > 1) res.runs = { n: ivs.length, lo: r2(Math.min(...ivs.map((x) => x.lo))), hi: r2(Math.max(...ivs.map((x) => x.lo))) };
  res.value = lo;
  if (hi !== lo) {
    res.upTo = Number.isFinite(hi) ? hi : null;
    res.note = lo === 0 ? `every frame under ${hi} ms (no fixed bar passed)`
      : `between ${lo} and ${Number.isFinite(hi) ? hi : '∞'} ms: a frame passed a fixed bar without being recorded as a hitch`;
  }
  const max = row.max ?? Infinity;
  if (lo > max) { res.verdict = `over by ${(lo / max).toFixed(1)}x`; res.breached = true; }
  else if (hi <= max) res.verdict = 'inside';
  else { res.verdict = `cannot tell: the worst frame is between ${lo} and ${Number.isFinite(hi) ? hi : '∞'} ms`; res.value = null; res.bounds = { lo, hi: Number.isFinite(hi) ? hi : null }; }
  return res;
}

/** Every phase's metrics pooled: the legacy global keys, in run mode. */
function pooled(perRun) {
  const all = { medians: [], p95s: [], calls: [], tris: [], programs: [] };
  for (const m of perRun.values()) {
    if (m.median_ms !== undefined) all.medians.push(m.median_ms);
    if (m.p95_ms !== undefined) all.p95s.push(m.p95_ms);
    if (m.draw_calls !== undefined) all.calls.push(m.draw_calls);
    if (m.triangles !== undefined) all.tris.push(m.triangles);
    if (m.programs !== undefined) all.programs.push(m.programs);
  }
  const m = {};
  if (all.p95s.length) m.p95_ms = Math.max(...all.p95s);
  if (all.medians.length) m.median_ms = Math.max(...all.medians);
  if (all.calls.length) m.draw_calls = Math.max(...all.calls);
  if (all.tris.length) m.triangles = Math.max(...all.tris);
  if (all.programs.length) m.programs = Math.max(...all.programs);
  return m;
}

/**
 * Budget rows against runs (each a Map from runPhaseMetrics). A phase row
 * reads that phase of every run; `*` expands to every phase any run carried;
 * a global (legacy) row reads the worst phase of each run. A build's value
 * is the median of its runs', with their range.
 * @returns {{results:object[], breached:number, unmeasured:number}}
 */
export function judgeBudgets(rows, runs) {
  const phases = new Set();
  for (const r of runs) for (const k of r.keys()) phases.add(k);
  const real = [...phases].filter((p) => p !== '?');
  const results = [];
  for (const row of rows) {
    const targets = row.phase === null ? [null] : row.phase === '*' ? (real.length ? real : ['?']) : [row.phase];
    for (const phase of targets) {
      if (row.metric === 'worst_ms') { results.push(judgeWorst(row, phase, runs, phases, real)); continue; }
      const vals = runs.map((r) => readRow(row, phase === null ? pooled(r) : r.get(phase))).filter((v) => v !== undefined);
      const label = row.phase === '*' ? row.key.replace('.*.', `.${phase}.`) : row.key;
      const res = { budget: label, phase, metric: row.metric, ...(row.max !== undefined ? { max: row.max } : {}), ...(row.min !== undefined ? { min: row.min } : {}) };
      if (row.metric === 'hitches_per_h') res.rule = 'relative (frame > 2× rolling median)';
      if (row.metric === 'frames_over') res.rule = `absolute (frame > ${row.bar} ms)`;
      if (row.metric === 'ms_per') res.rule = `the phase's ms per ${oneOf(row.name)} the page declared`;
      if (row.metric === 'rate') {
        const r = runs.map((x) => (phase === null ? undefined : x.get(phase)?.rates)).find(Boolean);
        if (r) res.rule = `per ${r.per} (${r.denominator === 'wall' ? 'wall time — no game clock' : `the game's ${r.denominator.slice(6)} clock`})`;
      }
      if (!vals.length) {
        res.value = null;
        res.verdict = phase !== null && !phases.has(phase) ? `unmeasured — no record in phase ${phase} (phases: ${real.join(', ') || 'none'})` : 'unmeasured';
        results.push(res); continue;
      }
      // A cost per unit is often well under 0.01 ms: rounded to 2 decimals it
      // reads 0 and passes any ceiling. Significant figures for it instead.
      const v = row.metric === 'ms_per' ? +median(vals).toPrecision(4) : r2(median(vals));
      res.value = v;
      res.n = vals.length;   // the runs that measured it — a build's other runs may not have had the phase
      const rr = row.metric === 'ms_per' ? (x) => +x.toPrecision(4) : r2;
      if (vals.length > 1) res.runs = { n: vals.length, lo: rr(Math.min(...vals)), hi: rr(Math.max(...vals)) };
      const over = row.max !== undefined && v > row.max, under = row.min !== undefined && v < row.min;
      res.verdict = over ? `over by ${(row.max > 0 ? v / row.max : Infinity).toFixed(1)}x` : under ? `under by ${(v > 0 ? row.min / v : Infinity).toFixed(1)}x` : 'inside';
      res.breached = over || under;
      results.push(res);
    }
  }
  return { results, breached: results.filter((r) => r.breached).length, unmeasured: results.filter((r) => r.value === null).length };
}

/**
 * Which direction is worse for a compare row's metric — `+1` a rise is a
 * regression, `-1` a fall is, `0` not directional (a function's share of JS
 * time; a host's per-frame `counts`). A RATE (SPEC §3.11) is a throughput,
 * so a fall is the regression by default; `rateDir` maps a rate name to
 * 'min' | 'max' from budgets, and a `{max}` rate is one where less is better.
 */
export function worseDirection(metric, rateDir = {}) {
  if (metric.startsWith('fn ')) return 0;
  const rate = /^rate (.+?) \//.exec(metric);
  if (rate) return rateDir[rate[1]] === 'max' ? 1 : -1;
  if (/ ms$/.test(metric) || / ms\/\S+$/.test(metric) || metric === 'draw calls' || metric === 'triangles' || metric === 'hitches/h' || /^frames over /.test(metric)) return 1;
  return 0;
}

/**
 * The gate over a compare: rows that moved significantly the WORSE way.
 * Insufficient runs is checked first and is its own answer.
 * @returns {{verdict:'pass'|'regressed'|'insufficient', regressions:object[], why?:string}}
 */
export function regressionGate(cmp, { minRuns = 3, rateDir = {} } = {}) {
  const na = cmp.a.runs.length, nb = cmp.b.runs.length;
  if (na < minRuns || nb < minRuns) {
    return { verdict: 'insufficient', regressions: [], why: `${na} run(s) on A, ${nb} on B — the gate needs ${minRuns} a side (--min-runs): a noise floor from fewer runs is a guess, and a gate that passes because it could not measure is no gate` };
  }
  // Per metric too: a run that did not measure a metric is not a run of it.
  const thin = cmp.rows.filter((r) => worseDirection(r.metric, rateDir) !== 0 && Math.min(r.a.n, r.b.n) < minRuns);
  if (thin.length) {
    return { verdict: 'insufficient', regressions: [], why: `${thin.map((r) => `${r.metric} (${r.a.n}/${r.b.n} runs)`).join(', ')} measured by fewer than ${minRuns} runs a side (--min-runs)` };
  }
  const regressions = cmp.rows.filter((r) => r.verdict === 'significant' && worseDirection(r.metric, rateDir) * Math.sign(r.delta) > 0);
  if (!regressions.length) return { verdict: 'pass', regressions };
  // A uniform SLOWDOWN with unchanged composition is the machine: its timing
  // regressions are not the code's. What timing cannot explain — draw calls,
  // triangles, a rate — still regressed. A speedup is never this.
  if (cmp.hostSuspect && cmp.hostSuspect.ratio > 1) {
    // Kept: what timing cannot explain, and any timing row that moved well
    // beyond the uniform scale (a p95 that doubled inside a 12% slowdown).
    const beyond = (r) => r.a.median > 0 && r.b.median / r.a.median > cmp.hostSuspect.ratio * UNIFORM_RATIO;
    const kept = regressions.filter((r) => /^(draw calls|triangles|rate )/.test(r.metric) || beyond(r));
    return kept.length ? { verdict: 'regressed', regressions: kept, note: 'timing moved uniformly (the machine?); these did not' }
      : { verdict: 'machine', regressions, why: 'a uniform slowdown with unchanged composition — the machine changed, not the code; re-measure on a quiet machine' };
  }
  return { verdict: 'regressed', regressions };
}
