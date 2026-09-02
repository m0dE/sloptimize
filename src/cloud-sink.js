// ============================================================
// cloud-sink.js — ship records to sloptimize cloud (SPEC cloud §8.2)
// ============================================================
// Runs BESIDE the file sink, never instead of it. Drains every source on a
// timer, posts batches with the publishable key, backs off on 429/5xx, caps
// its queue, and tells the service how many it had to drop locally so the
// dashboard's "dropped" column is honest. Never throws into the host.
const BACKOFF_MS = [5000, 30000, 120000, 300000];

export function createCloudSink(opts = {}) {
  if (!opts.key) throw new Error('createCloudSink: key is required');
  if (!opts.endpoint) throw new Error('createCloudSink: endpoint is required');
  const { key, endpoint, build } = opts;
  const sources = opts.sources ?? [];
  const flushMs = opts.flushMs ?? 5000, maxBatch = opts.maxBatch ?? 100, maxQueue = opts.maxQueue ?? 500;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const beacon = opts.sendBeacon ?? (typeof navigator !== 'undefined' && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null);
  const target = opts.target ?? globalThis;
  const setI = opts.setInterval ?? globalThis.setInterval, clearI = opts.clearInterval ?? globalThis.clearInterval;
  const now = opts.now ?? (() => Date.now());

  let queue = [];
  let droppedLocally = 0;
  let failures = 0, backoffUntil = 0, inflight = false;
  const stats = { sent: 0, lastError: null, lastStatus: null };

  function trim() {
    if (queue.length > maxQueue) { droppedLocally += queue.length - maxQueue; queue = queue.slice(queue.length - maxQueue); }
  }
  function drain() {
    for (const s of sources) {
      let r; try { r = s.drainRecords(); } catch { continue; }
      if (r && r.length) queue.push(...r);
    }
    trim();
  }
  function body(records) {
    const b = { records };
    if (build) b.build = build;
    if (droppedLocally) b.droppedLocally = droppedLocally;
    return b;
  }
  async function flush() {
    drain();
    if (inflight || queue.length === 0 || now() < backoffUntil) return;
    inflight = true;
    const batch = queue.slice(0, maxBatch);
    const sentDropped = droppedLocally;
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body(batch)),
      });
      stats.lastStatus = res.status;
      if (res.ok) {
        queue = queue.slice(batch.length);
        droppedLocally -= sentDropped;
        failures = 0; backoffUntil = 0; stats.sent += batch.length; stats.lastError = null;
      } else if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        backoffUntil = now() + (Number.isFinite(ra) && ra > 0 ? Math.max(ra * 1000, wait) : wait);
        failures++;
        stats.lastError = `HTTP ${res.status}`;
      } else {
        // 4xx other than 429: the batch is unacceptable; drop it rather than retry forever.
        queue = queue.slice(batch.length);
        droppedLocally += batch.length;
        stats.lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      stats.lastError = e?.message ?? String(e);
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      backoffUntil = now() + wait; failures++;
    } finally { inflight = false; }
  }
  function onHide() {
    try {
      drain();
      if (queue.length === 0 || !beacon) return;
      const batch = queue.slice(0, maxBatch);
      const ok = beacon(`${endpoint}?key=${encodeURIComponent(key)}`, new Blob([JSON.stringify(body(batch))], { type: 'application/json' }));
      if (ok) { queue = queue.slice(batch.length); droppedLocally = 0; stats.sent += batch.length; }
    } catch { /* never throw into the host */ }
  }
  const timer = setI(() => { flush(); }, flushMs);
  target.addEventListener?.('pagehide', onHide);
  const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onHide(); };
  target.addEventListener?.('visibilitychange', onVis);
  return {
    flush,
    enqueue(records) {
      if (records && records.length) queue.push(...records);
      trim();
    },
    stats() { return { queued: queue.length, sent: stats.sent, droppedLocally, backoffUntil, lastError: stats.lastError, lastStatus: stats.lastStatus }; },
    dispose() { clearI(timer); target.removeEventListener?.('pagehide', onHide); target.removeEventListener?.('visibilitychange', onVis); },
  };
}
