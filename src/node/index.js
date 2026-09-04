// ============================================================
// sloptimize/node — the game server's recorder (SPEC cloud §8.3)
// ============================================================
// Three signals, one ledger: a tick the host timed that overran its budget
// (server-hitch), an event-loop stall the runtime saw on its own
// (server-stall), and an uncaught error (error, source: server). Each is
// attributed by the V8 sampler's top self-time frames, and shipped with the
// same cloud sink the browser uses. Nothing here changes how the process
// dies: only uncaughtExceptionMonitor is registered — never uncaughtException
// or unhandledRejection, which would turn this recorder into part of the
// crash path itself.
import { createCloudSink } from '../cloud-sink.js';
import { canonicalContext } from '../footprint.js';
// Static import: monitorEventLoopDelay() is synchronous and cheap, and
// createServerRuntime() must itself stay synchronous (callers do not await
// it), so this cannot be a dynamic `await import('node:perf_hooks')`.
import { monitorEventLoopDelay } from 'node:perf_hooks';

export function createServerRuntime(opts = {}) {
  if (!opts.key) throw new Error('createServerRuntime: key is required');
  if (!opts.endpoint) throw new Error('createServerRuntime: endpoint is required');
  const tickBudgetMs = opts.tickBudgetMs ?? 16, stallMs = opts.stallMs ?? 50;
  const phaseFn = opts.phase ?? (() => undefined), ctxFn = opts.context ?? (() => undefined);
  const now = opts.now ?? (() => Date.now());
  const proc = opts.process ?? process;
  const setI = opts.setInterval ?? setInterval, clearI = opts.clearInterval ?? clearInterval;
  const profileOn = opts.profile !== false;
  let closed = false;

  const pending = [];
  const source = { drainRecords() { return pending.splice(0, pending.length); } };
  // A server process is not a session (cloud §1.4): no session stamp on its records.
  const sink = createCloudSink({
    key: opts.key, endpoint: opts.endpoint, build: opts.build, sources: [source], flushMs: opts.flushMs ?? 5000, session: false,
    fetch: opts.fetch, sendBeacon: null, target: { addEventListener() {}, removeEventListener() {} }, setInterval: setI, clearInterval: clearI, now,
  });

  const stats = { hitches: 0, stalls: 0, errors: 0, droppedByRate: 0, hostErrors: 0 };
  let lastHitchAt = -Infinity, lastStallAt = -Infinity;

  // The profiler: injectable for tests (never touches node:inspector), or
  // lazily imported for real use so the fake-profiler test path never loads
  // the inspector module. `closed` is re-checked once the import (and the
  // inspector session it builds) resolves, so a close() that races the lazy
  // init stops the profiler instead of starting a session nobody will ever
  // stop.
  let profiler = opts.profiler ?? null;
  let profilerReady = profileOn && profiler ? Promise.resolve(profiler.start()) : null;
  if (profileOn && !profiler) {
    profilerReady = import('./profiler.js')
      .then(async (m) => {
        if (closed) return;
        const p = await m.createProfiler();
        if (closed) { await p.stop?.(); return; }
        profiler = p;
        await profiler.start();
      })
      .catch((e) => { stats.profilerError = e?.message; profiler = null; });
  }
  async function frames() {
    if (!profileOn) return { frames: [], attribution: 'off' };
    try {
      // Wait for the (possibly still-lazily-importing) profiler before
      // deciding attribution is unavailable — otherwise every hitch/stall
      // during startup is permanently recorded as attribution: 'off' even
      // though the real profiler comes up moments later.
      await profilerReady;
      if (!profiler) return { frames: [], attribution: 'off' };
      return { frames: await profiler.take(), attribution: 'profiler' };
    } catch { return { frames: [], attribution: 'off' }; }
  }
  // Host-supplied phase()/context() callbacks run on every record; a
  // throwing one must never break the record (or crash a bare setInterval
  // callback) — it just leaves that field unset, counted in hostErrors.
  function stamp(rec) {
    try { const p = phaseFn(); if (p) rec.phase = p; } catch { stats.hostErrors++; }
    try { const c = ctxFn(); if (c) rec.ctx = typeof c === 'string' ? c : canonicalContext(c); } catch { stats.hostErrors++; }
    rec.at = new Date().toISOString();
    return rec;
  }
  function pushAsync(rec, withFrames) {
    // After close() the sink is disposed and nothing will ever drain `pending`
    // again: a frame promise that resolves later must not grow it forever.
    if (closed) return;
    if (!withFrames) { pending.push(rec); return; }
    frames().then((f) => {
      if (closed) return;
      rec.frames = f.frames; rec.attribution = f.attribution; pending.push(rec);
    });
  }

  function endTick(startMs) {
    try {
      const tickMs = now() - startMs;
      if (tickMs <= tickBudgetMs) return;
      const t = now();
      if (t - lastHitchAt < 1000) { stats.droppedByRate++; return; }
      lastHitchAt = t; stats.hitches++;
      const rec = stamp({ type: 'server-hitch', tickMs: +tickMs.toFixed(2), budgetMs: tickBudgetMs, frames: [], attribution: 'off' });
      pushAsync(rec, profileOn);
    } catch { stats.hostErrors++; }
  }

  // Event-loop delay: sampled every second, an incident when p99 crosses
  // stallMs, rate-limited to one record per 5s.
  const monitor = opts.monitor ?? monitorEventLoopDelay({ resolution: 20 });
  monitor?.enable?.();
  const sampler = setI(() => {
    try {
      if (!monitor) return;
      const p99 = monitor.percentiles.get(99) / 1e6, p50 = monitor.percentiles.get(50) / 1e6, max = monitor.max / 1e6;
      monitor.reset();
      if (!(p99 > stallMs)) return;
      const t = now();
      if (t - lastStallAt < 5000) { stats.droppedByRate++; return; }
      lastStallAt = t; stats.stalls++;
      const rec = stamp({ type: 'server-stall', p50Ms: +p50.toFixed(1), p99Ms: +p99.toFixed(1), maxMs: +max.toFixed(1), frames: [], attribution: 'off' });
      pushAsync(rec, profileOn);
    } catch { stats.hostErrors++; }
  }, 1000);
  sampler?.unref?.();

  const onUncaught = (err) => {
    try {
      stats.errors++;
      const e = err instanceof Error ? err : new Error(String(err));
      const stack = String(e.stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, 10);
      pending.push(stamp({ type: 'error', source: 'server', name: e.name || 'Error', message: e.message, stack }));
    } catch { /* never throw from a monitor */ }
  };
  proc.on('uncaughtExceptionMonitor', onUncaught);
  // The watchdog timer must be unref'd too: Promise.race never cancels its
  // losing arm, so a plain setTimeout here would itself become a handle
  // that keeps a real host's event loop alive for up to 2s on every exit
  // attempt (and, since that can make the loop look non-empty again,
  // potentially re-trigger beforeExit indefinitely).
  const onBeforeExit = () => {
    Promise.race([sink.flush(), new Promise((r) => { const t = setTimeout(r, 2000); t?.unref?.(); })]).catch(() => {});
  };
  proc.on('beforeExit', onBeforeExit);

  return {
    tick(fn) { const s = now(); try { return fn(); } finally { endTick(s); } },
    beginTick() { return now(); },
    endTick,
    mark(label, meta = {}) {
      try { pending.push(stamp({ type: 'usermark', label, ...meta })); } catch { stats.hostErrors++; }
    },
    // Awaits one macrotask before draining the sink so that pushAsync's
    // frame promise (resolved on a microtask, even for a synchronous fake
    // profiler) has already landed its record in `pending`.
    async flush() { await new Promise((r) => setTimeout(r, 0)); await sink.flush(); },
    stats() { return { ...stats, sink: sink.stats() }; },
    async close() {
      closed = true;
      clearI(sampler);
      monitor?.disable?.();
      proc.off?.('uncaughtExceptionMonitor', onUncaught);
      proc.off?.('beforeExit', onBeforeExit);
      await profiler?.stop?.();
      await sink.flush();
      sink.dispose();
    },
  };
}
