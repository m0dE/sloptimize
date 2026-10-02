// The display rate from rAF intervals: frames last whole vsyncs, so the
// lowest common rate that explains a window is the display's — and a window
// that no fixed rate explains is a variable-refresh display, said as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshFromIntervals, createRefreshTracker } from '../src/cadence.js';

// Deterministic jitter, ±0.3 ms: vsync-aligned timestamps are this tight.
function jittered(steps, periodMs, n = 120) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(steps[i % steps.length] * periodMs + ((i * 37) % 7 - 3) / 10);
  return out;
}

test('a 60 Hz page at full rate reads 60, not 120 (every 60 Hz interval also fits 120)', () => {
  const e = refreshFromIntervals(jittered([1], 1000 / 60));
  assert.equal(e.hz, 60);
  assert.ok(e.fit >= 0.9);
});

test('the field case: a ~45 ms game on 60 Hz lands on 2, 3 and 4 vsyncs and still reads 60', () => {
  assert.equal(refreshFromIntervals(jittered([3, 2, 3, 4, 3], 1000 / 60)).hz, 60);
});

test('144 Hz and 120 Hz displays read as themselves', () => {
  assert.equal(refreshFromIntervals(jittered([1, 1, 2], 1000 / 144)).hz, 144);
  assert.equal(refreshFromIntervals(jittered([1, 2, 1, 1], 1000 / 120)).hz, 120);
});

test('a variable-refresh display (no fixed period) is hz:null, never a guess', () => {
  const xs = [];
  for (let i = 0; i < 120; i++) xs.push(11 + ((i * 7919) % 1300) / 100);   // 11–24 ms, smeared
  assert.equal(refreshFromIntervals(xs).hz, null);
});

test('too few usable intervals says nothing: stalls and hidden-tab gaps are not cadence', () => {
  assert.equal(refreshFromIntervals([16.7, 16.6, 16.7]), null);
  assert.equal(refreshFromIntervals(new Array(100).fill(900)), null);
});

test('tracker: a steady 33.3 ms game reads 30 provisionally, and rises to 60 once two windows show the single period', () => {
  const t = createRefreshTracker();
  assert.equal(t.state(), null);
  assert.equal(t.observe(jittered([2], 1000 / 60)), true);
  assert.equal(t.state().refreshHz, 30);
  assert.equal(t.state().confirmed, false);
  t.observe(jittered([2, 1, 2], 1000 / 60));
  assert.equal(t.state().refreshHz, 30, 'one window of evidence is not two');
  assert.equal(t.observe(jittered([1, 2], 1000 / 60)), true);
  assert.deepEqual(t.state(), { refreshHz: 60, periodMs: 16.667, from: 'raf-cadence', confirmed: true });
  // A later window back at 33.3 ms never lowers it: 60 was seen, 30 only explains less.
  t.observe(jittered([2], 1000 / 60)); t.observe(jittered([2], 1000 / 60));
  assert.equal(t.state().refreshHz, 60);
});

test('tracker: five windows with no fixed rate say variable', () => {
  const t = createRefreshTracker();
  const smear = [];
  for (let i = 0; i < 120; i++) smear.push(11 + ((i * 7919) % 1300) / 100);
  for (let i = 0; i < 4; i++) t.observe(smear);
  assert.equal(t.state(), null);
  assert.equal(t.observe(smear), true);
  assert.deepEqual(t.state(), { refreshHz: null, cadence: 'variable', from: 'raf-cadence' });
});
