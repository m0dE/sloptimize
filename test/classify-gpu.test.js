// The `gpu-bound` verdict, and the misdiagnosis it exists to end.
//
// `insideRenderMs` is CPU wall time inside the render call, and on a
// GPU-bound frame it is small: the CPU queues and returns. So a frame waiting
// on the GPU and a frame running a long script are indistinguishable from the
// CPU's side, and until `gpuMs` existed the classifier called both
// `long-script`. These assert that the two are now separated, and - just as
// important - that a host which cannot measure the GPU gets exactly the
// verdicts it got before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHitch } from '../src/classify.js';

const guesses = (h) => classifyHitch(h).map((g) => g.guess);

test('a frame the GPU spent is gpu-bound, not long-script', () => {
  // The shape a field deployment kept recording: 96ms frame, a render call
  // the CPU was barely inside, and - once measured - a GPU that took nearly
  // all of it.
  const g = guesses({ frameMs: 96, medianMs: 8.3, insideRenderMs: 5, delta: {}, gpuMs: 88 });
  assert.ok(g.includes('gpu-bound'), 'gpu-bound is offered');
  assert.equal(g[0], 'gpu-bound', 'and it ranks first');
  assert.ok(!g.includes('long-script'), 'the frame is not also blamed on script');
});

test('a frame the GPU did not spend is long-script, and now says so with confidence', () => {
  const [top] = classifyHitch({ frameMs: 96, medianMs: 8.3, insideRenderMs: 5, delta: {}, gpuMs: 2 });
  assert.equal(top.guess, 'long-script');
  assert.equal(top.confidence, 'high', 'a measured idle GPU rules the drawing out');
  assert.match(top.evidence, /2\.0ms on the GPU/);
});

test('without the number, nothing changes', () => {
  const before = classifyHitch({ frameMs: 96, medianMs: 8.3, insideRenderMs: 5, delta: {} });
  assert.equal(before[0].guess, 'long-script');
  assert.equal(before[0].confidence, 'medium', 'still the guess it always was');
  assert.ok(!before[0].evidence.includes('GPU'), 'and it does not claim to know');
});

test('a missing GPU is never read as a fast one', () => {
  for (const gpuMs of [undefined, null, NaN, -1, 'fast']) {
    const g = classifyHitch({ frameMs: 96, medianMs: 8.3, insideRenderMs: 5, delta: {}, gpuMs });
    assert.ok(!g.some((x) => x.guess === 'gpu-bound'), `gpuMs=${String(gpuMs)} claims nothing`);
    assert.equal(g[0].confidence, 'medium', `gpuMs=${String(gpuMs)} does not gain confidence`);
  }
});

test('a counter that moved still wins: a shader compile is a shader compile', () => {
  // The GPU is busy during a link, and the link is the actionable cause.
  const g = guesses({ frameMs: 674, medianMs: 8.3, insideRenderMs: 664,
    delta: { programs: 44 }, gpuMs: 600 });
  assert.equal(g[0], 'shader-compile');
});

test('long-render is unaffected: the CPU really was inside the call', () => {
  const g = guesses({ frameMs: 40, medianMs: 8, insideRenderMs: 34, delta: {}, gpuMs: 1 });
  assert.ok(g.includes('long-render'));
  assert.ok(!g.includes('long-script'));
});

test('elimination says what it eliminated', () => {
  // Nothing moved, the render share is inconclusive (between 25% and 60%),
  // and the GPU was idle - so the drawing is ruled OUT rather than unmentioned.
  const [top] = classifyHitch({ frameMs: 40, medianMs: 8, insideRenderMs: 16, delta: {}, gpuMs: 0.5 });
  assert.equal(top.guess, 'gc-or-upload-by-elimination');
  assert.match(top.evidence, /the GPU took 0\.5ms, so the drawing was not it/);
});

test('the boundary is 60% of the frame, and it is not jumpy', () => {
  const at = (gpuMs) => guesses({ frameMs: 100, medianMs: 8, insideRenderMs: 5, delta: {}, gpuMs });
  assert.ok(at(61).includes('gpu-bound'), 'above the line');
  assert.ok(!at(59).includes('gpu-bound'), 'below it');
  assert.ok(at(59).includes('long-script'), 'and below it the old verdict still stands');
});

// ---------------------------------------------------------------- the lane

import { createRecorder } from '../src/recorder.js';

/** Drive n ordinary frames, then one long one, and take the record. */
function hitchWith(sample) {
  let t = 0;
  const rec = createRecorder({ now: () => (t += 8), budgetFrameMs: 16.7 });
  for (let i = 0; i < 60; i++) rec.frame({ frameMs: 8, insideRenderMs: 3, ...(sample.steady ?? {}) });
  rec.frame({ frameMs: 96, insideRenderMs: 5, ...sample.hitch });
  const out = rec.drainRecords({ final: true }).filter((r) => r.type === 'hitch');
  return out[out.length - 1];
}

test('the recorder carries the number when it has one', () => {
  const r = hitchWith({ hitch: { gpuMs: 88 } });
  assert.equal(r.gpuMs, 88);
  assert.equal(r.classification[0].guess, 'gpu-bound');
});

test('and says nothing at all when it has not', () => {
  const r = hitchWith({ hitch: {} });
  assert.ok(!('gpuMs' in r), 'no field rather than a zero');
  assert.equal(r.classification[0].guess, 'long-script');
  assert.equal(r.classification[0].confidence, 'medium', 'the old, honest confidence');
});

test('a host that measured an idle GPU is believed', () => {
  const r = hitchWith({ hitch: { gpuMs: 0 } });
  assert.equal(r.gpuMs, 0, 'zero is a measurement when a host reports it');
  assert.equal(r.classification[0].confidence, 'high');
});

test('a host that profiles its own loop can hand the sections over', () => {
  // Without this there was no seam: the record is minted inside frame(), and
  // the site the catalogue folds on is read off the record.
  const r = hitchWith({ hitch: { sections: [{ label: 'sim.hash', excessMs: 21.4, baselineMs: 0.3 }] } });
  assert.deepEqual(r.sections, [{ label: 'sim.hash', excessMs: 21.4, baselineMs: 0.3 }]);
});

test('and a host that does not, does not grow a field', () => {
  assert.ok(!('sections' in hitchWith({ hitch: {} })));
  assert.ok(!('sections' in hitchWith({ hitch: { sections: [] } })), 'nor for an empty list');
});

test('elimination does not clear the drawing when the GPU took half the frame', () => {
  // 56ms of a 125ms frame is not gpu-bound by the 60% line, and is very far
  // from evidence that drawing was innocent.
  const [top] = classifyHitch({ frameMs: 125, medianMs: 8, insideRenderMs: 46, delta: {}, gpuMs: 56 });
  assert.equal(top.guess, 'gc-or-upload-by-elimination');
  assert.doesNotMatch(top.evidence, /the drawing was not it/);
  assert.match(top.evidence, /neither small nor most of the frame/);
});
