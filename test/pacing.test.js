// Frame pacing: a reduced-rate loop (5 ms / 60 ms frames) is one steady
// pattern, said once with its mean and p95 — not 205 hitches and a median
// that describes no frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { framePacing, pacingText } from '../src/cadence.js';
import { buildInjectScript } from '../src/attach.mjs';

test('framePacing: a strided bimodal window is pacing; spikes, scatter and vsync steps are not', () => {
  const alt = Array.from({ length: 120 }, (_, i) => (i % 2 ? 60 + (i % 3) : 5 + (i % 4) / 4));
  const p = framePacing(alt);
  assert.equal(p.every, 2);
  assert.ok(p.lowMs < 6 && p.highMs >= 60);
  assert.ok(Math.abs(p.meanMs - 33.3) < 1);
  assert.match(pacingText(p), /^alternating ~5\.\d \/ ~6\d(\.\d)? ms frames \(1 long in 2\) — mean 3\d\.\d ms, p95 6\d(\.\d)? ms/);
  const third = Array.from({ length: 120 }, (_, i) => (i % 3 === 2 ? 50 : 16.7));
  assert.equal(framePacing(third).every, 3);
  // Two stalls in a steady run: hitches, not pacing.
  const steady = Array.from({ length: 120 }, () => 16.7); steady[30] = 200; steady[70] = 90;
  assert.equal(framePacing(steady), null);
  // Long frames scattered at random, of every length: not a pattern.
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.equal(framePacing(Array.from({ length: 120 }, () => (rnd() < 0.3 ? 40 + rnd() * 80 : 16))), null);
  // A 30 fps game on a 60 Hz display flipping 16.7 / 33.3: under the 2.5× ratio.
  assert.equal(framePacing(Array.from({ length: 120 }, (_, i) => (i % 2 ? 33.3 : 16.7))), null);
  assert.equal(framePacing(alt.slice(0, 40)), null, 'too few frames to judge');
});

test('tier 0: paced frames are not emitted as hitches; one pacing record; the profile carries the mean', () => {
  const rafs = [], emitted = [];
  const ctx = { requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 0, PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)), EventTarget, CustomEvent, WeakMap, WeakRef,
    Uint8Array, Uint16Array, Float32Array, Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript({ slots: false }), ctx);
  let ts = 0;
  // 5, 5, 60: the median is a short frame, so every long one clears 2× it.
  for (let f = 0; f < 1200; f++) { ts += f % 3 === 0 ? 60 : 5; const cb = rafs.pop(); rafs.length = 0; cb(ts); }
  ts += 400; rafs.pop()(ts);   // a stall on top of the pacing
  const hitches = emitted.filter((e) => e.type === 'hitch');
  const pacing = emitted.filter((e) => e.type === 'pacing');
  assert.deepEqual(pacing.map((p) => [p.state, p.every]), [['on', 3]]);
  const late = hitches.filter((h) => h.frame > 200);
  assert.deepEqual(late.map((h) => h.frameMs), [400], 'after pacing is known, only the stall is a hitch');
  assert.ok(hitches.length < 80, `${hitches.length} hitches in all (400 long frames)`);
  const prof = emitted.filter((e) => e.type === 'profile').at(-2);   // the last window holds the stall
  assert.equal(prof.frame.meanMs, 23.33);
  assert.deepEqual(prof.frame.pacing, { lowMs: 5, highMs: 60, every: 3 });
  assert.equal(prof.frame.paced, 40, 'the window\'s long frames, absorbed by the pacing instead of filed as hitches');
});
