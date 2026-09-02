import test from 'node:test';
import assert from 'node:assert/strict';
import { foldProfile } from '../src/node/profiler.js';
import { createServerRuntime } from '../src/node/index.js';

test('foldProfile ranks self time per (url, function), excludes runtime and VM frames, strips file://', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' } },
      { id: 2, callFrame: { functionName: 'step', url: 'file:///srv/world.js' } },
      { id: 3, callFrame: { functionName: 'query', url: 'file:///srv/db.js' } },
      { id: 4, callFrame: { functionName: 'take', url: 'file:///x/node_modules/sloptimize/src/node/profiler.js' } },
      { id: 5, callFrame: { functionName: '(garbage collector)', url: '' } },
    ],
    samples: [2, 2, 3, 4, 5, 2],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
  };
  assert.deepEqual(foldProfile(profile, '/sloptimize/src/node/'), [
    { file: '/srv/world.js', fn: 'step', selfMs: 3 },
    { file: '/srv/db.js', fn: 'query', selfMs: 1 },
  ]);
});

function harness() {
  let t = 0;
  const posted = [];
  const fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) }; };
  const monitor = { percentiles: new Map([[50, 1e6], [99, 1e6]]), max: 1e6, reset() {}, enable() {}, disable() {} };
  const profiler = { started: 0, start() { this.started++; }, async take() { return [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]; }, stop() {} };
  const handlers = {};
  const proc = { on: (k, f) => { handlers[k] = f; }, off: () => {}, emit: (k, ...a) => handlers[k]?.(...a) };
  const timers = [];
  return { posted, fetch, monitor, profiler, proc, now: () => t, tick: (ms) => { t += ms; }, timers,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearInterval() {} };
}
const mk = (h, over = {}) => createServerRuntime({ key: 'sk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'srv1', tickBudgetMs: 16, stallMs: 50,
  phase: () => 'match', context: () => ({ mode: 'ranked' }), fetch: h.fetch, now: h.now, monitor: h.monitor, profiler: h.profiler, process: h.proc,
  setInterval: h.setInterval, clearInterval: h.clearInterval, ...over });

test('a tick over budget records server-hitch with frames, phase, ctx; under budget records nothing; 1/s limit', async () => {
  const h = harness();
  const rt = mk(h);
  rt.tick(() => h.tick(40));
  rt.tick(() => h.tick(5));
  rt.tick(() => h.tick(40));            // within 1s of the first → dropped
  await rt.flush();
  assert.equal(h.posted.length, 1);
  const [r] = h.posted[0].records;
  assert.equal(r.type, 'server-hitch');
  assert.equal(r.tickMs, 40); assert.equal(r.budgetMs, 16);
  assert.equal(r.phase, 'match'); assert.equal(r.ctx, 'mode=ranked');
  assert.deepEqual(r.frames, [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]);
  assert.equal(r.attribution, 'profiler');
  assert.equal(h.posted[0].build, 'srv1');
  assert.equal(rt.stats().hitches, 1);
  assert.equal(rt.stats().droppedByRate, 1);
});

test('beginTick/endTick pair works like tick; profile:false yields attribution off', async () => {
  const h = harness();
  const rt = mk(h, { profile: false });
  const tok = rt.beginTick(); h.tick(30); rt.endTick(tok);
  await rt.flush();
  const [r] = h.posted[0].records;
  assert.equal(r.attribution, 'off');
  assert.deepEqual(r.frames, []);
});

test('event-loop delay p99 over stallMs records server-stall once per 5s', async () => {
  const h = harness();
  const rt = mk(h);
  h.monitor.percentiles = new Map([[50, 5e6], [99, 80e6]]); h.monitor.max = 90e6;
  const sample = h.timers.find((t) => t.ms === 1000).fn;
  sample();                          // the 1s sampler
  sample();                          // still inside 5s → suppressed
  await rt.flush();
  const stalls = h.posted[0].records.filter((r) => r.type === 'server-stall');
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].p99Ms, 80); assert.equal(stalls[0].maxMs, 90); assert.equal(stalls[0].p50Ms, 5);
});

test('uncaughtExceptionMonitor produces a server error record and nothing else is registered', async () => {
  const h = harness();
  const registered = [];
  h.proc.on = (k, f) => { registered.push(k); h.proc[`_${k}`] = f; };
  const rt = mk(h);
  assert.deepEqual(registered.filter((k) => k !== 'beforeExit'), ['uncaughtExceptionMonitor']);
  h.proc._uncaughtExceptionMonitor(Object.assign(new RangeError('bad'), { stack: 'RangeError: bad\n    at step (/srv/world.js:1:1)' }), 'uncaughtException');
  await rt.flush();
  const [r] = h.posted[0].records;
  assert.equal(r.type, 'error'); assert.equal(r.source, 'server'); assert.equal(r.name, 'RangeError');
  assert.deepEqual(r.stack, ['at step (/srv/world.js:1:1)']);
});
