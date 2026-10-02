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
  return { samples: 0, idle: 0, program: 0, gc: 0, fns: new Map(), medians: [], p95s: [], calls: [] };
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
  function addProfile(profile, phase, atMs = Date.now()) {
    if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)) return;
    const b = bucket(phase);
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
    for (const id of profile.samples) {
      const n = byId.get(id);
      const name = n?.callFrame?.functionName;
      if (name === '(idle)') { b.idle++; continue; }
      b.samples++;
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
    out.phases = {};
    for (const [k, b] of phases) {
      const p = { samples: b.samples, idle: b.idle, program: b.program, gc: b.gc };
      if (b.medians.length) {
        p.frame = { windows: b.medians.length, medianMs: median(b.medians) };
        if (b.p95s.length) p.frame.p95Ms = median(b.p95s);
        if (b.calls.length) p.frame.calls = median(b.calls);
      }
      // Heaviest first by inclusive samples; one array per function keeps a
      // long run's file small: [fn, url, line, col, self, total].
      p.fns = [...b.fns.values()].sort((x, y) => y.total - x.total).map((r) => [r.fn, r.url, r.line, r.col, r.self, r.total]);
      out.phases[k] = p;
    }
    return out;
  }

  /** The run's conditions block (conditions.js), replaced whole. */
  function setConditions(c) { conditions = c && typeof c === 'object' ? { ...c } : null; }

  return { addProfile, addFrame, setConditions, toJSON, get empty() { return phases.size === 0; } };
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
  const out = { samples: 0, idle: 0, program: 0, gc: 0, fns: new Map(), frame: undefined };
  let frameFrom = -1;
  const all = (Array.isArray(runs) ? runs : [runs]).flatMap((run) => Object.entries(run?.phases ?? {}));
  for (const [k, p] of all) {
    if (phases && !phases.has(k)) continue;
    out.samples += p.samples ?? 0; out.idle += p.idle ?? 0; out.program += p.program ?? 0; out.gc += p.gc ?? 0;
    if (p.frame && (p.samples ?? 0) > frameFrom) { out.frame = p.frame; frameFrom = p.samples ?? 0; }
    for (const [fn, url, line, col, self, total] of p.fns ?? []) {
      const key = `${url}\t${line}\t${col}\t${fn}`;
      const r = out.fns.get(key) ?? out.fns.set(key, { fn, url, line, col, self: 0, total: 0 }).get(key);
      r.self += self; r.total += total;
    }
  }
  return out;
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
