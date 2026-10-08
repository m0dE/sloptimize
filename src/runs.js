// ============================================================
// runs.js — one attach session's whole profile, kept (tier 0)
// ============================================================
// The hitch path keeps a profiler chunk only when something stalled, and the
// rolling window throws every quiet chunk away. That answers "what was on
// the stack during this freeze" and nothing else. Two questions need every
// sample of the run:
//   · did the benchmark EXECUTE the change under test? A field A/B reported
//     +0.2 ms, no regression, on a city with zero instances of the entity the
//     commit changed — the new code path never ran, and nothing said so.
//     Which functions received samples is exactly what a profiler knows.
//   · did two runs spend their time in the same PLACES? A regression moves
//     the shares; a machine that got slower (the dev build sharing the GPU)
//     scales every share's absolute time and leaves the composition alone.
// So every chunk the pipeline stops — hitch rotation, window roll, the final
// stop — is folded here before it is dropped: per function, samples of self
// time and samples on the stack (inclusive), per page phase, and written to
// `.sloptimize/runs/<session>.json`. The tier-0 profile records (one per 120
// frames, which otherwise only overwrite profile.json) fold into the same
// file, so a run shorter than a heartbeat still has a frame time.
//
// Pure fold + readers: no fs here but in `readRuns`, so a test folds a
// fixture and the CLI reads the files.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NOT_JS = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

function median(vals) {
  if (vals.length === 0) return undefined;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : +((s[mid - 1] + s[mid]) / 2).toFixed(2);
}

function emptyBucket() {
  return { samples: 0, idle: 0, program: 0, gc: 0, fns: new Map(), busyUs: 0, wallUs: 0, threads: new Map(), medians: [], p95s: [], calls: [], seconds: 0, over: null, maxMs: undefined, tally: emptyTally() };
}
/** A worker thread's share of a phase: the same sample fold, no frames. */
function emptyThread() {
  return { samples: 0, idle: 0, program: 0, gc: 0, fns: new Map(), busyUs: 0, wallUs: 0 };
}

// ── Game counters (SPEC §3.11): totals over the game's OWN clock ────────────
// A counter is only a throughput once it is divided by time, and the time
// must be the game's: a build that renders 20% faster covers 20% more of the
// simulated world per wall second, so deliveries per wall second rise with
// no throughput gained — a frame win counted twice. Per FRAME is wrong the
// other way. So a window carries its counter totals (`tally`), the game
// clock's advance if the game supplied one (`clock: {name, seconds}`), and
// its visible wall seconds; rates divide by the clock when there is one and
// by wall time only when there is none, and say which. The clock-normalised
// totals are kept apart from the wall ones: a window without the clock must
// not inflate a clock rate.

/** An empty counter accumulator. */
export function emptyTally() { return { wall: new Map(), wallSec: 0, clock: null }; }

/** Fold one window (`{tally, clock, window:{seconds}}`) — or a folded
 *  phase from a run file (`{tally, wallSec, clock:{name, seconds, tally}}`)
 *  — into an accumulator. A window whose clock went backwards (a new game,
 *  a reload) is dropped whole: its counts have no honest denominator. */
export function foldTally(acc, rec) {
  if (!rec || !rec.tally || typeof rec.tally !== 'object') return acc;
  const add = (m, t) => { for (const [n, v] of Object.entries(t ?? {})) if (typeof v === 'number' && Number.isFinite(v)) m.set(n, (m.get(n) ?? 0) + v); };
  if (rec.clock?.reset) return acc;
  const folded = typeof rec.wallSec === 'number';
  const wallSec = folded ? rec.wallSec : rec.window?.seconds;
  if (typeof wallSec === 'number' && wallSec > 0) { add(acc.wall, rec.tally); acc.wallSec += wallSec; }
  const c = rec.clock;
  if (c && typeof c.name === 'string' && c.name && typeof c.seconds === 'number' && c.seconds >= 0) {
    if (acc.clock && acc.clock.name !== c.name) acc.clock.mixed = true;
    acc.clock ??= { name: c.name, seconds: 0, tally: new Map() };
    if (c.mixed) acc.clock.mixed = true;   // a folded phase that already saw two clocks
    acc.clock.seconds += c.seconds;
    add(acc.clock.tally, folded ? c.tally : rec.tally);
  }
  return acc;
}

/** An accumulator as a run file stores it (null when nothing was counted). */
export function tallyJSON(acc) {
  if (!acc.wall.size && !acc.clock) return null;
  const o = (m) => Object.fromEntries([...m].map(([k, v]) => [k, +v.toFixed(4)]));
  return { tally: o(acc.wall), wallSec: +acc.wallSec.toFixed(3),
    ...(acc.clock ? { clock: { name: acc.clock.name, seconds: +acc.clock.seconds.toFixed(3), tally: o(acc.clock.tally), ...(acc.clock.mixed ? { mixed: true } : {}) } } : {}) };
}

/** Rates per second of the game clock when there is one, else of wall time.
 *  @returns {{denominator:string, per:string, values:Record<string,number>} | null} */
export function ratesOf(acc) {
  if (acc.clock && acc.clock.seconds > 0 && !acc.clock.mixed) {
    return { denominator: `clock:${acc.clock.name}`, per: `${acc.clock.name}-s`, values: Object.fromEntries([...acc.clock.tally].map(([k, v]) => [k, +(v / acc.clock.seconds).toFixed(4)])) };
  }
  if (acc.clock?.mixed) return null;   // two clocks in one reading: no honest denominator
  if (acc.wallSec > 0 && acc.wall.size) return { denominator: 'wall', per: 's', values: Object.fromEntries([...acc.wall].map(([k, v]) => [k, +(v / acc.wallSec).toFixed(4)])) };
  return null;
}

/** A function's hot LINES, heaviest first: `[{line, share}]`, share of the
 *  function's own self ticks, ≥5% each, at most `limit`. Empty when the only
 *  line is the one the function starts on — a minified bundle puts
 *  everything on line 1, and naming it again says nothing. `ticks` is a Map
 *  of 1-based line → ticks; `fnLine` 1-based. */
export function hotLines(ticks, fnLine, limit = 3) {
  let sum = 0;
  for (const v of ticks.values()) sum += v;
  if (!(sum > 0)) return [];
  const rows = [...ticks].sort((a, b) => b[1] - a[1]).filter(([, v]) => v / sum >= 0.05).slice(0, limit)
    .map(([line, v]) => ({ line, share: +(v / sum).toFixed(2) }));
  return rows.length === 1 && rows[0].line === fnLine ? [] : rows;
}

/**
 * The bucket's heaviest functions by SELF time, each with its hot lines —
 * the "which statement inside the top function" a report prints under it.
 * `intervalUs` turns samples into ms.
 * @returns {{fn:string, url:string, line:number, selfMs?:number, share:number, lines:{line:number, share:number}[]}[]}
 */
export function heaviestSelf(bucket, limit = 3, intervalUs) {
  const js = bucket.samples - bucket.program - bucket.gc;
  if (!(js > 0)) return [];
  return [...bucket.fns.values()].filter((r) => r.self > 0).sort((a, b) => b.self - a.self).slice(0, limit).map((r) => ({
    fn: r.fn, url: r.url, line: r.line + 1,
    ...(intervalUs ? { selfMs: +(r.self * intervalUs / 1000).toFixed(1) } : {}),
    share: +(r.self / js).toFixed(3),
    lines: r.lines ? hotLines(r.lines, r.line + 1) : [],
  }));
}

/** Hot lines kept per function, for this many of a phase's heaviest. */
const LINE_FNS = 25, LINE_ROWS = 6;

/** A function table as a run file stores it: heaviest first by inclusive
 *  samples, one array per function — [fn, url, line, col, self, total,
 *  lines?] — `lines` ({line: ticks}, its LINE_ROWS heaviest) only on the
 *  LINE_FNS heaviest by self time: the functions anyone reads lines of. */
function fnsJSON(fns) {
  const withLines = new Set([...fns.values()].filter((r) => r.self > 0 && r.lines?.size).sort((x, y) => y.self - x.self).slice(0, LINE_FNS));
  return [...fns.values()].sort((x, y) => y.total - x.total).map((r) => {
    const a = [r.fn, r.url, r.line, r.col, r.self, r.total];
    if (withLines.has(r)) a.push(Object.fromEntries([...r.lines].sort((x, y) => y[1] - x[1]).slice(0, LINE_ROWS)));
    return a;
  });
}

/**
 * @param {{session:string, build?:string, intervalUs?:number}} meta
 */
export function createRunFold(meta) {
  const phases = new Map();
  let fromMs = Infinity, toMs = -Infinity;
  let conditions = null;
  const bucket = (phase) => {
    const k = typeof phase === 'string' && phase ? phase : '?';
    return phases.get(k) ?? phases.set(k, emptyBucket()).get(k);
  };
  const seen = (t) => { if (Number.isFinite(t)) { if (t < fromMs) fromMs = t; if (t > toMs) toMs = t; } };

  /** One CDP Profiler.stop payload, credited to `phase` (the page's phase
   *  when the chunk ended: a chunk is ≤ the rolling window, so a phase edge
   *  misfiles at most one window's samples). `atMs` is the wall clock when it
   *  was stopped — a profile's own times are the target's monotonic clock. */
  function addProfile(profile, phase, atMs = Date.now(), thread) {
    if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) return;
    // A worker's chunk (SPEC §3.18) folds into its own thread of the phase;
    // the page's into the phase itself.
    const pb = bucket(phase);
    const b = thread ? (pb.threads.get(thread) ?? pb.threads.set(thread, emptyThread()).get(thread)) : pb;
    // Busy against wall: the chunk's span, and the sampled time not idle —
    // what says a thread is saturated, whatever its samples were doing.
    if (typeof profile.endTime === 'number' && typeof profile.startTime === 'number' && profile.endTime > profile.startTime) b.wallUs += profile.endTime - profile.startTime;
    const deltas = profile.timeDeltas ?? [];
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const keyOf = new Map();
    const fnKey = (n) => {
      const f = n.callFrame ?? {};
      if (NOT_JS.has(f.functionName)) return null;
      return `${f.url ?? ''}\t${f.lineNumber ?? 0}\t${f.columnNumber ?? 0}\t${f.functionName || '(anonymous)'}`;
    };
    // The distinct functions on a node's stack, memoised per node: a sample
    // counts once toward every function it was inside (inclusive), however
    // deep the recursion.
    const stackOf = (id) => {
      if (keyOf.has(id)) return keyOf.get(id);
      const keys = new Set();
      for (let at = id; at !== undefined; at = parent.get(at)) {
        const n = byId.get(at);
        if (!n) break;
        const k = fnKey(n);
        if (k) keys.add(k);
      }
      const arr = [...keys];
      keyOf.set(id, arr);
      return arr;
    };
    const row = (k) => {
      let r = b.fns.get(k);
      if (!r) { const [url, line, col, fn] = k.split('\t'); r = { fn, url, line: +line, col: +col, self: 0, total: 0 }; b.fns.set(k, r); }
      return r;
    };
    // V8's per-line ticks of each leaf node (1-based lines, one entry per
    // code version — they sum): which statement inside a function its self
    // time went to.
    for (const n of profile.nodes) {
      if (!n.positionTicks?.length) continue;
      const k = fnKey(n);
      if (!k) continue;
      const r = row(k);
      r.lines ??= new Map();
      for (const t of n.positionTicks) if (Number.isFinite(t?.line) && t.ticks > 0) r.lines.set(t.line, (r.lines.get(t.line) ?? 0) + t.ticks);
    }
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      const n = byId.get(id);
      const name = n?.callFrame?.functionName;
      if (name === '(idle)') { b.idle++; continue; }
      b.samples++;
      b.busyUs += deltas[i] ?? 0;
      if (name === '(program)') { b.program++; continue; }
      if (name === '(garbage collector)') { b.gc++; continue; }
      const stack = stackOf(id);
      if (stack.length) row(stack[0]).self++;
      for (const k of stack) row(k).total++;
    }
    seen(atMs);
  }

  /** A tier-0 `profile` record: one 120-frame window's median/p95/calls. */
  function addFrame(rec) {
    const b = bucket(rec.phase);
    if (typeof rec.frame?.medianMs === 'number') b.medians.push(rec.frame.medianMs);
    if (typeof rec.frame?.p95Ms === 'number') b.p95s.push(rec.frame.p95Ms);
    if (typeof rec.render?.calls === 'number') b.calls.push(rec.render.calls);
    if (typeof rec.frame?.maxMs === 'number' && !(b.maxMs >= rec.frame.maxMs)) b.maxMs = rec.frame.maxMs;
    foldTally(b.tally, rec);
    // Frames over fixed bars and the visible seconds they were counted in —
    // summed, so a gate can read frames over 100 ms per minute of the phase.
    if (rec.over && typeof rec.window?.seconds === 'number') {
      b.seconds += rec.window.seconds;
      b.over ??= {};
      for (const [bar, n] of Object.entries(rec.over)) if (typeof n === 'number') b.over[bar] = (b.over[bar] ?? 0) + n;
    }
    seen(Date.parse(rec.at));
  }

  function toJSON() {
    const out = { type: 'run', v: 1, session: meta.session };
    if (meta.build) out.build = meta.build;
    if (meta.intervalUs) out.intervalUs = meta.intervalUs;
    if (Number.isFinite(fromMs)) { out.from = new Date(fromMs).toISOString(); out.to = new Date(toMs).toISOString(); }
    // What the run was measured under (conditions.js); `phases` is what it
    // actually carried, read off the buckets at write time.
    if (conditions) {
      const ph = [...phases.keys()].filter((k) => k !== '?').sort();
      out.conditions = { ...conditions, ...(ph.length ? { phases: ph } : {}) };
    }
    if (recorder) out.recorder = recorder;
    out.phases = {};
    for (const [k, b] of phases) {
      const p = { samples: b.samples, idle: b.idle, program: b.program, gc: b.gc };
      if (b.medians.length) {
        p.frame = { windows: b.medians.length, medianMs: median(b.medians) };
        if (b.p95s.length) p.frame.p95Ms = median(b.p95s);
        if (b.calls.length) p.frame.calls = median(b.calls);
      }
      if (b.over) { p.seconds = +b.seconds.toFixed(3); p.over = b.over; }
      if (b.maxMs !== undefined) p.maxMs = b.maxMs;   // the phase's longest frame, every window counted
      const t = tallyJSON(b.tally);
      if (t) p.counters = t;
      // Heaviest first by inclusive samples; one array per function keeps a
      // long run's file small: [fn, url, line, col, self, total, lines?] —
      // `lines` ({line: ticks}, its LINE_ROWS heaviest) only on the
      // LINE_FNS heaviest by self time: the functions anyone reads lines of.
      p.fns = fnsJSON(b.fns);
      if (b.wallUs > 0) { p.busyMs = +(b.busyUs / 1000).toFixed(1); p.wallMs = +(b.wallUs / 1000).toFixed(1); }
      // Worker threads (SPEC §3.18), each folded like the page.
      if (b.threads.size) {
        p.threads = {};
        for (const [name, t] of b.threads) {
          p.threads[name] = { samples: t.samples, idle: t.idle, program: t.program, gc: t.gc, busyMs: +(t.busyUs / 1000).toFixed(1), wallMs: +(t.wallUs / 1000).toFixed(1), fns: fnsJSON(t.fns) };
        }
      }
      out.phases[k] = p;
    }
    return out;
  }

  /** The run's conditions block (conditions.js), replaced whole. */
  function setConditions(c) { conditions = c && typeof c === 'object' ? { ...c } : null; }
  /** What the recorder itself cost the page: its profiler restarts. */
  let recorder = null;
  function setRecorder(r) { recorder = r && typeof r === 'object' ? { ...r } : null; }

  return { addProfile, addFrame, setConditions, setRecorder, toJSON, get empty() { return phases.size === 0; } };
}

/** Every run file under `<dir>/runs/`, oldest first; unreadable files skipped. */
export function readRuns(dir) {
  const d = join(dir, 'runs');
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    try { const r = JSON.parse(readFileSync(join(d, f), 'utf8')); if (r?.type === 'run') out.push(r); } catch { /* half-written */ }
  }
  return out.sort((a, b) => Date.parse(a.from ?? 0) - Date.parse(b.from ?? 0));
}

/**
 * A run's buckets (or several runs', summed) for `phases` (a Set; null =
 * all) folded into one: summed sample counts and a function table keyed by
 * position, plus the frame figures of the heaviest-sampled phase kept
 * (medians do not sum).
 */
export function runBucket(runs, phases = null) {
  const out = { samples: 0, idle: 0, program: 0, gc: 0, fns: new Map(), busyMs: 0, wallMs: 0, threads: new Map(), frame: undefined, tally: emptyTally() };
  let frameFrom = -1;
  const all = (Array.isArray(runs) ? runs : [runs]).flatMap((run) => Object.entries(run?.phases ?? {}));
  for (const [k, p] of all) {
    if (phases && !phases.has(k)) continue;
    out.samples += p.samples ?? 0; out.idle += p.idle ?? 0; out.program += p.program ?? 0; out.gc += p.gc ?? 0;
    if (p.frame && (p.samples ?? 0) > frameFrom) { out.frame = p.frame; frameFrom = p.samples ?? 0; }
    if (p.counters) foldTally(out.tally, p.counters);
    foldFns(out.fns, p.fns);
    out.busyMs += p.busyMs ?? 0; out.wallMs += p.wallMs ?? 0;
    for (const [name, t] of Object.entries(p.threads ?? {})) {
      const o = out.threads.get(name) ?? out.threads.set(name, { samples: 0, idle: 0, program: 0, gc: 0, busyMs: 0, wallMs: 0, fns: new Map() }).get(name);
      for (const k of ['samples', 'idle', 'program', 'gc', 'busyMs', 'wallMs']) o[k] += t[k] ?? 0;
      foldFns(o.fns, t.fns);
    }
  }
  return out;
}

function foldFns(into, rows) {
  for (const [fn, url, line, col, self, total, lines] of rows ?? []) {
    const key = `${url}\t${line}\t${col}\t${fn}`;
    const r = into.get(key) ?? into.set(key, { fn, url, line, col, self: 0, total: 0 }).get(key);
    r.self += self; r.total += total;
    if (lines && typeof lines === 'object') {
      r.lines ??= new Map();
      for (const [l, t] of Object.entries(lines)) if (typeof t === 'number') r.lines.set(+l, (r.lines.get(+l) ?? 0) + t);
    }
  }
}

// ── "did the run touch the change?" ─────────────────────────────────────────

/** A file a JS sampler can see run (an .html counts: its inline scripts
 *  sample under the page URL). A shader, a JSON table, a stylesheet
 *  changes what runs without ever being on a JS stack. */
export const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|vue|svelte|coffee|html?)$/i;

/** A path or URL reduced to comparable form: no scheme/host, query, hash,
 *  `webpack://pkg/`, `/@fs`, or leading `./` `../` `/`. */
export function normPath(p) {
  let s = String(p ?? '').trim();
  s = s.replace(/^webpack:\/\/[^/]*\//, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(/\\/g, '/').replace(/^\/@fs\//, '/').replace(/^(\.{1,2}\/)+/, '').replace(/^\/+/, '');
  return s;
}

/** Does source path `src` (normalised) name the changed file `c` (normalised)?
 *  Equal, or one is a path-suffix of the other — a dev server serves
 *  `/src/a.ts` for a repo's `packages/client/src/a.ts`, a map names
 *  `../../src/a.ts`. A bare file name alone is never a suffix match: every
 *  package has an `index.js`. */
export function samePath(src, c) {
  if (!src || !c) return false;
  if (src === c) return true;
  // A dependency's copy of a same-named file is not the change: three's
  // node_modules/three/src/core/Object3D.js ends with src/core/Object3D.js.
  const dep = /(^|\/)(node_modules|\.vite\/deps)\//;
  if (dep.test(src) !== dep.test(c)) return false;
  if (src.includes('/') && c.endsWith(`/${src}`)) return true;
  return c.includes('/') && src.endsWith(`/${c}`);
}

/**
 * For each changed file: did any sample land in it? `bucket` is a runBucket;
 * `maps` is `[{ file, sm }]` — a generated script's base name and its loaded
 * source map (node/sourcemap.js): a function in that script is credited to
 * the source its first position maps to.
 *
 * Per file: `self` (samples whose leaf was a function of the file — exact)
 * and `heaviest` (the most inclusive samples any single function of the file
 * had — a LOWER bound on time spent under the file: inclusive counts of two
 * functions overlap when one calls the other, so they do not sum).
 */
export function touchedFiles(bucket, changed, { maps = [] } = {}) {
  const js = bucket.samples - bucket.program - bucket.gc;   // idle is never in `samples`
  const byMap = new Map(maps.map((m) => [m.file, m.sm]));
  const sources = [];
  let mapped = 0;
  for (const r of bucket.fns.values()) {
    const base = normPath(r.url).split('/').pop();
    const sm = byMap.get(base);
    let src = normPath(r.url);
    if (sm) {
      const o = sm.original(r.line + 1, r.col);
      if (o?.file) { src = normPath(o.file); mapped++; }
    }
    sources.push({ src, r });
  }
  const files = changed.map((file) => {
    const c = normPath(file);
    if (!CODE_FILE.test(c)) return { file, code: false };
    let self = 0, heaviest = 0, top = null;
    for (const { src, r } of sources) {
      if (!samePath(src, c)) continue;
      self += r.self;
      if (r.total > heaviest) { heaviest = r.total; top = r.fn; }
    }
    return { file, code: true, hit: heaviest > 0, self, heaviest, ...(top ? { top } : {}), share: js > 0 ? +(heaviest / js).toFixed(4) : 0 };
  });
  // Zero samples is not proof of zero execution: at the sampling interval a
  // path that costs little can be missed. With n JS samples and none in the
  // file, its share of JS time is under 3/n at 95% (the rule of three).
  return { jsSamples: js, mapped, files, bound: js > 0 ? +(3 / js).toFixed(5) : undefined };
}
