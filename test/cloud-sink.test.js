import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSink } from '../src/cloud-sink.js';

function harness({ statuses = [] } = {}) {
  const calls = [];
  let t = 0;
  const timers = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers, keepalive: init.keepalive });
    const status = statuses.shift() ?? 202;
    return { ok: status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && status === 429 ? '30' : null) }, json: async () => ({ accepted: 1, dropped: [] }) };
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
const mk = (h, over = {}) => createCloudSink({ key: 'pk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'b1', sources: [h.source], fetch: h.fetch, sendBeacon: h.sendBeacon, target: h.target, setInterval: h.setInterval, clearInterval: h.clearInterval, now: h.now, ...over });

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
