// InstancedMesh slots drawn but no longer written: the field bug was a cull
// that stopped writing off-screen transforms while count stayed at the
// high-water mark — ~95 ghosts no counter could see. The watch, pure, and
// in the injected recorder through three's own devtools hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createSlotWatch, changedSlots, STALE_CHECKS } from '../src/instance-slots.js';
import { buildInjectScript } from '../src/attach.mjs';
import { footprintKey, describeFootprint } from '../src/footprint.js';

function cars(n = 100, name = 'cars') {
  const mesh = { isInstancedMesh: true, name, uuid: 'u1', visible: true, count: n, instanceMatrix: { array: new Float32Array(n * 16) }, children: [] };
  mesh.setMatrixAt = function (i, m) { this.instanceMatrix.array.set(m, i * 16); };
  return mesh;
}
const scene = (...kids) => ({ isScene: true, visible: true, children: kids });
const move = (mesh, from, to) => { for (let i = from; i < to; i++) mesh.instanceMatrix.array[i * 16 + 12] += 1; };

test('slots the game stops writing go stale while the rest move; static meshes say nothing; a clear is said once', () => {
  const w = createSlotWatch();
  const m = cars(100), still = cars(50, 'rocks');
  w.observe(scene(m, still));
  let t = 0, rows = w.check(t);
  assert.deepEqual(rows, [], 'the first check only takes the copy');
  // 5 cars keep moving through direct array writes; 90 are rewritten with the SAME matrix via setMatrixAt (a parked car is written, not a ghost); 5 are never touched.
  const same = new Float32Array(16);
  for (let k = 1; k <= STALE_CHECKS; k++) {
    move(m, 0, 5);
    for (let i = 5; i < 95; i++) m.setMatrixAt(i, same);
    rows = w.check(t += 2000);
    if (k < STALE_CHECKS) assert.deepEqual(rows, []);
  }
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], staleSec: undefined }, { name: 'cars', drawn: 100, capacity: 100, active: 95, written: 90, changed: 5, stale: 5, staleSec: undefined });
  assert.equal(rows[0].staleSec, 10);
  // Unchanged number: not said again.
  move(m, 0, 5); for (let i = 5; i < 95; i++) m.setMatrixAt(i, same);
  assert.deepEqual(w.check(t += 2000), []);
  // The fix: count shrinks to the live set — cleared, said once.
  m.count = 95; move(m, 0, 5); for (let i = 5; i < 95; i++) m.setMatrixAt(i, same);
  rows = w.check(t += 2000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stale, 0);
  move(m, 0, 95);
  assert.deepEqual(w.check(t += 2000), []);
});

test('a paused game (nothing active) is not a finding and not a clear; hidden meshes are not drawn', () => {
  const w = createSlotWatch();
  const m = cars(10), hidden = cars(10, 'pool');
  hidden.visible = false;
  w.observe(scene(m, { visible: false, children: [cars(10, 'nested')] }, hidden));
  let t = 0;
  w.check(t);
  for (let k = 0; k < STALE_CHECKS + 2; k++) assert.deepEqual(w.check(t += 2000), []);
  assert.equal(w.meshes(), 1);
  assert.deepEqual([...changedSlots(new Float32Array(32), new Float32Array(32).fill(1, 16), 2)], [0, 1]);
});

test('the injected recorder defines __THREE_DEVTOOLS__, receives scenes from three, and emits instance-slots records', () => {
  const rafs = [], emitted = [];
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 0,
    PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'app://index.html' }, document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    EventTarget, CustomEvent, WeakMap, WeakRef, Uint8Array, Uint16Array, Float32Array,
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  assert.equal(typeof ctx.__THREE_DEVTOOLS__.addEventListener, 'function');
  // What three.js's Scene constructor does.
  const m = cars(20);
  ctx.__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', { detail: scene(m) }));
  let ts = 0;
  for (let f = 0; f < 120 * (STALE_CHECKS + 2); f++) { if (f % 120 === 0) move(m, 0, 15); ts += 16; const cb = rafs.pop(); rafs.length = 0; cb(ts); }
  const recs = emitted.filter((e) => e.type === 'instance-slots');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].stale, 5);
  assert.equal(recs[0].tier, 0);
  const key = footprintKey(recs[0]);
  assert.equal(key, 'instance-slots|?|cars');
  assert.match(describeFootprint(key).label, /instance slots drawn, not written · cars/);
  assert.equal(footprintKey({ ...recs[0], stale: 0 }), null, 'a clear is not an incident');
});

test('an existing devtools hook is listened on, never replaced', () => {
  const hook = new EventTarget();
  const ctx = { __THREE_DEVTOOLS__: hook, requestAnimationFrame() {}, setInterval: () => 0, PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit() {}, EventTarget, CustomEvent, WeakMap, WeakRef, Uint8Array, Uint16Array, Float32Array,
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  assert.equal(ctx.__THREE_DEVTOOLS__, hook);
});

test('--no-slots: the recorder defines no __THREE_DEVTOOLS__ and runs no checks', () => {
  const rafs = [], emitted = [];
  const ctx = { requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 0, PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)), EventTarget, CustomEvent, WeakMap, WeakRef, Uint8Array, Uint16Array, Float32Array,
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript({ slots: false }), ctx);
  assert.equal(ctx.__THREE_DEVTOOLS__, undefined);
  let ts = 0;
  for (let f = 0; f < 800; f++) { ts += 16; const cb = rafs.pop(); rafs.length = 0; cb(ts); }
  assert.equal(emitted.filter((e) => e.type === 'instance-slots').length, 0);
});

test('a check stops at its budget and the next resumes there; a static mesh is visited one check in QUIET_EVERY; the time is kept', async () => {
  const { QUIET_CHECKS, QUIET_EVERY } = await import('../src/instance-slots.js');
  // Visits counted by reads of the matrix buffer (the scene walk never reads it).
  const counted = (m) => { const arr = m.instanceMatrix.array; m.reads = 0; m.instanceMatrix = { get array() { m.reads++; return arr; } }; return m; };
  // A clock that advances 1 ms per read: each mesh visit past the first costs the budget.
  let t = 0;
  const w = createSlotWatch({ budgetMs: 1.5, now: () => (t += 1) });
  const ms = [cars(10, 'a'), cars(10, 'b'), cars(10, 'c'), cars(10, 'd')].map(counted);
  w.observe(scene(...ms));
  const visited = () => ms.filter((m) => m.reads > 0).length;
  w.check(0);
  assert.equal(visited(), 2, 'two meshes fit the budget');
  w.check(1);
  assert.equal(visited(), 4, 'the next check resumes where the last stopped');
  const s = w.stats();
  assert.equal(s.checks, 2);
  assert.ok(s.ms > 0 && s.maxMs > 0);
  assert.equal(s.deferred, 2);
  // Quiet backoff: nothing active for QUIET_CHECKS visits → one check in QUIET_EVERY.
  const w2 = createSlotWatch({ budgetMs: Infinity });
  const still = counted(cars(10, 'houses'));
  w2.observe(scene(still));
  for (let k = 0; k <= QUIET_CHECKS; k++) w2.check(k);
  still.reads = 0;
  for (let k = 0; k < QUIET_EVERY * 3; k++) w2.check(100 + k);
  assert.equal(still.reads, 3);
  still.reads = 0;
  // Movement brings it back to every check.
  const buf = still.instanceMatrix.array;
  buf[12] += 1;
  for (let k = 0; k < QUIET_EVERY; k++) w2.check(200 + k);
  still.reads = 0;
  buf[12] += 1;
  w2.check(300); buf[12] += 1; w2.check(301);
  assert.equal(still.reads, 2);
});

test('only the translation is compared: a rotation in place without setMatrixAt is idle, a move is not', async () => {
  const { changedTranslations } = await import('../src/instance-slots.js');
  const arr = new Float32Array(32), kept = new Float32Array(6), out = new Uint8Array(2);
  changedTranslations(arr, kept, 2, 0, out);
  assert.deepEqual([...out], [0, 0], 'no copy yet: nothing changed');
  arr[0] = 0.5;            // slot 0 rotated
  arr[16 + 13] = 2;        // slot 1 moved in y
  changedTranslations(arr, kept, 2, 2, out);
  assert.deepEqual([...out], [0, 1]);
  changedTranslations(arr, kept, 2, 2, out);
  assert.deepEqual([...out], [0, 0], 'the copy was updated in place');
});

test('the profile record carries the watch\'s in-page time, and the run file counts it as the recorder\'s', async () => {
  const rafs = [], emitted = [];
  let clock = 0;
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 0,
    PerformanceObserver: class { observe() {} }, performance: { now: () => (clock += 0.25) },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)),
    EventTarget, CustomEvent, WeakMap, WeakRef, Uint8Array, Uint16Array, Float32Array, Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  ctx.__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', { detail: scene(cars(20)) }));
  let ts = 0;
  for (let f = 0; f < 600; f++) { ts += 16; const cb = rafs.pop(); rafs.length = 0; cb(ts); }
  const profs = emitted.filter((e) => e.type === 'profile');
  assert.ok(profs.length >= 4);
  assert.ok(profs.every((p) => typeof p.recorder?.slotsMs === 'number'));
  assert.ok(profs.some((p) => p.recorder.slotsMs > 0));
  const { createRunFold } = await import('../src/runs.js');
  const run = createRunFold({ session: 's' });
  for (const p of profs) run.addFrame(p);
  const j = run.toJSON();
  assert.ok(j.recorder.page.slotsMs > 0);
  assert.equal(j.recorder.page.slotsMaxEvery >= 120, true);
});
