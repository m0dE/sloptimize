// ============================================================
// profiler.js — the V8 sampling profiler over node:inspector (SPEC cloud §8.3)
// ============================================================
// The V8 sampling profiler over the inspector protocol: started once, read
// on demand. take() returns the top self-time frames since the last take and
// restarts the sampler — the same "rolling window" attach.mjs uses in the
// browser, here for the game server's own event loop.

/** Pure fold of a Profiler.stop() result's `.profile` into the top 5
 *  self-time frames as `{ file, fn, selfMs }`, keyed by (url, functionName).
 *  Runtime/VM bookkeeping frames (root/program/gc/idle with no url) are
 *  dropped, and any frame whose url contains `excludeUrl` (the profiler's
 *  own module) is dropped so the recorder never attributes its own cost. */
export function foldProfile(profile, excludeUrl) {
  const byId = new Map((profile?.nodes ?? []).map((n) => [n.id, n]));
  const selfUs = new Map();
  const samples = profile?.samples ?? [], deltas = profile?.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); if (!n) continue;
    const { functionName, url } = n.callFrame;
    if (!url && /^\((root|program|garbage collector|idle)\)$/.test(functionName)) continue;
    if (excludeUrl && url.includes(excludeUrl)) continue;
    const key = `${url} ${functionName}`;
    selfUs.set(key, (selfUs.get(key) ?? 0) + (deltas[i] ?? 0));
  }
  return [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => {
    const [url, fn] = k.split(' ');
    return { file: url.replace(/^file:\/\//, ''), fn: fn || 'anonymous', selfMs: Math.round(us / 1000) };
  });
}

/** Wraps an inspector Session (real or injected) in start/take/stop. `take()`
 *  stops the sampler, folds the profile, and immediately restarts it so the
 *  window is continuous. Never throws into the host — callers treat a
 *  rejected/absent profiler the same as attribution being off. */
export async function createProfiler(opts = {}) {
  const session = opts.session ?? new (await import('node:inspector')).Session();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  let running = false;
  return {
    async start() {
      if (running) return;
      session.connect?.();
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: opts.intervalUs ?? 1000 });
      await post('Profiler.start');
      running = true;
    },
    async take() {
      if (!running) return [];
      const { profile } = await post('Profiler.stop');
      await post('Profiler.start');
      return foldProfile(profile, '/sloptimize/src/node/');
    },
    async stop() {
      if (!running) return;
      running = false;
      try { await post('Profiler.stop'); await post('Profiler.disable'); } catch { /* already gone */ }
    },
  };
}
