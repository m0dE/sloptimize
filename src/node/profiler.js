// ============================================================
// profiler.js — the V8 sampling profiler over node:inspector (SPEC cloud §8.3)
// ============================================================
// The V8 sampling profiler over the inspector protocol: started once, read
// on demand. take() returns the top self-time frames of the CURRENT WINDOW
// and restarts the sampler — the same "rolling window" attach.mjs uses in
// the browser, here for the game server's own event loop.
//
// The window is BOUNDED (`windowMs`, default 10 s). V8 keeps every sample of
// a running profile in memory until Profiler.stop, with no cap of its own —
// at the 1 ms interval a server that hits no hitch for hours (an idle lobby,
// a bots-only arena) grew its profile until the kernel's OOM killer took the
// arena process itself (mecharoyale 2026-09-05: 515 MB anon RSS, invoked from
// V8's ProfEvntProc thread, 20 h after arming). The same unbounded profile
// made each eventual take() serialize hours of samples through the inspector
// channel on the main thread — a stall the recorder then attributed to
// `node:inspector#post`, its own cost. So the sampler rolls itself over
// every `windowMs` when nothing has read it: the in-flight profile never holds
// more than one window, a take() folds only the frames leading up to the
// hitch that asked for them, and the stop/start pair stays cheap.

/** Pure fold of a Profiler.stop() result's `.profile` into the top 5
 *  self-time frames as `{ file, fn, selfMs }`, keyed by (url, functionName).
 *  Runtime/VM bookkeeping frames (root/program/gc/idle with no url) are
 *  dropped, and so is the recorder's own cost: any frame whose url contains
 *  `excludeUrl` (the profiler's module), and `node:inspector` itself — the
 *  window roll's Profiler.stop is parsed inside the inspector's `post`, and a
 *  hitch read right after a roll would otherwise name the sampler as its
 *  hottest frame (the `node:inspector#post` footprint the cloud showed). */
export function foldProfile(profile, excludeUrl) {
  const byId = new Map((profile?.nodes ?? []).map((n) => [n.id, n]));
  const selfUs = new Map();
  const samples = profile?.samples ?? [], deltas = profile?.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); if (!n) continue;
    const { functionName, url } = n.callFrame;
    if (!url && /^\((root|program|garbage collector|idle)\)$/.test(functionName)) continue;
    if (url === 'node:inspector') continue;
    if (excludeUrl && url.includes(excludeUrl)) continue;
    // NUL, not a space: getters fold as "get health" and real paths contain
    // spaces, both of which a space-separated key would split in the wrong place.
    const key = `${url}\u0000${functionName}`;
    selfUs.set(key, (selfUs.get(key) ?? 0) + (deltas[i] ?? 0));
  }
  return [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => {
    const [url, fn] = k.split('\u0000');
    return { file: url.replace(/^file:\/\//, ''), fn: fn || 'anonymous', selfMs: Math.round(us / 1000) };
  });
}

/** How long the sampler runs unread before it rolls itself over. */
export const DEFAULT_WINDOW_MS = 10_000;

/** Wraps an inspector Session (real or injected) in start/take/stop. `take()`
 *  stops the sampler, folds the profile, and immediately restarts it so the
 *  window is continuous; an unread window rolls over on its own after
 *  `windowMs` so the profile stays bounded (see the header). Never throws
 *  into the host — callers treat a rejected/absent profiler the same as
 *  attribution being off. Timers are injectable for tests and unref'd for
 *  real, so the sampler never keeps a host's event loop alive. */
export async function createProfiler(opts = {}) {
  const session = opts.session ?? new (await import('node:inspector')).Session();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const setT = opts.setTimeout ?? setTimeout, clearT = opts.clearTimeout ?? clearTimeout;
  let running = false, timer = null;
  // Every stop/start pair goes through one chain: a window roll firing while
  // a take() is mid-flight (or the reverse) must never post a second
  // Profiler.stop against a sampler the first one already stopped.
  let chain = Promise.resolve();
  const serial = (fn) => { const next = chain.then(fn, fn); chain = next.catch(() => {}); return next; };

  function arm() {
    if (timer !== null) clearT(timer);
    timer = setT(() => { timer = null; serial(roll).catch(() => {}); }, windowMs);
    timer?.unref?.();
  }
  function disarm() {
    if (timer !== null) clearT(timer);
    timer = null;
  }
  /** Stop the sampler, restart it, re-arm the window; the profile that ended. */
  async function restart() {
    const { profile } = await post('Profiler.stop');
    await post('Profiler.start');
    arm();
    return profile;
  }
  /** The window expired unread: its samples are of no use to anyone — drop them. */
  async function roll() {
    if (!running) return;
    await restart();
  }

  return {
    async start() {
      if (running) return;
      session.connect?.();
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: opts.intervalUs ?? 1000 });
      await post('Profiler.start');
      running = true;
      arm();
    },
    take() {
      return serial(async () => {
        if (!running) return [];
        return foldProfile(await restart(), '/sloptimize/src/node/');
      });
    },
    stop() {
      return serial(async () => {
        if (!running) return;
        running = false;
        disarm();
        try { await post('Profiler.stop'); await post('Profiler.disable'); } catch { /* already gone */ }
      });
    },
  };
}
