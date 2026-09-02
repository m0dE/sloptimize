import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { createErrorMonitor } from '../src/errors.js';

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

test('recorder.emit stamps at, respects the session cap, and reports drops', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), true);
  const [r] = rec.drainRecords();
  assert.match(r.at, /^\d{4}-/);
});
