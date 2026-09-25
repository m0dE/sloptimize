import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSink } from '../src/cloud-sink.js';

function harness({ statuses = [], bodies = [] } = {}) {
  const calls = [];
  let t = 0;
  const timers = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers, keepalive: init.keepalive });
    const status = statuses.shift() ?? 202;
    const answer = bodies.shift() ?? { accepted: 1, dropped: [] };
    return { ok: status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && status === 429 ? '30' : null) }, json: async () => answer };
  };
  const beacons = [];
  const listeners = {};
  const target = { addEventListener: (k, f) => (listeners[k] ??= []).push(f), removeEventListener: (k, f) => { listeners[k] = (listeners[k] ?? []).filter((x) => x !== f); }, fire: (k, ev) => (listeners[k] ?? []).forEach((f) => f(ev)) };
  const source = { pending: [], drainRecords() { const r = this.pending; this.pending = []; return r; } };
  return {
    calls, beacons, target, source, now: () => t, tick: (ms) => { t += ms; },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {}, runTimers: () => timers.forEach((x) => x.fn()),
    fetch, sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; },
  };
}
// The device record (ruling 36) is its own test block below; everything else counts records
// without it.
const mk = (h, over = {}) => createCloudSink({ key: 'pk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'b1', sources: [h.source], fetch: h.fetch, sendBeacon: h.sendBeacon, target: h.target, setInterval: h.setInterval, clearInterval: h.clearInterval, now: h.now, device: false, ...over });

test('drains sources on the timer and posts a batch with the key and build', async () => {
  const h = harness();
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  h.runTimers();
  await sink.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.authorization, 'Bearer pk_live_x');
  assert.equal(h.calls[0].body.build, 'b1');
  assert.equal(h.calls[0].body.records.length, 1);
  assert.equal(sink.stats().sent, 1);
});

test('429 and 5xx back off 5s/30s/2m then every 5m; success resets', async () => {
  const h = harness({ statuses: [500, 500, 500, 500, 202] });
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();                          // 500 → backoff 5s
  assert.equal(sink.stats().backoffUntil, 5000);
  await sink.flush(); assert.equal(h.calls.length, 1);   // still backing off
  h.tick(5000); await sink.flush();            // 500 → 30s
  assert.equal(sink.stats().backoffUntil, 35000);
  h.tick(30000); await sink.flush();           // 500 → 2m
  assert.equal(sink.stats().backoffUntil, 155000);
  h.tick(120000); await sink.flush();          // 500 → 5m
  assert.equal(sink.stats().backoffUntil, 455000);
  h.tick(300000); await sink.flush();          // 202
  assert.equal(sink.stats().backoffUntil, 0);
  assert.equal(sink.stats().queued, 0);
});

test('queue cap drops oldest and reports droppedLocally on the next success', async () => {
  const h = harness({ statuses: [500, 202] });
  const sink = mk(h, { maxQueue: 3 });
  for (let i = 0; i < 5; i++) h.source.pending.push({ type: 'hitch', at: String(i) });
  await sink.flush();                          // fails; queue trimmed to 3 (2 dropped)
  assert.equal(sink.stats().droppedLocally, 2);
  h.tick(5000); await sink.flush();
  assert.equal(h.calls[1].body.droppedLocally, 2);
  assert.deepEqual(h.calls[1].body.records.map((r) => r.at), ['2', '3', '4']);
  assert.equal(sink.stats().droppedLocally, 0);
});

test('pagehide flushes via sendBeacon with the key in the query', () => {
  const h = harness();
  mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  h.target.fire('pagehide', {});
  assert.equal(h.beacons.length, 1);
  assert.equal(h.beacons[0].url, 'https://c.example/v1/ingest?key=pk_live_x');
});

test('the unload drain is FINAL — a source closes its open window; a periodic drain does not', async () => {
  const h = harness();
  const drains = [];
  h.source.drainRecords = function (opts) { drains.push(opts); const r = this.pending; this.pending = []; return r; };
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'a' });
  await sink.flush();
  h.source.pending.push({ type: 'hitch', at: 'b' });
  h.target.fire('pagehide', {});
  assert.deepEqual(drains, [undefined, { final: true }]);
});

test('fetch throwing never escapes; it lands in stats().lastError', async () => {
  const h = harness();
  const sink = mk(h, { fetch: async () => { throw new Error('offline'); } });
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();
  assert.equal(sink.stats().lastError, 'offline');
  assert.equal(sink.stats().queued, 1);
});

test('missing key or endpoint is a configuration error', () => {
  assert.throws(() => createCloudSink({ endpoint: 'x', sources: [] }), /key/);
  assert.throws(() => createCloudSink({ key: 'x', sources: [] }), /endpoint/);
});

test('enqueue pushes records into the queue and trims to maxQueue, counting drops', () => {
  const h = harness();
  const sink = mk(h, { maxQueue: 3 });
  sink.enqueue([{ type: 'hitch', at: '0' }, { type: 'hitch', at: '1' }]);
  assert.equal(sink.stats().queued, 2);
  sink.enqueue([{ type: 'hitch', at: '2' }, { type: 'hitch', at: '3' }]);
  assert.equal(sink.stats().queued, 3);
  assert.equal(sink.stats().droppedLocally, 1);
});

test('pagehide during an in-flight flush beacons only records not yet sent, and stats().sent stays accurate', async () => {
  const h = harness();
  let resolveFetch;
  const fetch = (url, init) => {
    h.calls.push({ url, body: JSON.parse(init.body), headers: init.headers, keepalive: init.keepalive });
    return new Promise((res) => { resolveFetch = res; });
  };
  const sink = mk(h, { fetch });
  h.source.pending.push({ type: 'hitch', at: 'a' }, { type: 'hitch', at: 'b' });
  const flushPromise = sink.flush(); // drains a,b and starts an in-flight POST (batch removed from queue)
  h.source.pending.push({ type: 'hitch', at: 'c' }); // arrives while a,b are still in flight
  h.target.fire('pagehide', {});
  assert.equal(h.beacons.length, 1);
  const beaconBody = JSON.parse(await h.beacons[0].blob.text());
  assert.deepEqual(beaconBody.records.map((r) => r.at), ['c']); // never re-sends a,b
  resolveFetch({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) });
  await flushPromise;
  assert.equal(sink.stats().sent, 3); // a,b from the flush + c from the beacon — no double count
  assert.equal(sink.stats().queued, 0);
});

test('enqueue during an in-flight flush is never silently lost, even under the queue cap (record identity)', async () => {
  const h = harness();
  let resolveFirst;
  let callCount = 0;
  const fetch = (url, init) => {
    h.calls.push({ url, body: JSON.parse(init.body) });
    callCount++;
    if (callCount === 1) return new Promise((res) => { resolveFirst = res; });
    return Promise.resolve({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) });
  };
  // maxQueue smaller than the in-flight batch, so a fixed-vs-broken splice
  // point actually changes which records survive the cap — not just a count.
  const sink = mk(h, { fetch, maxQueue: 2 });
  sink.enqueue([{ type: 'hitch', at: '0' }, { type: 'hitch', at: '1' }]);
  const flushPromise = sink.flush(); // batch [0,1] must leave `queue` immediately, before the await
  sink.enqueue([{ type: 'hitch', at: '2' }]);
  sink.enqueue([{ type: 'hitch', at: '3' }]);
  sink.enqueue([{ type: 'hitch', at: '4' }]); // cap (2) trims '2' — only '3','4' should survive
  resolveFirst({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) });
  await flushPromise;
  assert.deepEqual(h.calls[0].body.records.map((r) => r.at), ['0', '1']); // sent batch is exactly the pre-flush records
  assert.equal(sink.stats().sent, 2);
  assert.equal(sink.stats().droppedLocally, 1); // only '2' dropped by the cap, not '3' or '4'
  await sink.flush(); // nothing new to drain; whatever is left in queue goes out now
  assert.deepEqual(h.calls[1].body.records.map((r) => r.at), ['3', '4']); // exactly what survived, in order
  assert.equal(sink.stats().queued, 0);
});

test('a pagehide beacon and a concurrent flush success never double-subtract droppedLocally into negative', async () => {
  const h = harness();
  let resolveFetch;
  const fetch = (url, init) => {
    h.calls.push({ url, body: JSON.parse(init.body) });
    return new Promise((res) => { resolveFetch = res; });
  };
  const sink = mk(h, { fetch, maxQueue: 1 });
  sink.enqueue([{ type: 'hitch', at: 'a' }, { type: 'hitch', at: 'b' }]); // cap trims 'a' -> droppedLocally = 1
  assert.equal(sink.stats().droppedLocally, 1);
  const flushPromise = sink.flush(); // batch ['b'] spliced out and in flight; queue now []
  sink.enqueue([{ type: 'hitch', at: 'c' }]); // queue = ['c']; droppedLocally still 1
  h.target.fire('pagehide', {}); // beacons ['c'] carrying droppedLocally:1, then credits itself for that 1
  assert.equal(h.beacons.length, 1);
  resolveFetch({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) });
  await flushPromise; // flush() also tries to credit the same 1 it saw before onHide ran
  assert.equal(sink.stats().droppedLocally, 0);
  assert.ok(sink.stats().droppedLocally >= 0);
});

test('the flush timer is unref()d so it never keeps a Node host alive on its own', () => {
  const h = harness();
  let unrefCalls = 0;
  const setInterval_ = (fn, ms) => { h.timers ??= []; return { unref: () => { unrefCalls++; } }; };
  mk(h, { setInterval: setInterval_ });
  assert.equal(unrefCalls, 1);
});

test('a non-429 4xx drops the batch: counted, queue empty, no backoff', async () => {
  // 400 means the service will never accept this body. Retrying it forever
  // would wedge the sink behind data it cannot send.
  const h = harness({ statuses: [400] });
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: '0' }, { type: 'hitch', at: '1' });
  await sink.flush();
  const s = sink.stats();
  assert.equal(s.lastStatus, 400);
  assert.equal(s.lastError, 'HTTP 400');
  assert.equal(s.droppedLocally, 2);
  assert.equal(s.queued, 0);
  assert.equal(s.backoffUntil, 0);
  await sink.flush();
  assert.equal(h.calls.length, 1);   // nothing left to retry
});

test('429 honours Retry-After when it is longer than the backoff step', async () => {
  const h = harness({ statuses: [429] });
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: '0' });
  await sink.flush();
  // Retry-After: 30 vs the first backoff step (5s) — the longer wins.
  assert.equal(sink.stats().backoffUntil, Math.max(30 * 1000, 5000));
  assert.equal(sink.stats().lastError, 'HTTP 429');
  assert.equal(sink.stats().queued, 1);   // retryable: the batch went back
  await sink.flush();
  assert.equal(h.calls.length, 1);        // still backing off
});

test('the periodic flush sends no keepalive (it caps the body at 64 KiB)', async () => {
  const h = harness();
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();
  assert.equal(h.calls[0].keepalive, undefined);
});

test('a batch is split by bytes, not just by count', async () => {
  const h = harness();
  // envelope {"records":[],"build":"b1"} is 27 bytes; each record is 134 plus
  // the 25-byte session stamp = 159, so two fit under 350 and the third does not.
  const sink = mk(h, { maxBatchBytes: 350 });
  for (let i = 0; i < 3; i++) h.source.pending.push({ type: 'hitch', at: String(i), pad: 'a'.repeat(100) });
  await sink.flush();
  assert.deepEqual(h.calls[0].body.records.map((r) => r.at), ['0', '1']);
  assert.ok(JSON.stringify(h.calls[0].body).length <= 350);
  await sink.flush();
  assert.deepEqual(h.calls[1].body.records.map((r) => r.at), ['2']);
  assert.equal(sink.stats().queued, 0);
  assert.equal(sink.stats().droppedLocally, 0);
});

test('a single record over the byte budget is dropped and counted, never retried', async () => {
  const h = harness();
  const sink = mk(h, { maxBatchBytes: 300 });
  h.source.pending.push({ type: 'hitch', at: 'huge', pad: 'a'.repeat(5000) });
  await sink.flush();
  assert.equal(h.calls.length, 0);                 // nothing sendable
  assert.equal(sink.stats().queued, 0);            // and nothing left to wedge on
  assert.equal(sink.stats().droppedLocally, 1);
  assert.match(sink.stats().lastError, /maxBatchBytes/);
  assert.equal(sink.stats().backoffUntil, 0);
  await sink.flush();
  assert.equal(h.calls.length, 0);
  // The next ordinary record goes out, carrying the honest drop count.
  h.source.pending.push({ type: 'hitch', at: 'ok' });
  await sink.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.droppedLocally, 1);
  assert.equal(sink.stats().droppedLocally, 0);
});

test('the beacon path honours the byte budget too', async () => {
  // sendBeacon has its own body limit: the unload flush drops the oversized
  // record exactly as the timer flush does, and still ships the rest.
  const h = harness();
  const sink = mk(h, { maxBatchBytes: 300 });
  h.source.pending.push({ type: 'hitch', at: 'huge', pad: 'a'.repeat(5000) }, { type: 'hitch', at: 'ok' });
  h.target.fire('pagehide', {});
  assert.equal(h.beacons.length, 1);
  const body = JSON.parse(await h.beacons[0].blob.text());
  assert.deepEqual(body.records.map((r) => r.at), ['ok']);
  assert.equal(body.droppedLocally, 1);            // the drop is told, not hidden
  assert.equal(sink.stats().droppedLocally, 0);    // and credited once it was told
  assert.equal(sink.stats().queued, 0);
});

test('enqueue with a non-array never throws into the host', () => {
  const h = harness();
  const sink = mk(h);
  sink.enqueue(undefined);
  sink.enqueue({ type: 'hitch' });
  sink.enqueue('records');
  assert.equal(sink.stats().queued, 0);
  assert.match(sink.stats().lastError, /expected an array/);
});

test('every record is stamped with the sink\'s session id — drained or enqueued — unless it carries one', async () => {
  const h = harness();
  const sink = mk(h);
  assert.match(sink.session(), /^[0-9A-Za-z]{12}$/);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  sink.enqueue([{ type: 'jitter', at: 'y' }, { type: 'error', at: 'z', session: 'mine' }]);
  h.runTimers();
  await sink.flush();
  // Enqueued records sit ahead of the drain that the timer runs later.
  const recs = h.calls[0].body.records;
  assert.deepEqual(recs.map((r) => [r.type, r.session]), [['jitter', sink.session()], ['error', 'mine'], ['hitch', sink.session()]]);
  // Two sinks never share an id; a host may pin one.
  assert.notEqual(mk(harness()).session(), sink.session());
  assert.equal(mk(harness(), { session: 'tab-7' }).session(), 'tab-7');
});

test('session: false stamps nothing — the server runtime\'s records are a process\'s, not a tab\'s', async () => {
  const h = harness();
  const sink = mk(h, { session: false });
  assert.equal(sink.session(), null);
  h.source.pending.push({ type: 'server-hitch', at: 'x' });
  h.runTimers();
  await sink.flush();
  assert.equal('session' in h.calls[0].body.records[0], false);
});

// ── The cap (cloud rulings 32/34): incidents are shed, beats and exits keep flowing ──

const beat = (n) => ({ type: 'heartbeat', at: `b${n}`, p95Ms: 20 });
const inc = (n) => ({ type: 'hitch', at: `h${n}` });
const exit = () => ({ type: 'page-exit', at: 'e', verdict: 'killed' });
const capAnswer = (records) => ({ error: 'daily cap reached', accepted: 0, dropped: records.map((_, index) => ({ index, reason: 'cap' })) });

test('a cap 429 sheds the batch\'s incidents, keeps its beats and exits, and posts them at once', async () => {
  const first = [inc(1), beat(1), inc(2), exit()];
  const h = harness({ statuses: [429, 202], bodies: [capAnswer(first)] });
  const sink = mk(h);
  sink.enqueue(first);
  await sink.flush();
  assert.equal(sink.stats().capped, 2);
  assert.equal(sink.stats().backoffUntil, 0, 'the cap is not a reason to stop posting');
  await sink.flush();
  assert.deepEqual(h.calls[1].body.records.map((r) => r.type), ['heartbeat', 'page-exit']);
});

test('while capped, new incidents are shed as they come; after the Retry-After they flow again', async () => {
  const h = harness({ statuses: [429], bodies: [capAnswer([inc(1)])] });
  const sink = mk(h);
  sink.enqueue([inc(1)]);
  await sink.flush();
  sink.enqueue([inc(2), beat(2), inc(3)]);
  await sink.flush();
  assert.deepEqual(h.calls[1].body.records.map((r) => r.type), ['heartbeat']);
  assert.equal(sink.stats().capped, 3);
  h.tick(31_000);                       // past the harness's Retry-After (30 s)
  sink.enqueue([inc(4)]);
  await sink.flush();
  assert.deepEqual(h.calls[2].body.records.map((r) => r.type), ['hitch']);
});

test('a 202 that says capped (a mixed batch the service split) enters capped mode too', async () => {
  const h = harness({ bodies: [{ accepted: 0, series: 1, dropped: [{ index: 0, reason: 'cap' }], capped: 'daily', retryAfter: 600 }] });
  const sink = mk(h);
  sink.enqueue([inc(1), beat(1)]);
  await sink.flush();
  assert.equal(sink.stats().capped, 1);
  assert.ok(sink.stats().cappedUntil >= 600_000);
  sink.enqueue([inc(2), beat(2)]);
  await sink.flush();
  assert.deepEqual(h.calls[1].body.records.map((r) => r.type), ['heartbeat']);
});

test('a rate-limit 429 (drops not all cap) still backs off and keeps the batch', async () => {
  const h = harness({ statuses: [429], bodies: [{ error: 'rate limited' }] });
  const sink = mk(h);
  sink.enqueue([inc(1), beat(1)]);
  await sink.flush();
  assert.equal(sink.stats().queued, 2);
  assert.ok(sink.stats().backoffUntil > 0);
  assert.equal(sink.stats().capped, 0);
});

// ── The device (cloud ruling 36) and profiles (ruling 37) ──────────────────────

const PHONE = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', platform: 'iOS', mobile: true, dpr: 3, cores: 6 };

test('a sink files one device record first: the browser facts, then the host facts over them', async () => {
  const h = harness();
  const sink = mk(h, { device: { gpu: 'Apple GPU', backend: 'webgl2', mobile: true }, browserDevice: () => PHONE, session: 'tab-A' });
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();
  const [dev, hitch] = h.calls[0].body.records;
  assert.equal(dev.type, 'device');
  assert.equal(dev.session, 'tab-A');
  assert.equal(dev.build, 'b1');
  assert.deepEqual(dev.device, { ...PHONE, gpu: 'Apple GPU', backend: 'webgl2' });
  assert.equal(hitch.type, 'hitch');
});

test('sink.device(facts) files again only when something changed, and cleans what it sends', async () => {
  const h = harness();
  const sink = mk(h, { device: { level: 'low' }, browserDevice: () => PHONE });
  sink.device({ level: 'low' });                                  // unchanged: nothing
  sink.device({ level: 'medium', nested: { no: 1 }, long: 'x'.repeat(500), 'bad key!': 1 });
  await sink.flush();
  const devs = h.calls[0].body.records.filter((r) => r.type === 'device');
  assert.equal(devs.length, 2);
  assert.equal(devs[1].device.level, 'medium');
  assert.equal(devs[1].device.nested, undefined);
  assert.equal(devs[1].device['bad key!'], undefined);
  assert.equal(devs[1].device.long.length, 160);
});

test('no device record without a session, or when the host says device: false', async () => {
  for (const over of [{ session: false, device: {} }, { device: false }]) {
    const h = harness();
    const sink = mk(h, { browserDevice: () => PHONE, ...over });
    sink.device({ level: 'low' });
    h.source.pending.push({ type: 'hitch', at: 'x' });
    await sink.flush();
    assert.equal(h.calls[0].body.records.filter((r) => r.type === 'device').length, 0, JSON.stringify(over));
  }
});

test('profiles go to the cloud at most one per profileEveryMs; the rest are counted as thinned', async () => {
  const h = harness();
  const sink = mk(h, { profileEveryMs: 60_000 });
  const profile = () => ({ type: 'profile', at: 'x', window: { frames: 120 }, sections: { render: 4 } });
  for (let i = 0; i < 7; i++) { sink.enqueue([profile()]); h.tick(10_000); }   // 0 s … 60 s
  h.source.pending.push(profile());                                           // at 70 s, from a source
  await sink.flush();
  assert.equal(h.calls[0].body.records.filter((r) => r.type === 'profile').length, 2, 'the first, and the one a minute later');
  assert.equal(sink.stats().profilesThinned, 6);
});

test('over the cap, devices and profiles keep flowing with the beats', async () => {
  const h = harness({ statuses: [202], bodies: [{ accepted: 0, capped: 'daily', retryAfter: 3600, dropped: [{ index: 0, reason: 'cap' }] }] });
  const sink = mk(h, { device: {}, browserDevice: () => PHONE });
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();
  sink.device({ level: 'medium' });
  sink.enqueue([{ type: 'profile', at: 'x', window: { frames: 1 }, sections: { a: 1 } }, { type: 'hitch', at: 'y' }]);
  await sink.flush();
  assert.deepEqual(h.calls[1].body.records.map((r) => r.type), ['device', 'profile']);
});
