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
// What the gate drops is COUNTED, never silent: a skipped hitch carries
// `unattributed: 'below-floor' | 'cooldown'` and the next minted record
// carries `skippedSinceLast`. Detection itself is untouched — every hitch
// the page emits lands in perf.jsonl.
export const SAMPLING_INTERVAL_US = 10_000;
export const ATTRIBUTE_FLOOR_MS = 80;
export const ATTRIBUTE_COOLDOWN_MS = 1000;
export const PROFILE_WINDOW_MS = 10_000;

/**
 * @param {object} opts
 * @param {string} opts.dir            .sloptimize/ directory (created)
 * @param {(method:string, params?:object)=>Promise<any>} opts.send  CDP call
 * @param {string} [opts.regime]       'hardware' | 'software' | 'unknown' — stamped on profile.json
 * @param {(...a:any[])=>void} [opts.log]
 * @param {(rec:object, key:string)=>void|Promise<void>} [opts.onNewCluster]
 *   Called once per NEW cause, before the record is written — a hook may
 *   stamp fields on `rec` (the Electron trace path does).
 * @param {number} [opts.samplingIntervalUs]  see the header; default 10 000
 * @param {number} [opts.attributeFloorMs]    default 80
 * @param {number} [opts.attributeCooldownMs] default 1000, in page time (`rec.at`)
 * @param {number} [opts.windowMs]            default 10 000; 0 disables the roll
 * @param {()=>number} [opts.now]             wall clock, for records without an `at`
 * @param {Function} [opts.setTimeout] @param {Function} [opts.clearTimeout]  injectable for tests
 */
export function createIncidentPipeline(opts) {
  const dir = opts.dir ?? '.sloptimize';
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  const send = opts.send;
  const regime = opts.regime ?? 'unknown';
  if (typeof send !== 'function') throw new Error('createIncidentPipeline: send is required');
  const samplingIntervalUs = opts.samplingIntervalUs ?? SAMPLING_INTERVAL_US;
  const floorMs = opts.attributeFloorMs ?? ATTRIBUTE_FLOOR_MS;
  const cooldownMs = opts.attributeCooldownMs ?? ATTRIBUTE_COOLDOWN_MS;
  const windowMs = opts.windowMs ?? PROFILE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeout ?? setTimeout, clearT = opts.clearTimeout ?? clearTimeout;
  mkdirSync(dir, { recursive: true });

  const clusters = new Map();   // key → {count, firstAt, lastAt, sample}
  let lastCreateStackHead = null;
  let profiling = false;
  let lastRotateAt = -Infinity;  // page time of the last attributing rotation
  let skippedSinceLast = 0;      // hitches the gate left unattributed since then
  let windowTimer = null;

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

  async function start() {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: samplingIntervalUs });
    await send('Profiler.start');
    profiling = true;
    arm();
  }
  async function stop() {
    disarm();
    if (!profiling) return;
    profiling = false;
    try { await send('Profiler.stop'); } catch { /* target gone */ }
  }
  /** Stop/start the sampler; the chunk that ended. Re-arms the window: it
   *  measures UNREAD time. */
  async function rotateProfile() {
    if (!profiling) return null;
    try {
      const { profile } = await send('Profiler.stop');
      await send('Profiler.start');
      arm();
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
    if (rec.type === 'gpu-create') {
      lastCreateStackHead = (rec.stack || '').split('\n')[0]?.trim() ?? null;
      appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify(rec) + '\n');
      return;
    }
    if (rec.type === 'profile') {
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
      const guess = rec.classification?.[0]?.guess;
      const top = guess === 'shader-compile' ? lastCreateStackHead
        : rec.topFrames[0] ? `${rec.topFrames[0].fn}@${rec.topFrames[0].url}` : null;
      let key = clusterKey(rec, top);
      // MERGE before minting (M-A1): if any existing cluster's identifying
      // frame appears anywhere in this hitch's top frames, this is the same
      // cause seen from a different leaf — V8 inlining moves the hot function
      // into its caller between occurrences (measured on the exit fixture:
      // freeze #1 named seededFreezeWork, freeze #2 arrived as its caller).
      // Inlining that erases the frame ENTIRELY still splits a cause in two;
      // stated in the spec as a standing limit, not papered over.
      if (!clusters.has(key)) {
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

  return { onRecord, clusters, start, stop, regime };
}
