// ============================================================
// ticks.js — behavioural equivalence: the first tick two builds disagree (SPEC §3.16)
// ============================================================
// Two of a many-agent game's biggest optimisations — staggering half of the
// per-agent update, moving the sim into a Worker — both rest on "the
// simulation is identical", and a team's own plan said in writing there was
// no way to check that claim (an earlier refactor had already shipped on an
// unverified one). A profiler cannot make a game deterministic: seeding is
// the game's. But once the game can digest its state per tick, comparing two
// builds is run orchestration, and a tick number is a far better bug report
// than "the traffic feels off".
//
// The game pushes, per tick (the tool cannot poll a sim mid-step):
//   __sloptimizeTick(tick, digest, values?)
//     digest  a hash of sim state — a string or number, or NAMED parts
//             ({agents, signals, rng}) so a divergence says which part;
//     values  summary numbers ({delivered, meanSpeed}) for TOLERANT mode.
//   __sloptimizeSim({seed, tickHz, save})   what the run simulated.
// Two modes, because two kinds of change:
//   · exact — a refactor or a move into a Worker must not change one bit:
//     "identical through 5000 ticks" or "first divergence at tick 1841".
//   · tolerant — a stagger, a LOD sim, a reordered float sum changes state
//     ON PURPOSE; exact would report tick 1. Its windowed means of `values`
//     must stay within a relative tolerance: "meanSpeed drifts 13% from
//     tick 1800".
// Refused before either: two runs that simulated different things (seed,
// tick rate, starting save). And said: a run whose input came from a drive
// script, timed on the wall clock — input that reaches the sim diverges
// whatever the code did.
//
// The log is a file anyone can write — `ticks/<session>.jsonl`, one header
// line then `{t, d, v}` per tick: attach writes it from the page, and a
// headless Node sim writes it with `createTickLog` (faster than real time,
// no browser at all).

import { mkdirSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Tolerant mode's defaults: 2% relative, over 60-tick windows. */
export const TOLERANCE = 0.02, WINDOW = 60;

const safe = (s) => String(s).replace(/[^\w.-]/g, '_');

/** A digest as recorded: a string (≤128), a number, or named parts of those. */
export function cleanDigest(d) {
  if (typeof d === 'string') return d.slice(0, 128);
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d === 'bigint') return d.toString();
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const out = {};
    for (const [k, v] of Object.entries(d).slice(0, 32)) { const c = cleanDigest(v); if (c !== undefined && typeof c !== 'object') out[String(k).slice(0, 40)] = c; }
    return Object.keys(out).length ? out : undefined;
  }
  return undefined;
}
/** Summary values as recorded: finite numbers only. */
export function cleanValues(v) {
  if (!v || typeof v !== 'object') return undefined;
  const out = {};
  for (const [k, x] of Object.entries(v).slice(0, 32)) if (typeof x === 'number' && Number.isFinite(x)) out[String(k).slice(0, 40)] = x;
  return Object.keys(out).length ? out : undefined;
}
/** The sim's identity as recorded. */
export function cleanSim(m) {
  const o = {};
  if (!m || typeof m !== 'object') return o;
  if (typeof m.seed === 'string' || typeof m.seed === 'number') o.seed = typeof m.seed === 'string' ? m.seed.slice(0, 80) : m.seed;
  if (typeof m.tickHz === 'number' && m.tickHz > 0) o.tickHz = m.tickHz;
  if (typeof m.save === 'string' && m.save) o.save = m.save.slice(0, 120);
  return o;
}

/**
 * A tick log writer: `ticks/<session>.jsonl` under `dir`. The same file
 * attach writes, so a headless sim and a browser run compare with each other.
 * @param {{dir?:string, session:string, build?:string, drive?:object}} meta
 */
export function createTickLog({ dir = '.sloptimize', session, build, drive } = {}) {
  if (!session) throw new Error('createTickLog: a session id is required');
  const path = join(dir, 'ticks', `${safe(session)}.jsonl`);
  let started = false;
  const head = () => {
    if (started) return;
    started = true;
    mkdirSync(join(dir, 'ticks'), { recursive: true });
    appendFileSync(path, JSON.stringify({ type: 'run', session, ...(build ? { build } : {}), ...(drive ? { drive } : {}), at: new Date().toISOString() }) + '\n');
  };
  return {
    path,
    /** What the run simulates: {seed, tickHz, save}. */
    sim(m) { head(); appendFileSync(path, JSON.stringify({ type: 'sim', ...cleanSim(m), at: new Date().toISOString() }) + '\n'); },
    /** One tick: its digest, and (tolerant mode) its summary values. */
    tick(t, digest, values) { this.ticks([[t, digest, values]]); },
    /** Many: `[[tick, digest, values?], ...]` — what the page sends in batches. */
    ticks(entries) {
      let out = '';
      for (const e of entries ?? []) {
        if (!Array.isArray(e) || !Number.isFinite(Number(e[0]))) continue;
        const d = cleanDigest(e[1]), v = cleanValues(e[2]);
        if (d === undefined && v === undefined) continue;
        out += JSON.stringify({ t: Number(e[0]), ...(d !== undefined ? { d } : {}), ...(v ? { v } : {}) }) + '\n';
      }
      if (!out) return;
      head();
      appendFileSync(path, out);
    },
  };
}

/** A tick log read back: the run's header, its sim (the last declared), its ticks. */
export function readTickLog(path) {
  const log = { path, session: undefined, build: undefined, drive: undefined, sim: {}, ticks: new Map() };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === 'run') { log.session ??= r.session; log.build ??= r.build; log.drive ??= r.drive; log.at ??= r.at; }
    else if (r.type === 'sim') log.sim = cleanSim(r);
    else if (Number.isFinite(r.t)) log.ticks.set(r.t, { d: r.d, v: r.v });
  }
  return log;
}

/** Every tick log under `<dir>/ticks/`, oldest first (header only — cheap). */
export function listTickLogs(dir) {
  const d = join(dir, 'ticks');
  if (!existsSync(d)) return [];
  const out = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      const first = readFileSync(join(d, f), 'utf8').split('\n', 1)[0];
      const h = JSON.parse(first);
      out.push({ path: join(d, f), session: h.session ?? f.replace(/\.jsonl$/, ''), build: h.build, at: h.at });
    } catch { /* half-written */ }
  }
  return out.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));
}

/** A side: a session id or a build (its newest run), or a tick-log path. */
export function resolveTickSide(spec, dir) {
  if (/\.jsonl$/.test(spec) && existsSync(spec)) return { log: readTickLog(spec), note: 'file' };
  const all = listTickLogs(dir);
  const bySession = all.find((x) => x.session === spec);
  if (bySession) return { log: readTickLog(bySession.path) };
  const ofBuild = all.filter((x) => x.build === spec);
  if (ofBuild.length) return { log: readTickLog(ofBuild.at(-1).path), ...(ofBuild.length > 1 ? { note: `newest of ${ofBuild.length} runs` } : {}) };
  return { error: `no tick log for "${spec}" — the game reports __sloptimizeTick(tick, digest) per tick (logs on this dir: ${all.map((x) => x.build ?? x.session).join(', ') || 'none'})` };
}

const sameValue = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));

/** The named parts that differ between two digests (empty: identical). */
export function digestDiff(a, b) {
  const obj = (x) => x && typeof x === 'object';
  if (!obj(a) && !obj(b)) return sameValue(a, b) ? [] : ['(digest)'];
  if (!obj(a) || !obj(b)) return ['(shape: one side has named parts)'];
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!sameValue(a[k], b[k])) out.push(k);
  return out;
}

/** What makes two runs incomparable, and what only weakens the answer. */
export function simMismatch(A, B) {
  const refuse = [], warn = [];
  for (const k of ['seed', 'tickHz', 'save']) {
    const a = A.sim[k], b = B.sim[k];
    if (a !== undefined && b !== undefined && a !== b) refuse.push(`${k}: ${a} vs ${b}`);
  }
  if (A.sim.seed === undefined || B.sim.seed === undefined) warn.push('a seed is not declared on both sides — identical only if both runs were seeded the same (__sloptimizeSim({seed, tickHz}))');
  if (A.sim.tickHz === undefined || B.sim.tickHz === undefined) warn.push('a tick rate is not declared on both sides — a sim stepped by frame time diverges whenever the frame rates differ; step it at a fixed rate and declare tickHz');
  for (const [s, L] of [['A', A], ['B', B]]) if (L.drive) warn.push(`${s} ran a drive script (${L.drive.name ?? 'drive'}): its input is timed on the wall clock, so input that reaches the sim makes runs diverge whatever the code did — apply input by tick, or none`);
  return { refuse, warn };
}

/**
 * Two tick logs, compared.
 * @param {ReturnType<typeof readTickLog>} A
 * @param {ReturnType<typeof readTickLog>} B
 * @param {{ticks?:number, mode?:'exact'|'tolerant', tolerance?:number, window?:number}} [o]
 * @returns {object} verdict: identical | diverged | within | drifted | insufficient | refused | no-data
 */
export function equivalence(A, B, { ticks, mode, tolerance = TOLERANCE, window = WINDOW } = {}) {
  const { refuse, warn } = simMismatch(A, B);
  const base = { a: { session: A.session, build: A.build, sim: A.sim, ticks: A.ticks.size }, b: { session: B.session, build: B.build, sim: B.sim, ticks: B.ticks.size }, warnings: warn };
  if (refuse.length) return { ...base, verdict: 'refused', why: `the runs simulated different things — ${refuse.join('; ')}` };
  const common = [...A.ticks.keys()].filter((t) => B.ticks.has(t)).sort((x, y) => x - y);
  if (!common.length) return { ...base, verdict: 'no-data', why: 'no tick appears in both logs' };
  // `--ticks N` is N ticks COMPARED — the first N both logs carry — not a
  // span of tick numbers: a game may log every 10th tick, or number ticks by
  // its own clock. A tick one log has inside the compared span and the other
  // lacks is counted as missing from the other.
  const range = ticks > 0 ? common.slice(0, ticks) : common;
  const from = range[0], to = range.at(-1);
  const missing = (L, O) => { let n = 0; for (const t of O.ticks.keys()) if (t >= from && t <= to && !L.ticks.has(t)) n++; return n; };
  const mA = missing(A, B), mB = missing(B, A);
  base.range = { from, to, compared: range.length, ...(mA ? { missingA: mA } : {}), ...(mB ? { missingB: mB } : {}) };
  const short = ticks > 0 && range.length < ticks;
  const hasD = range.some((t) => A.ticks.get(t).d !== undefined && B.ticks.get(t).d !== undefined);
  const m = mode ?? (hasD ? 'exact' : 'tolerant');
  base.mode = m;
  if (m === 'exact') {
    if (!hasD) return { ...base, verdict: 'no-data', why: 'no digest on both sides — __sloptimizeTick(tick, digest); for summary values only, --tolerant' };
    let last = null;
    for (const t of range) {
      const a = A.ticks.get(t).d, b = B.ticks.get(t).d;
      if (a === undefined || b === undefined) continue;
      const parts = digestDiff(a, b);
      if (parts.length) {
        const named = a && typeof a === 'object' && b && typeof b === 'object';
        return { ...base, verdict: 'diverged', tick: t, identicalThrough: last, a: { ...base.a, digest: a }, b: { ...base.b, digest: b },
          parts, ...(named ? { same: Object.keys(a).filter((k) => !parts.includes(k)) } : {}) };
      }
      last = t;
    }
    if (short) return { ...base, verdict: 'insufficient', why: `identical through tick ${last}, but only ${range.length} of the ${ticks} ticks asked for are in both logs` };
    return { ...base, verdict: 'identical', through: last };
  }
  // Tolerant: windowed means of each value, side by side.
  const names = new Set();
  for (const t of range) for (const L of [A, B]) for (const k of Object.keys(L.ticks.get(t).v ?? {})) names.add(k);
  if (!names.size) return { ...base, verdict: 'no-data', why: 'no summary values — __sloptimizeTick(tick, digest, {name: n}) for tolerant mode' };
  const drift = {};
  let first = null;
  for (let w0 = from; w0 <= range.at(-1); w0 += window) {
    const ts = range.filter((t) => t >= w0 && t < w0 + window);
    if (!ts.length) continue;
    for (const k of names) {
      const mean = (L) => { const xs = ts.map((t) => L.ticks.get(t).v?.[k]).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined; };
      const a = mean(A), b = mean(B);
      if (a === undefined || b === undefined) continue;
      const den = Math.max(Math.abs(a), Math.abs(b));
      const rel = den < 1e-9 ? 0 : Math.abs(a - b) / den;
      if (!(drift[k]?.rel >= rel)) drift[k] = { rel: +rel.toFixed(4), from: ts[0], to: ts.at(-1), a: +a.toPrecision(6), b: +b.toPrecision(6) };
      if (rel > tolerance && !first) first = { value: k, from: ts[0], to: ts.at(-1), a: +a.toPrecision(6), b: +b.toPrecision(6), rel: +rel.toFixed(4) };
    }
  }
  if (first) return { ...base, verdict: 'drifted', tolerance, window, first, drift };
  if (short) return { ...base, verdict: 'insufficient', tolerance, window, drift, why: `within ${+(tolerance * 100).toFixed(2)}% so far, but only ${range.length} of the ${ticks} ticks asked for are in both logs` };
  return { ...base, verdict: 'within', tolerance, window, drift };
}
