import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { createErrorMonitor } from '../src/errors.js';
import { footprintOf } from '../src/footprint.js';
import { readFileSync } from 'node:fs';

function fakeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    fire(type, ev) { for (const fn of listeners[type] ?? []) fn(ev); },
    count(type) { return (listeners[type] ?? []).length; },
  };
}
const err = (msg, stack) => Object.assign(new TypeError(msg), { stack: `TypeError: ${msg}\n    ${stack}` });

test('window errors become error records with a trimmed stack, deduped per footprint', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  const target = fakeTarget();
  let t = 0;
  const mon = createErrorMonitor(rec, { target, now: () => t });
  let prevented = false;
  target.fire('error', { error: err('boom 1', 'at render (https://g/a.js:1:1)'), message: 'boom 1', preventDefault: () => { prevented = true; } });
  target.fire('error', { error: err('boom 2', 'at render (https://g/a.js:9:9)'), message: 'boom 2', preventDefault() {} });
  t = 20000;
  target.fire('error', { error: err('boom 3', 'at render (https://g/a.js:9:9)'), message: 'boom 3', preventDefault() {} });
  const out = rec.drainRecords();
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'error');
  assert.equal(out[0].source, 'client');
  assert.equal(out[0].name, 'TypeError');
  assert.deepEqual(out[0].stack, ['at render (https://g/a.js:1:1)']);
  assert.equal(prevented, false);
  assert.deepEqual(mon.stats(), { seen: 3, emitted: 2, deduped: 1 });
  mon.dispose();
  assert.equal(target.count('error'), 0);
});

test('unhandled rejections with a non-Error reason still record', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  const target = fakeTarget();
  createErrorMonitor(rec, { target, now: () => 0 });
  target.fire('unhandledrejection', { reason: 'nope' });
  const [r] = rec.drainRecords();
  assert.equal(r.name, 'UnhandledRejection');
  assert.equal(r.message, 'nope');
  assert.deepEqual(r.stack, []);
});

test('a circular rejection reason still records instead of being swallowed', () => {
  // JSON.stringify throws on a cycle; before the fix that throw escaped into
  // the monitor's catch, so the incident vanished and stats.seen never moved.
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  const target = fakeTarget();
  const mon = createErrorMonitor(rec, { target, now: () => 0 });
  const reason = { code: 'E_LOOP' };
  reason.self = reason;
  target.fire('unhandledrejection', { reason });
  const [r] = rec.drainRecords();
  assert.equal(r.name, 'UnhandledRejection');
  assert.equal(r.message, '[object Object]');
  assert.equal(mon.stats().seen, 1);
  assert.equal(mon.stats().emitted, 1);
});

test('Gecko/JSC stacks are kept and fold to the same footprint as the V8 shape', () => {
  // Firefox and Safari stacks are "fn@url:line:col" with no "at " prefix:
  // dropping them gave those players an empty stack and a second row for the
  // same bug.
  const drive = (stack) => {
    const rec = createRecorder({ budgetFrameMs: 16.7 });
    const target = fakeTarget();
    createErrorMonitor(rec, { target, now: () => 0 });
    target.fire('error', { error: Object.assign(new TypeError('boom'), { stack }), message: 'boom', preventDefault() {} });
    return rec.drainRecords()[0];
  };
  const gecko = drive('render@https://g/a.js:1:1\nloop@https://g/a.js:9:9');
  const v8 = drive('TypeError: boom\n    at render (https://g/a.js:1:1)\n    at loop (https://g/a.js:9:9)');
  assert.deepEqual(gecko.stack, ['render@https://g/a.js:1:1', 'loop@https://g/a.js:9:9']);
  assert.equal(footprintOf(gecko).id, footprintOf(v8).id);
});

test('recorder.emit stamps at, respects the session cap, and reports drops', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), true);
  const [r] = rec.drainRecords();
  assert.match(r.at, /^\d{4}-/);

  // The cap is per SESSION (MAX_RECORDS_PER_SESSION in src/recorder.js), read
  // from the source so this test moves with the constant rather than pinning
  // a number that has drifted.
  const MAX = Number(/const MAX_RECORDS_PER_SESSION = (\d+)/.exec(readFileSync(new URL('../src/recorder.js', import.meta.url), 'utf8'))[1]);
  let accepted = 1;
  while (rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] })) accepted++;
  assert.equal(accepted, MAX);
  assert.equal(rec.drainRecords().length, MAX - 1);
  // Draining is not a new session: the cap holds, and emit keeps saying so.
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), false);
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), false);
  assert.equal(rec.drainRecords().length, 0);
});

test('a drop is counted and reported on the next record that gets through', () => {
  // The drop counter emit() stamps is the recorder's one honesty guarantee:
  // silence must mean nothing was lost. Rate-limit a hitch, then emit.
  const rec = createRecorder({ budgetFrameMs: 16.7, now: () => 1000 });
  const frame = (frameMs) => rec.frame({ frameMs, insideRenderMs: frameMs * 0.5, calls: 100, triangles: 5e4, programs: 10, textures: 5, geometries: 50, paused: false, spawned: 0 });
  for (let i = 0; i < 60; i++) frame(8);
  frame(41);                       // the first hitch: recorded
  frame(41);                       // inside MIN_RECORD_GAP_MS: dropped, counted
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), true);
  const recs = rec.drainRecords();
  assert.equal(recs.length, 2);
  assert.equal(recs[0].droppedSinceLast, undefined);
  assert.equal(recs[1].droppedSinceLast, 1);
});
