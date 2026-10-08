// ============================================================
// incident-pipeline.mjs — tier-0 record handling, transport-free
// ============================================================
// The half of attach that does not care how CDP is reached: the rolling
// sampling profiler (over an injected `send(method, params)`), incident
// CLUSTERING (M-A1: one cause = one cluster, however often it fires), and
// the .sloptimize/ files. attach.mjs drives it over a raw WebSocket;
// sloptimize/electron drives it over webContents.debugger. Same records,
// same files, same cluster identity either way.
import { mkdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mintSession } from './cloud-sink.js';
import { createRunFold, hotLines } from './runs.js';
import { createTickLog } from './ticks.js';

/** M-A1 — incident identity. One CAUSE investigates once: cluster key is the
 *  classification plus the top attributed frame (or creation-stack head);
 *  repeats increment a count instead of re-waking anyone. */
export function clusterKey(rec, topFrame) {
  const guess = rec.classification && rec.classification[0] ? rec.classification[0].guess : rec.type;
  return `${guess}|${topFrame ?? ''}`;
}

const NOT_NAMED = new Set(['(idle)', '(program)', '(garbage collector)', '(root)']);

/** The samples a selection keeps: `[{profile, idx?}]`, `idx` the sample
 *  indexes inside a frame (absent: the whole chunk). Calls
 *  `fn(node, us, profile)` per sample, `us` its weight (time since the last). */
function eachSample(parts, fn) {
  for (const { profile, idx } of parts) {
    if (!profile?.nodes) continue;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
    if (idx) for (const i of idx) fn(byId.get(samples[i]), deltas[i] ?? 0, profile);
    else for (let i = 0; i < samples.length; i++) fn(byId.get(samples[i]), deltas[i] ?? 0, profile);
  }
}
const asParts = (p) => (Array.isArray(p) ? p : p ? [{ profile: p }] : []);

/** A node's `positionTicks` as line → ticks. V8 can list one line several
 *  times (one entry per code version); they sum. Lines are 1-based. */
function lineTicks(node) {
  const m = new Map();
  for (const t of node?.positionTicks ?? []) if (Number.isFinite(t?.line) && t.ticks > 0) m.set(t.line, (m.get(t.line) ?? 0) + t.ticks);
  return m;
}

/** Top self-time frames from a CDP Profiler.stop payload — or a selection of
 *  samples from several (`[{profile, idx}]`, a frame sliced out of chunks) —
 *  idle/program/gc filtered, heaviest first. One row per FUNCTION (a
 *  function reached by two call paths is two profile nodes, one cost), each
 *  with its hot `lines` from V8's per-line ticks: inside a big update() the
 *  function is known and the statement is not. Pure — unit-tested against a
 *  fixture. */
export function topFramesFromProfile(profile, limit = 5) {
  const rows = new Map();
  // A node's line ticks cover all its samples in the chunk; a slice credits
  // them in proportion to the samples it kept.
  const kept = new Map();
  eachSample(asParts(profile), (n, us, prof) => {
    if (!n) return;
    const f = n.callFrame ?? {};
    if (NOT_NAMED.has(f.functionName)) return;
    const line = (f.lineNumber ?? 0) + 1;
    // The column too: a minified bundle has every function on line 1, many
    // of them `e` or anonymous — one row each, as the run fold keys them.
    const key = `${f.functionName}\t${f.url ?? ''}\t${line}\t${f.columnNumber ?? 0}`;
    let r = rows.get(key);
    if (!r) {
      r = { fn: f.functionName || '(anonymous)', url: f.url ? `${f.url.split('/').slice(-1)[0]}:${line}` : '', us: 0, line, nodes: new Map() };
      rows.set(key, r);
    }
    r.us += us;
    const nk = kept.get(prof) ?? kept.set(prof, new Map()).get(prof);
    nk.set(n, (nk.get(n) ?? 0) + 1);
    r.nodes.set(n, prof);
  });
  const out = [...rows.values()].sort((a, b) => b.us - a.us).slice(0, limit);
  return out.map((r) => {
    const ticks = new Map();
    for (const [n, prof] of r.nodes) {
      const lt = lineTicks(n);
      let all = 0;
      for (const v of lt.values()) all += v;
      if (!all) continue;
      const w = Math.min(1, (kept.get(prof)?.get(n) ?? 0) / all);
      for (const [line, v] of lt) ticks.set(line, (ticks.get(line) ?? 0) + v * w);
    }
    const lines = hotLines(ticks, r.line);
    return { fn: r.fn, url: r.url, selfMs: +(r.us / 1000).toFixed(1), ...(lines.length ? { lines } : {}) };
  });
}

/** Where a chunk's (or a slice's) sampled time went apart from named JS:
 *  V8's collector, `(program)` (native work — layout, GPU sync, compiles,
 *  the embedder) and idle. A stall the JS rows cannot explain is usually in
 *  one of these, and topFramesFromProfile drops all three. ms, one decimal. */
export function sampledBreakdown(profile) {
  const parts = asParts(profile);
  if (!parts.some((x) => x.profile?.nodes)) return undefined;
  const out = { jsMs: 0, gcMs: 0, programMs: 0, idleMs: 0 };
  eachSample(parts, (n, us) => {
    const name = n?.callFrame?.functionName;
    const k = name === '(idle)' ? 'idleMs' : name === '(program)' ? 'programMs' : name === '(garbage collector)' ? 'gcMs' : 'jsMs';
    out[k] += us / 1000;
  });
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(1);
  return out;
}

/**
 * The samples of one frame, out of the chunks still held. `span` is the
 * frame's [from, to] on the page's performance.now() clock; `offsetMs` maps
 * that clock onto the profiler's (profile µs / 1000 − page ms). A chunk's
 * samples carry their own times (startTime + running timeDeltas), so a frame
 * is cut out exactly, wherever the rotations fell.
 * @returns {{parts:{profile:object, idx:number[]}[], sampledMs:number}}
 */
export function sliceFrame(chunks, span, offsetMs) {
  const lo = (span[0] + offsetMs) * 1000, hi = (span[1] + offsetMs) * 1000;
  const parts = [];
  let us = 0;
  for (const profile of chunks) {
    if (!(profile?.endTime >= lo) || !(profile.startTime <= hi)) continue;
    const idx = [];
    let t = profile.startTime;
    const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i] ?? 0;
      // A sample's weight is the time since the one before: it covers (t − Δ, t].
      if (t > lo && t <= hi) { idx.push(i); us += deltas[i] ?? 0; }
    }
    if (idx.length) parts.push({ profile, idx });
  }
  return { parts, sampledMs: +(us / 1000).toFixed(1) };
}

// ── The observer effect, bounded ─────────────────────────────────────────────
// The sampler runs INSIDE the game's renderer, and a Profiler.stop serializes
// every sample it holds on that same main thread. The first field build
// (ticket 2c11481d: ~350 draws, ~450 simulated cars, a healthy 6–9 ms frame
// body) sampled at 0.5 ms and rotated on every hitch, with nothing between
// one rotation and the next. That fed back on itself: a rotation cost the
// frame after it, that frame was a hitch against a median the page refreshes
// only every 60 frames, so it rotated again — 60 fps became 12, with the
// game's own loop still reporting 6–9 ms. And the attributions minted in
// that state named whatever was on the stack while the sampler stalled the
// thread (a 270 ms "waitingCrowdAxes" that takes nothing like 270 ms).
// So, three bounds, each with a name:
//   interval   10 ms — 100 samples/s; a ≥80 ms stall still gets ≥8 samples,
//              enough to name its dominant frame. The 0.5 ms build was
//              2000/s, continuously.
//   floor      a rotation is only worth its cost when the stall is long
//              enough for the sampler to have seen it; below the floor the
//              hitch is recorded, not attributed.
//   cooldown   at most one rotation per second of PAGE time (the same 1/s
//              the tier-1 recorder applies to hitch records, SPEC §3.3) —
//              the loop cannot close because a rotation can never be the
//              cause of the next rotation.
//   window     an unread profile rolls itself over (the same bound
//              node/profiler.js carries, and for the same reason: a quiet
//              hour's samples are of no use to anyone and cost the game
//              exactly when it finally hitches).
//   share      a function is named as the CAUSE only when its self time is
//              at least a tenth of the stall. A field report printed
//              "687.5ms → top _aStarLoop 11.2ms" — 1.6% of the frame, one
//              sample, read as the explanation by the agent that nearly went
//              to optimise A*. Below the bar the record keeps its topFrames
//              (each with its `share` of the frame) but says `unattributed:
//              'low-share'` and clusters on the verdict alone; `sampled`
//              says where the chunk's time went instead (GC, native, idle).
//   restart    what a rotation really costs is its Profiler.START: with no
//              profile running, V8 walks the whole heap to log every
//              compiled function — measured 35 ms at 16 MB, 270 ms at 158 MB,
//              1069 ms at 629 MB (≈1.7 ms per MB), on the page's main thread.
//              A 9000-car sim attached at 520 ms frames against 60 ms
//              unattached, the time all "native": every frame restarted the
//              profiler, and the restart made the next frame long enough to
//              restart it again. So an ANCHOR profile (the console's
//              `profile()`, replaced every 5 min) keeps the profiler alive
//              and every rotation's start cheap (865 ms → 1 ms at 513 MB) —
//              and every start is TIMED: when one is expensive anyway (no
//              anchor) the rotations back off to keep the recorder under
//              2% of the run (cooldown and window ≥ 50× the start), the
//              long-frame exemption needs the frame to be 10× the start,
//              and the run file and `report` say what the recorder cost.
//   long       a frame still at least this long is exempt from the
//              cooldown. A load made of back-to-back 400 ms frames (a field
//              report: its four worst frames AND a 25 s one all came back
//              `unattributed (cooldown)`) is exactly where the cooldown is
//              inverted — the longest frames are the most worth explaining
//              and the cheapest to afford a rotation for, since the frame is
//              already lost: a few ms of Profiler.stop is ~1% of 400 ms. The
//              loop the cooldown closes cannot run through here: one stop of
//              a ≤10 s chunk at this interval is ≤1000 samples, nowhere near
//              a 150 ms frame of its own.
// What the gate drops is COUNTED, never silent: a skipped hitch carries
// `unattributed: 'below-floor' | 'cooldown'` and the next minted record
// carries `skippedSinceLast`. Detection itself is untouched — every hitch
// the page emits lands in perf.jsonl.
//
// ── A hitch's OWN samples ────────────────────────────────────────────────────
// A rotation cannot cut a frame where it ends: a CDP Profiler.stop waits for
// the page's current task (measured: a stop sent 300 ms into a 2 s task is
// answered at 2 s). With long frames back to back, the stop a hitch asks for
// lands at the end of the NEXT frame, so the chunk holds two frames and the
// next hitch's chunk holds the one after it — every attribution one frame
// late. So the pipeline maps the page's clock onto the sampler's once per
// document (a performance.now() read on either side of a stop: the stop's
// endTime lies between them), keeps the last few chunks, and cuts each hitch's
// `frameSpan` out of them by sample time — `profileWindow: 'frame'`, shares
// that are the frame's own instead of an upper bound. Without a mapping (an
// old page, an evaluate the target refused, a slice that caught less than
// half the frame) it falls back to the chunk, as before, and says so.
export const SAMPLING_INTERVAL_US = 10_000;
export const ATTRIBUTE_FLOOR_MS = 80;
export const ATTRIBUTE_COOLDOWN_MS = 1000;
export const ATTRIBUTE_LONG_FRAME_MS = 150;
/** The share of the run the recorder's profiler restarts may cost. */
export const RESTART_BUDGET = 0.02;
/** A Profiler.start slower than this was not anchored: re-anchor, then back off. */
const EXPENSIVE_START_MS = 25;
/** The anchor profile is replaced this often, so its samples never pile up. */
const ANCHOR_EVERY_MS = 5 * 60_000;
/** A worker's sampler stop is given this long before its chunk is skipped. */
const WORKER_STOP_MS = 3000;
/** A clock mapping is kept only when both reads fell within this. */
export const CLOCK_MAX_ERROR_MS = 10;
/** Chunks held for slicing: a frame spans at most the chunk it ended in and
 *  the one before (a stop waits for the task, so it lands a frame late), and
 *  two more cover a roll and a hitch queued behind another. */
const KEEP_CHUNKS = 4;
/** …and beyond that, as many as fit this many samples (~60 s at 10 ms): a
 *  record chain running behind a burst of long frames must still find them. */
const KEEP_SAMPLES = 6000;
export const ATTRIBUTE_MIN_SHARE = 0.1;
export const PROFILE_WINDOW_MS = 10_000;
const RUN_WRITE_MS = 5000;
/** Renderer strings of software rasterizers (SPEC §6.4's regime rule). */
export const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * @param {object} opts
 * @param {string} opts.dir            .sloptimize/ directory (created)
 * @param {(method:string, params?:object)=>Promise<any>} opts.send  CDP call
 * @param {string} [opts.regime]       'hardware' | 'software' | 'unknown' — stamped on profile.json
 * @param {string} [opts.build]        the bundle's identity, stamped on every ledger line (`attach --build`)
 * @param {string} [opts.session]      this run's id; minted when absent — one attach = one session
 * @param {(...a:any[])=>void} [opts.log]
 * @param {(rec:object, key:string)=>void|Promise<void>} [opts.onNewCluster]
 *   Called once per NEW cause, before the record is written — a hook may
 *   stamp fields on `rec` (the Electron trace path does).
 * @param {number} [opts.samplingIntervalUs]  see the header; default 10 000
 * @param {number} [opts.attributeFloorMs]    default 80
 * @param {number} [opts.attributeCooldownMs] default 1000, in page time (`rec.at`)
 * @param {number} [opts.attributeLongFrameMs] default 150 — a frame this long ignores the cooldown (Infinity: never)
 * @param {number} [opts.attributeMinShare]   default 0.1 — the top frame's self time / frameMs
 * @param {number} [opts.windowMs]            default 10 000; 0 disables the roll
 * @param {boolean} [opts.runs]               default true: fold every chunk into runs/<session>.json (runs.js)
 * @param {object} [opts.conditions]          what the caller knows the run is measured under (conditions.js):
 *   `headless`, `browser`, `recorder: {minHitchMs, slots}`, `host` — merged over instrument/mode/regime/sampler.
 *   The block rides the run file from the start; the ledger gets a `conditions` line when the page
 *   reports its half (display, device, GPU) and on every change after.
 * @param {boolean} [opts.coverage]          a COVERAGE run (SPEC §3.12): V8 precise coverage, function
 *   granularity with call counts, instead of the sampler; written to coverage/<session>.json at stop.
 *   The run's mode is `coverage` and no verb reads its timings.
 * @param {{gc?:boolean, snapshots?:boolean}} [opts.heap]  long-session memory (SPEC §3.14). Every
 *   heartbeat carries the JS heap (Runtime.getHeapUsage, cheap); `gc` forces a collection first so the
 *   reading is the post-GC floor, `snapshots` writes heap/<session>-start|end.heapsnapshot. Both pause
 *   the page, so both are conditions of the run.
 * @param {(sessionId:string, method:string, params?:object)=>Promise<any>} [opts.sendTo]  CDP call on a CHILD
 *   session (flat mode). Given, the page's workers are auto-attached and profiled too (SPEC §3.18):
 *   each its own thread in the run file. Absent (or `workers: false`), the page alone, as before.
 * @param {boolean} [opts.workers]           default true when sendTo is given
 * @param {()=>number} [opts.now]             wall clock, for records without an `at`
 * @param {Function} [opts.setTimeout] @param {Function} [opts.clearTimeout]  injectable for tests
 */
export function createIncidentPipeline(opts) {
  const dir = opts.dir ?? '.sloptimize';
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  const send = opts.send;
  let regime = opts.regime ?? 'unknown';
  // Every line this run writes says which run and which build it was: the
  // page cannot know either, and `history` needs both to hold several runs
  // of one build apart (a hitch count from one run is one noisy sample).
  const session = typeof opts.session === 'string' && opts.session ? opts.session : mintSession();
  const build = typeof opts.build === 'string' && opts.build ? opts.build : undefined;
  const stamp = (rec) => {
    if (rec.session === undefined) rec.session = session;
    if (build !== undefined && rec.build === undefined) rec.build = build;
    return rec;
  };
  if (typeof send !== 'function') throw new Error('createIncidentPipeline: send is required');
  const samplingIntervalUs = opts.samplingIntervalUs ?? SAMPLING_INTERVAL_US;
  const floorMs = opts.attributeFloorMs ?? ATTRIBUTE_FLOOR_MS;
  const cooldownMs = opts.attributeCooldownMs ?? ATTRIBUTE_COOLDOWN_MS;
  const longFrameMs = opts.attributeLongFrameMs ?? ATTRIBUTE_LONG_FRAME_MS;
  const minShare = Number.isFinite(opts.attributeMinShare) ? opts.attributeMinShare : ATTRIBUTE_MIN_SHARE;
  const windowMs = opts.windowMs ?? PROFILE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeout ?? setTimeout, clearT = opts.clearTimeout ?? clearTimeout;
  mkdirSync(dir, { recursive: true });

  // The whole run's samples (runs.js): every chunk is folded before it is
  // dropped, credited to the phase the page was last heard in. Written at
  // most every RUN_WRITE_MS and always on stop — a crash loses seconds.
  const run = opts.runs === false ? null : createRunFold({ session, build, intervalUs: samplingIntervalUs });
  // What this run is measured UNDER (conditions.js): the instrument and its
  // settings from here, the display/device/GPU from the page's `conditions`
  // records. Kept in the run file and written to the ledger on every change,
  // so compare and check can refuse two runs that do not compare.
  const coverage = opts.coverage === true;
  const conditions = { v: 1, instrument: 'attach', mode: coverage ? 'coverage' : 'timing', ...(coverage ? {} : { sampler: { intervalUs: samplingIntervalUs } }), ...(opts.conditions ?? {}) };
  if (regime !== 'unknown') conditions.regime = regime;
  const heapOpts = opts.heap ?? {};
  if (heapOpts.gc || heapOpts.snapshots) conditions.soak = { ...(heapOpts.gc ? { forcedGc: true } : {}), ...(heapOpts.snapshots ? { heapSnapshots: true } : {}) };
  run?.setConditions(conditions);
  function writeConditions() {
    run?.setConditions(conditions);
    const rec = { type: 'conditions', at: new Date(now()).toISOString(), tier: 0, conditions };
    appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(stamp(rec)) + '\n');
  }
  const runPath = join(dir, 'runs', `${session.replace(/[^\w.-]/g, '_')}.json`);
  // The sim's per-tick digests (SPEC §3.16): their own file, never the ledger.
  let tickLog = null;
  const ticks = () => (tickLog ??= createTickLog({ dir, session, build, drive: conditions.drive }));
  let pagePhase, runWrittenAt = -Infinity;
  // Phase edges on the page clock, [t, phase from t on], from closed spans.
  const edges = [];
  /** A chunk into the run file. With the clock mapped and the page's phase
   *  edges known, each sample is credited to the phase it fell in — a 3 s
   *  phase inside a 10 s window owns its samples, with no rotation at the
   *  edge (a rotation waits out the page's task: one per edge put the record
   *  chain a frame behind per edge). Otherwise, the whole chunk to the phase
   *  the page was last heard in (≤ one window misfiled at an edge). */
  function foldChunk(profile, thread) {
    if (!run || !profile) return;
    if (!clock || !edges.length || !Array.isArray(profile.samples) || typeof profile.startTime !== 'number') {
      run.addProfile(profile, pagePhase, now(), thread);
    } else {
      const parts = new Map();
      let t = profile.startTime;
      const deltas = profile.timeDeltas ?? [];
      for (let i = 0; i < profile.samples.length; i++) {
        t += deltas[i] ?? 0;
        const ms = t / 1000 - clock.offsetMs;
        let ph;   // before the first edge we know of: the unnamed boot phase
        // A sample covers (t − Δ, t]: one landing ON an edge is the phase before it.
        for (const [et, ep] of edges) { if (et < ms) ph = ep; else break; }
        const k = ph ?? '';
        const part = parts.get(k) ?? parts.set(k, { phase: ph, samples: [], timeDeltas: [], us: 0 }).get(k);
        part.samples.push(profile.samples[i]); part.timeDeltas.push(deltas[i] ?? 0); part.us += deltas[i] ?? 0;
      }
      // A node's line ticks cover all its samples in the chunk: each part
      // carries them in proportion to the samples it kept, so a function's
      // lines are never credited to a phase it did not run in.
      const total = new Map();
      for (const id of profile.samples) total.set(id, (total.get(id) ?? 0) + 1);
      for (const p of parts.values()) {
        const kept = new Map();
        for (const id of p.samples) kept.set(id, (kept.get(id) ?? 0) + 1);
        const nodes = parts.size === 1 ? profile.nodes : profile.nodes.map((n) => {
          if (!n.positionTicks?.length) return n;
          const share = (kept.get(n.id) ?? 0) / (total.get(n.id) || 1);
          const { positionTicks, ...rest } = n;
          return share > 0 ? { ...rest, positionTicks: positionTicks.map((t) => ({ line: t.line, ticks: t.ticks * share })) } : rest;
        });
        run.addProfile({ nodes, samples: p.samples, timeDeltas: p.timeDeltas, startTime: 0, endTime: p.us }, p.phase, now(), thread);
      }
    }
    writeRun(false);
  }
  function writeRun(force) {
    if (!run || run.empty) return;
    const t = now();
    if (!force && t - runWrittenAt < RUN_WRITE_MS) return;
    runWrittenAt = t;
    try { mkdirSync(join(dir, 'runs'), { recursive: true }); writeFileSync(runPath, JSON.stringify(run.toJSON())); }
    catch (e) { log(`run file not written: ${e?.message ?? e}`); }
  }

  const clusters = new Map();   // key → {count, firstAt, lastAt, sample}
  let lastCreateStackHead = null;
  let profiling = false;
  let lastRotateAt = -Infinity;  // page time of the last attributing rotation
  let skippedSinceLast = 0;      // hitches the gate left unattributed since then
  let windowTimer = null;
  let coverageTaken = false;
  // ── Worker threads (SPEC §3.18) ─────────────────────────────────────────
  // A game that moves its simulation into a Worker takes the work out of the
  // page's sampler: the report shows a healthy main thread and nothing of the
  // sim beside it. With a child-session transport, every dedicated or shared
  // worker the page starts is auto-attached PAUSED (so its first instruction
  // is sampled), given a sampler of its own at the page's interval, released,
  // and rolled on its own chain — never the record chain: a worker's stop
  // waits for ITS current task, and a hitch must not wait on the sim.
  // Anything else that auto-attaches (an out-of-process iframe) is released
  // untouched: a paused target the attach forgot is a hung page.
  const sendTo = typeof opts.sendTo === 'function' && opts.workers !== false && !coverage ? opts.sendTo : null;
  const workers = new Map();   // sessionId → { name }
  let workerChain = Promise.resolve(), workerTimer = null, workerRestartMs = 0;
  let closing = false;   // stop() began: a worker attaching now is released, never started
  const WORKER_TYPES = new Set(['worker', 'shared_worker']);
  function threadName(info) {
    const title = typeof info.title === 'string' && info.title && !/^[a-z][\w+.-]*:/i.test(info.title) ? info.title : '';
    const base = title || String(info.url ?? '').replace(/[?#].*$/, '').split('/').pop() || 'anonymous';
    let name = `worker[${base.slice(0, 40)}]`;
    const taken = new Set([...workers.values()].map((w) => w.name));
    for (let i = 2; taken.has(name); i++) name = `worker[${base.slice(0, 36)}#${i}]`;
    return name;
  }
  async function attachWorker({ sessionId, targetInfo = {}, waitingForDebugger }) {
    try {
      if (!WORKER_TYPES.has(targetInfo.type) || !profiling || closing) return;
      const to = (m, p) => sendTo(sessionId, m, p);
      await to('Profiler.enable');
      await to('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
      // A worker's heap is walked on every profiler start too (header:
      // restart) — a sim worker's is the big one. Anchored like the page.
      const anchorT = await anchor(to);
      await to('Profiler.start');
      // A worker's own workers (a sim that farms out pathfinding).
      try { await sendTo(sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }); } catch { /* not supported here */ }
      const name = threadName(targetInfo);
      if (closing) { try { await sendTo(sessionId, 'Profiler.stop'); } catch { /* gone */ } return; }
      workers.set(sessionId, { name, anchor: anchorT });
      log(`profiling ${name}`);
      // The run is now measured with a sampler in the worker too: a
      // condition (a worker-profiled run does not compare with a page-only one).
      conditions.sampler = { ...(conditions.sampler ?? {}), workers: [...new Set([...(conditions.sampler?.workers ?? []), name.replace(/#\d+\]$/, ']')])].sort() };
      writeConditions();
      armWorkers();
    } catch (e) { log(`worker ${targetInfo.url ?? sessionId} not profiled: ${e?.message ?? e}`); }
    finally {
      if (waitingForDebugger) { try { await sendTo(sessionId, 'Runtime.runIfWaitingForDebugger'); } catch { /* gone */ } }
    }
  }
  /** Stop/start every worker's sampler (batched, as the page's) and fold the
   *  chunks into their threads; `final` stops without restarting. A worker
   *  that does not answer within the bound is skipped this round. */
  function rotateWorkers(final = false) {
    const run1 = async () => {
      await Promise.all([...workers].map(async ([sid, w]) => {
        let tStop = 0, tStart = 0;
        const calls = [sendTo(sid, 'Profiler.stop').then((r) => { tStop = performance.now(); return r; }),
          ...(final ? [] : [sendTo(sid, 'Profiler.start').then((r) => { tStart = performance.now(); return r; })])];
        let timer;
        const res = await Promise.race([Promise.all(calls), new Promise((r) => { timer = setT(() => r(null), WORKER_STOP_MS); timer?.unref?.(); })]).catch(() => null);
        clearT(timer);
        const profile = res?.[0]?.profile;
        if (profile) foldChunk(profile, w.name);
        if (res && !final) {
          const ms = Math.max(0, tStart - tStop);
          if (ms > cost.maxWorkerRestartMs) cost.maxWorkerRestartMs = ms;
          workerRestartMs = Math.max(ms, workerRestartMs / 2);
          if (ms > EXPENSIVE_START_MS && w.anchor === null) w.anchor = await anchor((m, p) => sendTo(sid, m, p));
        }
        if (final && w.anchor) { try { await sendTo(sid, 'Runtime.evaluate', { expression: `profileEnd(${JSON.stringify(w.anchor)})`, includeCommandLineAPI: true, silent: true }); } catch { /* gone */ } }
      }));
      writeRun(final);
    };
    workerChain = workerChain.then(run1, run1).catch(() => {});
    return workerChain;
  }
  function armWorkers() {
    if (workerTimer !== null || !(windowMs > 0) || closing) return;
    const tick = () => { workerTimer = setT(() => { void rotateWorkers().then(() => { if (workerTimer !== null) tick(); }); }, Math.max(windowMs, workerRestartMs / RESTART_BUDGET)); workerTimer?.unref?.(); };
    tick();
  }

  // The page clock → sampler clock mapping, per document (header: a hitch's
  // own samples), and the chunks a frame is cut out of.
  let clock = null, clockTries = 0;
  const held = [];
  // What the recorder costs the page (header: restart): the last start's
  // cost (decaying), and the run's totals for the run file and `report`.
  let restartMs = 0, reanchored = false, budgetSaid = false;
  const cost = { restarts: 0, restartMs: 0, maxRestartMs: 0, anchored: false, maxWorkerRestartMs: 0 };
  /** The interval between rotations the restart cost allows. */
  const budgeted = (ms) => Math.max(ms, restartMs / RESTART_BUDGET);

  function arm() {
    disarm();
    if (!(windowMs > 0)) return;
    windowTimer = setT(() => { windowTimer = null; return onRoll(); }, budgeted(windowMs));
    windowTimer?.unref?.();
  }
  function disarm() {
    if (windowTimer !== null) clearT(windowTimer);
    windowTimer = null;
  }

  // Coverage mode: which scripts belong to the document being measured. The
  // attach reloads the page after start(), and the old document's scripts —
  // same URLs, a few frames of counts — must not be read as the new one's.
  const scriptCtx = new Map();   // scriptId → executionContextId
  let mainFrame = null, docCtx = null;
  function onEvent(method, params) {
    if (sendTo && method === 'Target.attachedToTarget' && params?.sessionId) { void attachWorker(params); return; }
    if (sendTo && method === 'Target.detachedFromTarget' && params?.sessionId) { workers.delete(params.sessionId); return; }
    if (method === 'HeapProfiler.addHeapSnapshotChunk' && snapshot && typeof params?.chunk === 'string') {
      appendFileSync(snapshot.path, params.chunk);
      snapshot.bytes += params.chunk.length;
      return;
    }
    if (!coverage || !params) return;
    if (method === 'Runtime.executionContextCreated') {
      const c = params.context;
      if (c?.auxData?.isDefault && (mainFrame === null || c.auxData.frameId === mainFrame)) docCtx = c.id;
    } else if (method === 'Debugger.scriptParsed' && params.scriptId) {
      scriptCtx.set(params.scriptId, params.executionContextId);
    }
  }
  async function startCoverage() {
    try { mainFrame = (await send('Page.getFrameTree'))?.frameTree?.frame?.id ?? null; } catch { /* no Page domain */ }
    await send('Debugger.enable');
    // An enabled debugger would stop on a `debugger;` statement: never here.
    await send('Debugger.setSkipAllPauses', { skip: true });
    await send('Profiler.enable');
    await send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
  }
  /** Coverage at stop: per script of the measured document, every function
   *  with its source position (1-based line, 0-based column — what a source
   *  map reads), end line, call count and size. */
  async function writeCoverage() {
    let result;
    try { ({ result } = await send('Profiler.takePreciseCoverage') ?? {}); } catch (e) { log(`coverage not taken: ${e?.message ?? e}`); return; }
    const scripts = [];
    for (const sc of result ?? []) {
      if (!sc.url || /^(chrome|devtools|chrome-extension|node|extensions)::?/.test(sc.url)) continue;
      if (docCtx !== null && scriptCtx.has(sc.scriptId) && scriptCtx.get(sc.scriptId) !== docCtx) continue;
      let src = '';
      try { src = (await send('Debugger.getScriptSource', { scriptId: sc.scriptId }))?.scriptSource ?? ''; } catch { /* gone */ }
      const starts = [0];
      for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
      const pos = (off) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; } return [lo + 1, off - starts[lo]]; };
      const fns = [];
      for (const f of sc.functions ?? []) {
        const r = f.ranges?.[0];
        if (!r) continue;
        const [line, col] = pos(r.startOffset), [endLine, endCol] = pos(Math.max(r.startOffset, r.endOffset - 1));
        // [name, line, col, endLine, count, size, endCol]: the end column lets a
        // source map place the function's LAST position, not its end line's first.
        fns.push([f.functionName || '', line, col, endLine, r.count, r.endOffset - r.startOffset, endCol]);
      }
      scripts.push({ url: sc.url, size: src.length || Math.max(0, ...fns.map((x) => x[5])), fns });
    }
    try {
      mkdirSync(join(dir, 'coverage'), { recursive: true });
      writeFileSync(join(dir, 'coverage', `${session.replace(/[^\w.-]/g, '_')}.json`),
        JSON.stringify({ type: 'coverage', v: 1, session, ...(build ? { build } : {}), at: new Date(now()).toISOString(), granularity: 'function', scripts }));
      log(`coverage: ${scripts.length} script(s), ${scripts.reduce((n, x) => n + x.fns.length, 0)} functions → coverage/${session}.json`);
    } catch (e) { log(`coverage not written: ${e?.message ?? e}`); }
    try { await send('Profiler.stopPreciseCoverage'); } catch { /* target gone */ }
  }

  // ── Memory (SPEC §3.14) ──────────────────────────────────────────────────
  /** The page's JS heap onto a heartbeat: post-GC when the run forces one. */
  async function readHeap(rec) {
    try {
      if (heapOpts.gc) await send('HeapProfiler.collectGarbage');
      const u = await send('Runtime.getHeapUsage');
      if (typeof u?.usedSize === 'number') {
        rec.heap = { usedMB: +(u.usedSize / 1048576).toFixed(2), ...(typeof u.totalSize === 'number' ? { totalMB: +(u.totalSize / 1048576).toFixed(2) } : {}),
          source: heapOpts.gc ? 'post-gc' : 'live' };
      }
    } catch { /* the target cannot say */ }
  }
  // A snapshot streams in chunks as events; one at a time.
  let snapshot = null;   // { path, bytes }
  async function takeSnapshot(label) {
    if (!heapOpts.snapshots || snapshot) return;
    const path = join(dir, 'heap', `${session.replace(/[^\w.-]/g, '_')}-${label}.heapsnapshot`);
    try {
      mkdirSync(join(dir, 'heap'), { recursive: true });
      writeFileSync(path, '');
      snapshot = { path, bytes: 0 };
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      log(`heap snapshot (${label}): ${(statSync(path).size / 1048576).toFixed(1)} MB → ${path}`);
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(stamp({ type: 'heap-snapshot', at: new Date(now()).toISOString(), label, file: path })) + '\n');
    } catch (e) { log(`heap snapshot (${label}) not taken: ${e?.message ?? e}`); }
    finally { snapshot = null; }
  }
  let snapTimer = null;

  async function start() {
    if (heapOpts.snapshots) {
      try { await send('HeapProfiler.enable'); } catch { /* none */ }
      // The start snapshot once the reloaded page has settled; the end one at stop.
      snapTimer = setT(() => { snapTimer = null; chain = chain.then(() => takeSnapshot('start')).catch(() => {}); }, opts.snapshotAfterMs ?? 30_000);
      snapTimer?.unref?.();
    }
    if (coverage) { await startCoverage(); return; }
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
    // The anchor first: its start is the one heap walk of the session.
    await anchorPage();
    await send('Profiler.start');
    profiling = true;
    arm();
    armAnchor();
    if (sendTo) {
      try { await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }); }
      catch (e) { log(`workers not profiled: ${e?.message ?? e}`); }
    }
  }
  // stop() twice (a signal during the loop's own stop) is one stop.
  let stopping = null;
  function stop() { return (stopping ??= doStop()); }
  async function doStop() {
    closing = true;
    disarm();
    // The page's buffered ticks and open span, before anything stops: the
    // records cross the binding ahead of the reply, and the chain writes them.
    if (!coverage) {
      try { await send('Runtime.evaluate', { expression: 'globalThis.__sloptimizeFlush && globalThis.__sloptimizeFlush()' }); } catch { /* target gone */ }
      // Bounded: a rotation the target never answers must not hold the stop.
      let timer;
      await Promise.race([chain.catch(() => {}), new Promise((r) => { timer = setT(r, WORKER_STOP_MS); timer?.unref?.(); })]);
      clearT(timer);
    }
    if (snapTimer !== null) { clearT(snapTimer); snapTimer = null; }
    if (heapOpts.snapshots) await (chain = chain.then(() => takeSnapshot('end')).catch(() => {}));
    if (coverage && !coverageTaken) { coverageTaken = true; await writeCoverage(); }
    if (anchorTimer !== null) { clearT(anchorTimer); anchorTimer = null; }
    if (workerTimer !== null) { clearT(workerTimer); workerTimer = null; }
    if (workers.size) await rotateWorkers(true);
    if (!profiling) { writeRun(true); return; }
    profiling = false;
    try { const { profile } = await send('Profiler.stop') ?? {}; foldChunk(profile); } catch { /* target gone */ }
    // The anchor goes too: a page left profiling pays for it.
    if (anchorTitle) { try { await send('Runtime.evaluate', { expression: `profileEnd(${JSON.stringify(anchorTitle)})`, includeCommandLineAPI: true, silent: true }); } catch { /* gone */ } }
    run?.setRecorder(recorderJSON());
    writeRun(true);
  }
  /** Stop/start the sampler; the chunk that ended. Re-arms the window: it
   *  measures UNREAD time. */
  async function rotateProfile() {
    if (!profiling) return null;
    try {
      // Stop and start go out TOGETHER: the target runs them back to back.
      // Awaited one after the other, the start waits out whatever task the
      // page began meanwhile — measured on back-to-back 300 ms frames, every
      // rotation left the whole next frame unsampled (and out of the run
      // file). The clock reads ride the same batch, so the stop is not
      // delayed and the bracket stays tight even when all four wait out a
      // long task together.
      const calibrate = clock === null && clockTries < 10;
      const reads = calibrate ? [pageNow()] : null;
      // The start's cost is the gap between the two replies: the target runs
      // stop and start back to back, so start's reply lags stop's by its work.
      let tStop = 0, tStart = 0;
      const stopped = send('Profiler.stop').then((r) => { tStop = performance.now(); return r; });
      const started = send('Profiler.start').then((r) => { tStart = performance.now(); return r; });
      if (reads) reads.push(pageNow());
      const [{ profile } = {}] = await Promise.all([stopped, started]);
      await restarted(Math.max(0, tStart - tStop));
      arm();
      if (reads) {
        clockTries++;
        const [before, after] = await Promise.all(reads);
        if (before !== undefined && after !== undefined && after - before <= 2 * CLOCK_MAX_ERROR_MS && typeof profile?.endTime === 'number') {
          clock = { offsetMs: profile.endTime / 1000 - (before + after) / 2, errMs: +((after - before) / 2).toFixed(2) };
        }
      }
      if (profile?.samples) {
        held.push(profile);
        let n = 0;
        for (const c of held) n += c.samples.length;
        while (held.length > KEEP_CHUNKS && n > KEEP_SAMPLES) n -= held.shift().samples.length;
      }
      foldChunk(profile);
      return profile;
    } catch { return null; }
  }
  /** Book one restart's cost; an expensive one is re-anchored once, and
   *  the rotations back off to the budget (header: restart). */
  async function restarted(ms) {
    cost.restarts++; cost.restartMs += ms; if (ms > cost.maxRestartMs) cost.maxRestartMs = ms;
    restartMs = Math.max(ms, restartMs / 2);
    run?.setRecorder(recorderJSON());
    if (ms <= EXPENSIVE_START_MS) return;
    // The walk was the missing anchor: anchored again, the next restart is
    // cheap, and the one that was not must not hold attribution off.
    if (!reanchored) { reanchored = true; if (await anchorPage()) { restartMs = 0; log(`profiler restart cost ${Math.round(ms)} ms — re-anchored`); return; } }
    if (!budgetSaid) {
      budgetSaid = true;
      log(`profiler restarts cost ${Math.round(ms)} ms on this page (V8 walks the heap on every start) — attributing at most every ${(budgeted(cooldownMs) / 1000).toFixed(1)} s to keep the recorder under ${RESTART_BUDGET * 100}% of the run`);
    }
  }
  function recorderJSON() {
    return { restarts: cost.restarts, restartMs: +cost.restartMs.toFixed(1), maxRestartMs: +cost.maxRestartMs.toFixed(1), anchored: cost.anchored,
      ...(cost.maxWorkerRestartMs > 0 ? { maxWorkerRestartMs: +cost.maxWorkerRestartMs.toFixed(1) } : {}) };
  }
  // The anchor: a second, long-lived profile through the console API, so a
  // rotation never stops the LAST profile and V8 never re-walks the heap.
  // Replaced (new one first, then the old ended) so its samples stay few.
  let anchorSeq = 0, anchorTitle = null, anchorTimer = null;
  async function anchor(sendFn, current = null) {
    const title = `__sloptimize_anchor_${++anchorSeq}`;
    for (const expression of [`profile(${JSON.stringify(title)})`, `console.profile(${JSON.stringify(title)})`]) {
      try {
        const r = await sendFn('Runtime.evaluate', { expression, includeCommandLineAPI: true, silent: true });
        if (r?.exceptionDetails) continue;
        if (current) { try { await sendFn('Runtime.evaluate', { expression: `profileEnd(${JSON.stringify(current)})`, includeCommandLineAPI: true, silent: true }); } catch { /* gone */ } }
        return title;
      } catch { /* next way */ }
    }
    return null;
  }
  async function anchorPage() {
    const t = await anchor(send, anchorTitle);
    if (t) { anchorTitle = t; cost.anchored = true; }
    return t;
  }
  function armAnchor() {
    if (anchorTimer !== null || closing) return;
    anchorTimer = setT(() => {
      anchorTimer = null;
      const go = async () => {
        if (profiling && !closing) {
          await anchorPage();
          for (const [sid, w] of workers) if (w.anchor) w.anchor = (await anchor((m, p) => sendTo(sid, m, p), w.anchor)) ?? w.anchor;
        }
        armAnchor();
      };
      chain = chain.then(go, go).catch(() => {});
    }, ANCHOR_EVERY_MS);
    anchorTimer?.unref?.();
  }
  async function pageNow() {
    try {
      const v = (await send('Runtime.evaluate', { expression: 'performance.now()', returnByValue: true }))?.result?.value;
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    } catch { return undefined; }
  }
  /** The window expired unread: its samples serve no hitch — drop them. Runs
   *  on the record chain so it never interleaves with a hitch's rotation. */
  function onRoll() {
    const run = async () => { if (profiling) await rotateProfile(); };
    chain = chain.then(run, run).catch(() => {});
    return chain;
  }

  function writeClusters() {
    writeFileSync(join(dir, 'clusters.json'), JSON.stringify([...clusters.entries()].map(([k, v]) => ({ key: k, count: v.count, firstAt: v.firstAt, lastAt: v.lastAt })), null, 2));
  }

  // Records are handled strictly in arrival order: a hitch awaits the
  // profiler rotation (and the trace hook), and a second hitch arriving
  // meanwhile must not overtake it — the ledger's order is the page's order.
  let chain = Promise.resolve();
  function onRecord(rec) {
    const run = () => handle(rec);
    // A failed write (disk full, dir removed) is logged, never an unhandled
    // rejection: attach calls this with `void`, and the next record must run.
    chain = chain.then(run, run).catch((e) => log(`record dropped: ${e?.message ?? e}`));
    return chain;
  }

  async function handle(rec) {
    stamp(rec);
    if (rec.type === 'conditions') {
      // The page's half — display cadence, device, GPU — merged into the
      // run's block and written whole. Not phase-stamped: a run's conditions
      // are the run's, and a --phase filter must not drop them.
      for (const k of ['display', 'device', 'gpu']) if (rec[k] !== undefined) conditions[k] = rec[k];
      if (regime === 'unknown' && typeof rec.gpu === 'string' && rec.gpu) {
        regime = SOFTWARE_GPU.test(rec.gpu) ? 'software' : 'hardware';
        conditions.regime = regime;
      }
      writeConditions();
      writeRun(true);
      return;
    }
    // A closing span names the phase that ENDED, and a hitch the phase that
    // covered most of its frame — both may be past; the next record says the
    // page's current one.
    if (typeof rec.phase === 'string' && rec.type !== 'phase-span' && rec.type !== 'hitch') pagePhase = rec.phase;
    // A closed span is a phase EDGE on the page clock (header: a hitch's own
    // samples): every chunk is credited to its phases by sample time.
    if (rec.type === 'phase-span' && !rec.open && typeof rec.t0 === 'number' && typeof rec.t1 === 'number') {
      if (!edges.some((e) => e[0] === rec.t0)) edges.push([rec.t0, rec.phase]);
      edges.push([rec.t1, rec.next ?? undefined]);
      edges.sort((x, y) => x[0] - y[0]);
      if (edges.length > 64) edges.splice(0, edges.length - 64);
    }
    // A new document has its own time origin: map its clock afresh.
    if (rec.type === 'armed') {
      clock = null; clockTries = 0; held.length = 0; edges.length = 0; reanchored = false;
      // A navigation ends console-started profiles (measured: the first
      // restart after attach's reload walked a 400 MB heap, 1082 ms). The
      // main profile survives it, so anchoring the new document is cheap.
      if (profiling && !closing) await anchorPage();
    }
    if (rec.type === 'ticks') {
      try { ticks().ticks(rec.entries); } catch (e) { log(`ticks not written: ${e?.message ?? e}`); }
      return;
    }
    if (rec.type === 'sim') { try { ticks().sim(rec); } catch { /* the ledger line below still says it */ } }
    if (rec.type === 'gpu-create') {
      lastCreateStackHead = (rec.stack || '').split('\n')[0]?.trim() ?? null;
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
      return;
    }
    if (rec.type === 'profile') {
      run?.addFrame(rec);
      // Which denominator the run's counters are read over (SPEC §3.11): the
      // game's clock or wall time — two runs on different ones do not compare.
      if (rec.tally) {
        const clock = rec.clock?.name ? `clock:${rec.clock.name}` : 'wall';
        if (conditions.counters?.denominator !== clock) { conditions.counters = { denominator: clock }; writeConditions(); }
      }
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...rec, regime, at: new Date().toISOString() }, null, 2));
      return;
    }
    if (rec.type === 'hitch') {
      // The gate (header): a rotation only for a stall the sampler can name,
      // and at most one per second of page time. A gated hitch is recorded
      // and counted, not minted — it has no identity to cluster by, and a
      // "cause" named from no samples is the very artifact the gate exists
      // to end. (A page whose sampler is not running at all still mints an
      // unattributed cluster below: that is a mode, not a rate.)
      const t = Number.isFinite(Date.parse(rec.at)) ? Date.parse(rec.at) : now();
      // A long frame skips the cooldown only when a restart is a small part
      // of it: a rotation must never be the cause of the next (header).
      const long = rec.frameMs >= longFrameMs && rec.frameMs >= 10 * restartMs;
      const gated = !(rec.frameMs >= floorMs) ? 'below-floor'
        : t - lastRotateAt < budgeted(cooldownMs) && !long ? 'cooldown' : null;
      if (gated && profiling) {
        skippedSinceLast++;
        rec.topFrames = [];
        rec.profileWindow = 'none';
        rec.unattributed = gated;
        appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
        return;
      }
      // Attribute: grab the current profiler chunk and take the heaviest
      // frames. The chunk spans up to the rotation window, so a freeze that
      // dominated its window names itself; the caveat rides the record.
      lastRotateAt = t;
      const profile = await rotateProfile();
      // The frame's own samples when its interval maps onto the sampler's
      // clock (header); the whole chunk otherwise.
      let source = profile;
      rec.profileWindow = 'rolling-chunk';
      if (clock && Array.isArray(rec.frameSpan) && rec.frameSpan.length === 2 && rec.frameMs > 0) {
        const cut = sliceFrame(held, rec.frameSpan, clock.offsetMs);
        if (cut.sampledMs >= 0.5 * rec.frameMs) { source = cut.parts; rec.profileWindow = 'frame'; rec.frameSampledMs = cut.sampledMs; }
        else if (profile && !(profile.endTime >= (rec.frameSpan[0] + clock.offsetMs) * 1000 && profile.startTime <= (rec.frameSpan[1] + clock.offsetMs) * 1000)) {
          // The chunk provably holds ANOTHER time: naming its functions
          // would name a different frame's cause. Said, not guessed.
          source = null; rec.profileWindow = 'none'; rec.unattributed = 'not-sampled';
        }
      }
      rec.topFrames = topFramesFromProfile(source);
      if (skippedSinceLast > 0) { rec.skippedSinceLast = skippedSinceLast; skippedSinceLast = 0; }
      // Each frame's self time as a share of THIS frame (header: share). Cut
      // from the frame, a share is the function's; from a chunk that spans
      // more than the frame, an upper bound on what it could explain — which
      // is the direction that matters for refusing to name it.
      if (rec.frameMs > 0) for (const f of rec.topFrames) f.share = +(f.selfMs / rec.frameMs).toFixed(3);
      const sampled = sampledBreakdown(source);
      if (sampled) rec.sampled = sampled;
      const guess = rec.classification?.[0]?.guess;
      const lead = rec.topFrames[0];
      const weak = guess !== 'shader-compile' && lead?.share !== undefined && lead.share < minShare;
      if (weak) rec.unattributed = 'low-share';
      const top = guess === 'shader-compile' ? lastCreateStackHead
        : lead && !weak ? `${lead.fn}@${lead.url}` : null;
      let key = clusterKey(rec, top);
      // MERGE before minting (M-A1): if any existing cluster's identifying
      // frame appears anywhere in this hitch's top frames, this is the same
      // cause seen from a different leaf — V8 inlining moves the hot function
      // into its caller between occurrences (measured on the exit fixture:
      // freeze #1 named seededFreezeWork, freeze #2 arrived as its caller).
      // Inlining that erases the frame ENTIRELY still splits a cause in two;
      // stated in the spec as a standing limit, not papered over.
      if (!clusters.has(key) && !weak) {
        const names = new Set((rec.topFrames ?? []).slice(0, 3).map((f) => `${f.fn}@${f.url}`));
        for (const existing of clusters.keys()) {
          const frame = existing.split('|')[1];
          if (frame && names.has(frame)) { key = existing; break; }
        }
      }
      const c = clusters.get(key);
      if (c) {
        c.count++; c.lastAt = rec.at;
        rec.cluster = { key, count: c.count, new: false };
      } else {
        clusters.set(key, { count: 1, firstAt: rec.at, lastAt: rec.at, sample: rec });
        rec.cluster = { key, count: 1, new: true };
        // The PUSH edge: only a NEW cause reaches stdout (the agent's wake
        // line) — M-A1's exit criterion made mechanical.
        log(`INCIDENT ${key} — ${rec.frameMs}ms, top: ${top ?? 'unattributed'}`);
        if (opts.onNewCluster) { try { await opts.onNewCluster(rec, key); } catch (e) { rec.hookError = String(e?.message ?? e); } }
      }
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
      writeClusters();
      return;
    }
    if (rec.type === 'heartbeat') await readHeap(rec);
    appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
    if (rec.type === 'armed') log(`recorder armed in page: ${rec.url}`);
  }

  return { onRecord, onEvent, clusters, start, stop, get regime() { return regime; }, conditions, session, build };
}
