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
  // The Fetch spec caps a keepalive body at 64 KiB and sendBeacon has a limit
  // of its own, so a batch is bounded by bytes as well as by count.
  const maxBatchBytes = opts.maxBatchBytes ?? 60 * 1024;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const beacon = opts.sendBeacon ?? (typeof navigator !== 'undefined' && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null);
  const target = opts.target ?? globalThis;
  const setI = opts.setInterval ?? globalThis.setInterval, clearI = opts.clearInterval ?? globalThis.clearInterval;
  const now = opts.now ?? (() => Date.now());

  // THE SESSION (cloud §1.4): one id per sink, minted once, stamped on every
  // record that lacks one. A sink lives as long as its page, so the id names a
  // tab's lifetime — the unit the service's Sessions view lists — without the
  // host threading anything through. 12 base-62 chars: no two tabs collide.
  const session = typeof opts.session === 'string' && opts.session ? opts.session : mintSession();
  let queue = [];
  let droppedLocally = 0;
  let failures = 0, backoffUntil = 0, inflight = false;
  const stats = { sent: 0, lastError: null, lastStatus: null };

  function trim() {
    if (queue.length > maxQueue) { droppedLocally += queue.length - maxQueue; queue = queue.slice(queue.length - maxQueue); }
  }
  function stamp(records) {
    for (const r of records) if (r && typeof r === 'object' && r.session === undefined) r.session = session;
    return records;
  }
  function drain() {
    for (const s of sources) {
      let r; try { r = s.drainRecords(); } catch { continue; }
      if (r && r.length) queue.push(...stamp(r));
    }
    trim();
  }
  function body(records) {
    const b = { records };
    if (build) b.build = build;
    if (droppedLocally) b.droppedLocally = droppedLocally;
    return b;
  }
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const byteLen = (s) => (encoder ? encoder.encode(s).length : s.length);
  /** How many of the queue's leading records fit in one body under
   *  `maxBatchBytes`. A single record too large to ever fit is DROPPED and
   *  counted, never retried: re-prepending it would wedge the sink forever,
   *  and a silent wedge is the one failure this sink must not have. */
  function fitCount() {
    let envelope = byteLen(JSON.stringify(body([])));
    let total = envelope, n = 0;
    while (n < queue.length && n < maxBatch) {
      const size = byteLen(JSON.stringify(queue[n])) + (n > 0 ? 1 : 0);   // +1 for the comma
      if (total + size > maxBatchBytes) {
        if (n > 0) break;
        queue.shift();
        droppedLocally++;
        stats.lastError = `record dropped: ${size} bytes over maxBatchBytes (${maxBatchBytes})`;
        envelope = byteLen(JSON.stringify(body([])));   // droppedLocally just grew
        total = envelope;
        continue;
      }
      total += size; n++;
    }
    return n;
  }
  async function flush() {
    drain();
    if (inflight || queue.length === 0 || now() < backoffUntil) return;
    inflight = true;
    // Remove the batch from the queue BEFORE sending, not after the await:
    // otherwise a concurrent onHide()/enqueue() during the in-flight request
    // sees records that are already (or about to be) accounted for elsewhere,
    // causing duplicate delivery or silently corrupting the queue.
    const errBefore = stats.lastError;
    const n = fitCount();
    // A success clears transport errors, but must not erase the report of a
    // record this sink itself had to throw away in the same pass.
    const droppedThisPass = stats.lastError !== errBefore;
    if (n === 0) { inflight = false; return; }   // everything queued was oversized
    const batch = queue.splice(0, n);
    const sentDropped = droppedLocally;
    try {
      // No `keepalive` here: it caps the body at 64 KiB in browsers, and the
      // unload path already uses sendBeacon. This is the periodic flush.
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body(batch)),
      });
      stats.lastStatus = res.status;
      if (res.ok) {
        droppedLocally = Math.max(0, droppedLocally - sentDropped);
        failures = 0; backoffUntil = 0; stats.sent += batch.length; if (!droppedThisPass) stats.lastError = null;
      } else if (res.status === 429 || res.status >= 500) {
        // Retryable: put the batch back at the front (it's the oldest data)
        // and re-apply the cap, counting any resulting drops.
        queue = batch.concat(queue);
        trim();
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        backoffUntil = now() + (Number.isFinite(ra) && ra > 0 ? Math.max(ra * 1000, wait) : wait);
        failures++;
        stats.lastError = `HTTP ${res.status}`;
      } else {
        // 4xx other than 429: the batch is unacceptable and already out of
        // the queue (spliced above); drop it rather than retry forever.
        droppedLocally += batch.length;
        stats.lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      // Network failure: the batch never left, so put it back and retry later.
      queue = batch.concat(queue);
      trim();
      stats.lastError = e?.message ?? String(e);
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      backoffUntil = now() + wait; failures++;
    } finally { inflight = false; }
  }
  function onHide() {
    try {
      drain();
      if (queue.length === 0 || !beacon) return;
      // Any batch currently in flight via flush() was already spliced out of
      // `queue`, so what's here is guaranteed disjoint from it — no duplicate
      // delivery risk.
      const n = fitCount();
      if (n === 0) return;
      const batch = queue.slice(0, n);
      const beaconedDropped = droppedLocally;
      const ok = beacon(`${endpoint}?key=${encodeURIComponent(key)}`, new Blob([JSON.stringify(body(batch))], { type: 'application/json' }));
      if (ok) { queue = queue.slice(batch.length); droppedLocally = Math.max(0, droppedLocally - beaconedDropped); stats.sent += batch.length; }
    } catch { /* never throw into the host */ }
  }
  const timer = setI(() => { flush(); }, flushMs);
  // Never keep a game server's (or any Node host's) event loop alive just
  // to poll for records — this sink runs beside the host's own liveness,
  // not instead of it. A browser's setInterval returns a number, so the
  // optional chaining below is a no-op there.
  timer?.unref?.();
  target.addEventListener?.('pagehide', onHide);
  const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onHide(); };
  target.addEventListener?.('visibilitychange', onVis);
  return {
    flush,
    enqueue(records) {
      // A host tee that hands over something other than an array is a wiring
      // bug in the host, not a reason to throw into its drain loop.
      if (!Array.isArray(records)) { stats.lastError = 'enqueue: expected an array of records'; return; }
      if (records.length) queue.push(...stamp(records));
      trim();
    },
    /** The id every record of this sink is stamped with. */
    session: () => session,
    stats() { return { queued: queue.length, sent: stats.sent, droppedLocally, backoffUntil, lastError: stats.lastError, lastStatus: stats.lastStatus }; },
    dispose() { clearI(timer); target.removeEventListener?.('pagehide', onHide); target.removeEventListener?.('visibilitychange', onVis); },
  };
}

const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function mintSession() {
  const bytes = new Uint8Array(12);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += SESSION_ALPHABET[b % 62];
  return s;
}
