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

/**
 * @param {object} opts
 * @param {string} opts.dir            .sloptimize/ directory (created)
 * @param {(method:string, params?:object)=>Promise<any>} opts.send  CDP call
 * @param {string} [opts.regime]       'hardware' | 'software' | 'unknown' — stamped on profile.json
 * @param {(...a:any[])=>void} [opts.log]
 * @param {(rec:object, key:string)=>void|Promise<void>} [opts.onNewCluster]
 *   Called once per NEW cause, before the record is written — a hook may
 *   stamp fields on `rec` (the Electron trace path does).
 */
export function createIncidentPipeline(opts) {
  const dir = opts.dir ?? '.sloptimize';
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  const send = opts.send;
  const regime = opts.regime ?? 'unknown';
  if (typeof send !== 'function') throw new Error('createIncidentPipeline: send is required');
  mkdirSync(dir, { recursive: true });

  const clusters = new Map();   // key → {count, firstAt, lastAt, sample}
  let lastCreateStackHead = null;
  let profiling = false;

  async function start() {
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 500 });
    await send('Profiler.start');
    profiling = true;
  }
  async function stop() {
    if (!profiling) return;
    profiling = false;
    try { await send('Profiler.stop'); } catch { /* target gone */ }
  }
  async function rotateProfile() {
    if (!profiling) return null;
    try {
      const { profile } = await send('Profiler.stop');
      await send('Profiler.start');
      return profile;
    } catch { return null; }
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
      // Attribute: grab the current profiler chunk and take the heaviest
      // frames. The chunk spans up to the rotation window, so a freeze that
      // dominated its window names itself; the caveat rides the record.
      const profile = await rotateProfile();
      rec.topFrames = topFramesFromProfile(profile);
      rec.profileWindow = 'rolling-chunk';
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
