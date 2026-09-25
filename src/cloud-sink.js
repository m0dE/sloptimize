// ============================================================
// cloud-sink.js — ship records to sloptimize cloud (SPEC cloud §8.2)
// ============================================================
// Runs BESIDE the file sink, never instead of it. Drains every source on a
// timer, posts batches with the publishable key, backs off on 429/5xx, caps
// its queue, and tells the service how many it had to drop locally so the
// dashboard's "dropped" column is honest. Never throws into the host.
//
// THE CAP (cloud rulings 32/34): a project's daily cap and an account's
// monthly quota bind INCIDENTS only. The series (`heartbeat`) and a page's exit
// (`page-exit`) are never quota — they are what says a tab is alive and how it
// ended, and they must keep flowing when the incidents cannot. So a cap answer
// (a 202 that says `capped`, or a 429 whose drops are all `cap`) puts the sink
// in CAPPED mode until the answer's Retry-After: incidents are shed as they
// come (counted in `capped`, never re-sent — the service refused them, and a
// retry would only be refused again), and everything else keeps posting. The
// refused batch's incidents are shed with it rather than parked at the head of
// the queue, where they would hold every later beat back until the reset.
//
// THE DEVICE (cloud ruling 36): a sink with a session files one `device`
// record when it is created — the browser's own facts (device.js) merged with
// whatever the host passes as `device` — and a fresh one whenever the host
// calls `sink.device(facts)` with something that changed (a quality level
// picked, a renderer that resolved). `device: false` files none.
//
// PROFILES (cloud ruling 37): a host that samples its frame (SPEC §3.2b)
// posts a `profile` record every ~10 s to its local ledger. The cloud keeps
// one a minute per session: the sink forwards the first and then at most one
// per `profileEveryMs`, and counts the rest in `stats().profilesThinned` —
// thinned on purpose, never lost to a fault.
import { browserDevice, cleanDevice } from './device.js';

const BACKOFF_MS = [5000, 30000, 120000, 300000];
/** Records the cap never binds (cloud rulings 31/32/35/36/37). */
export const UNCAPPED_TYPES = Object.freeze(new Set(['heartbeat', 'page-exit', 'device', 'profile']));
/** How often a session's frame profile goes to the cloud (ruling 37). */
export const PROFILE_EVERY_MS = 60_000;
const isUncapped = (r) => !!r && UNCAPPED_TYPES.has(r.type);

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
  // `session: false` opts out — the server runtime's records are a process's, not a tab's.
  const session = opts.session === false ? null : typeof opts.session === 'string' && opts.session ? opts.session : mintSession();
  let queue = [];
  let droppedLocally = 0;
  let failures = 0, backoffUntil = 0, inflight = false;
  /** While now() < cappedUntil the service refuses incidents: shed them. */
  let cappedUntil = 0;
  const stats = { sent: 0, lastError: null, lastStatus: null, capped: 0, profilesThinned: 0 };
  const profileEveryMs = opts.profileEveryMs ?? PROFILE_EVERY_MS;
  let lastProfileAt = -Infinity;
  /** Profiles past the cadence are thinned here, before they take a queue slot. */
  function admit(records) {
    if (!records.some((r) => r?.type === 'profile')) return records;
    return records.filter((r) => {
      if (r?.type !== 'profile') return true;
      const t = now();
      if (t - lastProfileAt < profileEveryMs) { stats.profilesThinned++; return false; }
      lastProfileAt = t;
      return true;
    });
  }
  function shedCapped() {
    if (now() >= cappedUntil) return;
    const before = queue.length;
    queue = queue.filter(isUncapped);
    stats.capped += before - queue.length;
  }
  function enterCapped(retryAfterSec) {
    const wait = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : BACKOFF_MS[BACKOFF_MS.length - 1];
    cappedUntil = Math.max(cappedUntil, now() + wait);
  }

  function trim() {
    if (queue.length > maxQueue) { droppedLocally += queue.length - maxQueue; queue = queue.slice(queue.length - maxQueue); }
  }
  function stamp(records) {
    if (session === null) return records;
    for (const r of records) if (r && typeof r === 'object' && r.session === undefined) r.session = session;
    return records;
  }
  // A source may hold a record it has not decided yet (the recorder's open
  // hitch window); the unload drain is the last one, so it says so.
  const FINAL = Object.freeze({ final: true });
  function drain(final = false) {
    for (const s of sources) {
      let r; try { r = s.drainRecords(final ? FINAL : undefined); } catch { continue; }
      if (r && r.length) queue.push(...stamp(admit(r)));
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
    shedCapped();
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
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      if (res.ok) {
        droppedLocally = Math.max(0, droppedLocally - sentDropped);
        failures = 0; backoffUntil = 0; stats.sent += batch.length; if (!droppedThisPass) stats.lastError = null;
        // Read AFTER the batch is accounted: the answer only says whether the
        // service split it at the cap.
        const answer = res.status === 202 ? await readJson(res) : null;
        if (answer?.capped) {
          stats.capped += Array.isArray(answer.dropped) ? answer.dropped.filter((d) => d?.reason === 'cap').length : 0;
          enterCapped(Number.isFinite(Number(answer.retryAfter)) ? Number(answer.retryAfter) : retryAfter);
        }
      } else if (res.status === 429 && isCapRefusal(await readJson(res))) {
        // The cap, not the rate: shed the batch's incidents, keep its beats
        // and exits at the front, and post those at once — no backoff.
        const keep = batch.filter(isUncapped);
        stats.capped += batch.length - keep.length;
        queue = keep.concat(queue);
        trim();
        enterCapped(retryAfter);
        stats.lastError = 'HTTP 429 (cap)';
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
      drain(true);
      shedCapped();
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
  // The device record (ruling 36): only a session has one, and a host may opt out.
  const deviceOn = session !== null && opts.device !== false;
  let hostFacts = typeof opts.device === 'object' && opts.device !== null ? opts.device : {};
  let lastDevice = '';
  const readBrowser = opts.browserDevice ?? (() => browserDevice());
  function fileDevice(facts) {
    if (!deviceOn) return;
    try {
      if (facts && typeof facts === 'object') hostFacts = facts;
      const device = cleanDevice({ ...readBrowser(), ...hostFacts });
      const sig = JSON.stringify(device);
      if (sig === lastDevice) return;
      lastDevice = sig;
      queue.push(...stamp([{ type: 'device', at: new Date(now()).toISOString(), ...(build ? { build } : {}), device }]));
      trim();
    } catch { /* never throw into the host */ }
  }
  fileDevice();

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
      if (records.length) queue.push(...stamp(admit(records)));
      trim();
    },
    /** File the session's device again with the host's facts now (ruling 36): only when they
     *  differ from the last filed. The browser's facts are re-read too (a rotated phone). */
    device(facts) { fileDevice(facts); },
    /** The id every record of this sink is stamped with. */
    session: () => session,
    stats() { return { queued: queue.length, sent: stats.sent, droppedLocally, backoffUntil, cappedUntil, capped: stats.capped, profilesThinned: stats.profilesThinned, lastError: stats.lastError, lastStatus: stats.lastStatus }; },
    dispose() { clearI(timer); target.removeEventListener?.('pagehide', onHide); target.removeEventListener?.('visibilitychange', onVis); },
  };
}

async function readJson(res) {
  try { return typeof res.json === 'function' ? await res.json() : null; } catch { return null; }
}
/** A 429 that is the cap or the quota (every drop `cap`), not the rate limit. */
function isCapRefusal(answer) {
  return Array.isArray(answer?.dropped) && answer.dropped.length > 0 && answer.dropped.every((d) => d?.reason === 'cap');
}

const SESSION_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function mintSession() {
  const bytes = new Uint8Array(12);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const b of bytes) s += SESSION_ALPHABET[b % 62];
  return s;
}
