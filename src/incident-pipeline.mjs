// ============================================================
// incident-pipeline.mjs — tier-0 record handling, transport-free
// ============================================================
// The half of attach that does not care how CDP is reached: the rolling
// sampling profiler (over an injected `send(method, params)`), incident
// CLUSTERING (M-A1: one cause = one cluster, however often it fires), and
// the .sloptimize/ files. attach.mjs drives it over a raw WebSocket;
// sloptimize/electron drives it over webContents.debugger. Same records,
// same files, same cluster identity either way.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintSession } from './cloud-sink.js';
import { createRunFold } from './runs.js';

/** M-A1 — incident identity. One CAUSE investigates once: cluster key is the
 *  classification plus the top attributed frame (or creation-stack head);
 *  repeats increment a count instead of re-waking anyone. */
export function clusterKey(rec, topFrame) {
  const guess = rec.classification && rec.classification[0] ? rec.classification[0].guess : rec.type;
  return `${guess}|${topFrame ?? ''}`;
}

/** Top self-time frames from a CDP Profiler.stop payload, idle/program
 *  filtered, heaviest first. Pure — unit-tested against a fixture. */
export function topFramesFromProfile(profile, limit = 5) {
  if (!profile || !profile.nodes) return [];
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const us = deltas[i] ?? 0;
    self.set(samples[i], (self.get(samples[i]) ?? 0) + us);
  }
  const rows = [];
  for (const [id, us] of self) {
    const n = byId.get(id);
    if (!n) continue;
    const f = n.callFrame ?? {};
    if (f.functionName === '(idle)' || f.functionName === '(program)' || f.functionName === '(garbage collector)') continue;
    rows.push({
      fn: f.functionName || '(anonymous)',
      url: f.url ? `${f.url.split('/').slice(-1)[0]}:${(f.lineNumber ?? 0) + 1}` : '',
      selfMs: +(us / 1000).toFixed(1),
    });
  }
  rows.sort((a, b) => b.selfMs - a.selfMs);
  return rows.slice(0, limit);
}

/** Where a chunk's sampled time went apart from named JS: V8's collector,
 *  `(program)` (native work — layout, GPU sync, compiles, the embedder) and
 *  idle. A stall the JS rows cannot explain is usually in one of these, and
 *  topFramesFromProfile drops all three. ms, one decimal. */
export function sampledBreakdown(profile) {
  if (!profile || !profile.nodes) return undefined;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const out = { jsMs: 0, gcMs: 0, programMs: 0, idleMs: 0 };
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const name = byId.get(samples[i])?.callFrame?.functionName;
    const k = name === '(idle)' ? 'idleMs' : name === '(program)' ? 'programMs' : name === '(garbage collector)' ? 'gcMs' : 'jsMs';
    out[k] += (deltas[i] ?? 0) / 1000;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(1);
  return out;
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
// What the gate drops is COUNTED, never silent: a skipped hitch carries
// `unattributed: 'below-floor' | 'cooldown'` and the next minted record
// carries `skippedSinceLast`. Detection itself is untouched — every hitch
// the page emits lands in perf.jsonl.
export const SAMPLING_INTERVAL_US = 10_000;
export const ATTRIBUTE_FLOOR_MS = 80;
export const ATTRIBUTE_COOLDOWN_MS = 1000;
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
  run?.setConditions(conditions);
  function writeConditions() {
    run?.setConditions(conditions);
    const rec = { type: 'conditions', at: new Date(now()).toISOString(), tier: 0, conditions };
    appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(stamp(rec)) + '\n');
  }
  const runPath = join(dir, 'runs', `${session.replace(/[^\w.-]/g, '_')}.json`);
  let pagePhase, runWrittenAt = -Infinity;
  function foldChunk(profile) {
    if (!run || !profile) return;
    run.addProfile(profile, pagePhase, now());
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

  function arm() {
    disarm();
    if (!(windowMs > 0)) return;
    windowTimer = setT(() => { windowTimer = null; return onRoll(); }, windowMs);
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
        const [line, col] = pos(r.startOffset), [endLine] = pos(Math.max(r.startOffset, r.endOffset - 1));
        fns.push([f.functionName || '', line, col, endLine, r.count, r.endOffset - r.startOffset]);
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

  async function start() {
    if (coverage) { await startCoverage(); return; }
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
    await send('Profiler.start');
    profiling = true;
    arm();
  }
  async function stop() {
    disarm();
    if (coverage && !coverageTaken) { coverageTaken = true; await writeCoverage(); }
    if (!profiling) { writeRun(true); return; }
    profiling = false;
    try { const { profile } = await send('Profiler.stop') ?? {}; foldChunk(profile); } catch { /* target gone */ }
    writeRun(true);
  }
  /** Stop/start the sampler; the chunk that ended. Re-arms the window: it
   *  measures UNREAD time. */
  async function rotateProfile() {
    if (!profiling) return null;
    try {
      const { profile } = await send('Profiler.stop');
      await send('Profiler.start');
      arm();
      foldChunk(profile);
      return profile;
    } catch { return null; }
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
    if (typeof rec.phase === 'string') pagePhase = rec.phase;
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
      const gated = !(rec.frameMs >= floorMs) ? 'below-floor'
        : t - lastRotateAt < cooldownMs ? 'cooldown' : null;
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
      rec.topFrames = topFramesFromProfile(profile);
      rec.profileWindow = 'rolling-chunk';
      if (skippedSinceLast > 0) { rec.skippedSinceLast = skippedSinceLast; skippedSinceLast = 0; }
      // Each frame's self time as a share of THIS frame (header: share). The
      // chunk spans more than the frame, so a share is an upper bound on
      // what that function could explain — which is the direction that
      // matters for refusing to name it.
      if (rec.frameMs > 0) for (const f of rec.topFrames) f.share = +(f.selfMs / rec.frameMs).toFixed(3);
      const sampled = sampledBreakdown(profile);
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
    appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
    if (rec.type === 'armed') log(`recorder armed in page: ${rec.url}`);
  }

  return { onRecord, onEvent, clusters, start, stop, get regime() { return regime; }, conditions, session, build };
}
