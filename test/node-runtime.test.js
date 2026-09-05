import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { foldProfile } from '../src/node/profiler.js';
import { createServerRuntime } from '../src/node/index.js';

test('foldProfile ranks self time per (url, function), excludes runtime, VM and inspector frames, strips file://', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' } },
      { id: 2, callFrame: { functionName: 'step', url: 'file:///srv/world.js' } },
      { id: 3, callFrame: { functionName: 'query', url: 'file:///srv/db.js' } },
      { id: 4, callFrame: { functionName: 'take', url: 'file:///x/node_modules/sloptimize/src/node/profiler.js' } },
      { id: 5, callFrame: { functionName: '(garbage collector)', url: '' } },
      // The window roll's own Profiler.stop parse: the sampler's cost, never the game's.
      { id: 6, callFrame: { functionName: 'post', url: 'node:inspector' } },
    ],
    samples: [2, 2, 3, 4, 5, 2, 6, 6, 6, 6],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
  };
  assert.deepEqual(foldProfile(profile, '/sloptimize/src/node/'), [
    { file: '/srv/world.js', fn: 'step', selfMs: 3 },
    { file: '/srv/db.js', fn: 'query', selfMs: 1 },
  ]);
});

test('foldProfile keys survive spaces in a function name or a path', () => {
  // "get health" is what V8 calls a getter, and a game's dist path can have a
  // space in it — a space-separated fold key mangled both.
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'get health', url: 'file:///srv/My Game/mech.js' } },
      { id: 2, callFrame: { functionName: 'step', url: 'file:///srv/world.js' } },
    ],
    samples: [1, 1, 2],
    timeDeltas: [2000, 2000, 1000],
  };
  assert.deepEqual(foldProfile(profile), [
    { file: '/srv/My Game/mech.js', fn: 'get health', selfMs: 4 },
    { file: '/srv/world.js', fn: 'step', selfMs: 1 },
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

test('a hitch recorded while an injected profiler is still starting still gets attributed once start() resolves', async () => {
  const h = harness();
  let resolveStart;
  const deferredProfiler = {
    started: 0,
    start() { this.started++; return new Promise((res) => { resolveStart = res; }); },
    async take() { return [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]; },
    stop() {},
  };
  const rt = mk(h, { profiler: deferredProfiler });
  rt.tick(() => h.tick(40));            // hitch recorded while profiler.start() is still pending
  resolveStart();
  await rt.flush();
  assert.equal(h.posted.length, 1);
  const [r] = h.posted[0].records;
  assert.equal(r.attribution, 'profiler');
  assert.deepEqual(r.frames, [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]);
});

test('a throwing phase() does not crash the record or tick(); leaves phase unset and counts hostErrors', async () => {
  const h = harness();
  const rt = mk(h, { phase: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => rt.tick(() => h.tick(40)));
  await rt.flush();
  assert.equal(h.posted.length, 1);
  const [r] = h.posted[0].records;
  assert.equal(r.type, 'server-hitch');
  assert.equal(r.phase, undefined);
  assert.equal(r.ctx, 'mode=ranked');    // the other stamp() field is unaffected
  assert.equal(rt.stats().hostErrors, 1);
});

test('a runtime built with real timers exits the process naturally without close() (flush timer is unref\'d)', () => {
  const modulePath = new URL('../src/node/index.js', import.meta.url).href;
  const script = `
    import { createServerRuntime } from ${JSON.stringify(modulePath)};
    const rt = createServerRuntime({
      key: 'sk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'b1',
      fetch: async () => ({ ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) }),
      profiler: { start() {}, async take() { return []; }, stop() {} },
      monitor: { percentiles: new Map([[50, 0], [99, 0]]), max: 0, reset() {}, enable() {}, disable() {} },
    });
    rt.tick(() => { const end = Date.now() + 5; while (Date.now() < end) { /* busy */ } });
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(res.signal, null, `process did not exit naturally (stderr: ${res.stderr})`);
  assert.equal(res.status, 0, `process exited non-zero (stderr: ${res.stderr})`);
});

test('a frame promise that resolves after close() never lands in the queue', async () => {
  // close() disposes the sink; nothing will ever drain `pending` again, so a
  // late profiler result must be dropped rather than grow a queue forever.
  const h = harness();
  let resolveTake;
  const profiler = { start() {}, take: () => new Promise((r) => { resolveTake = r; }), stop() {} };
  const rt = mk(h, { profiler });
  const s = rt.beginTick(); h.tick(40); rt.endTick(s);   // a hitch, waiting on frames()
  await rt.close();
  resolveTake([{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]);
  await new Promise((r) => setTimeout(r, 0));
  await rt.flush();
  assert.equal(h.posted.length, 0);
  assert.equal(rt.stats().sink.queued, 0);
});
