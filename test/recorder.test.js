// The flight recorder's contract, pinned before the implementation (SPEC §3):
// ring arithmetic, hitch detection thresholds, rate limits with a loud drop
// count, the rolling summary, and the usermark window (§3.5 — the human's
// Ctrl+F11 "that hitch, just now" capture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';

function feed(rec, n, ms, extra = {}) {
  for (let i = 0; i < n; i++) {
    rec.frame({ frameMs: ms, insideRenderMs: extra.insideRenderMs ?? ms * 0.5,
      calls: extra.calls ?? 100, triangles: extra.triangles ?? 50000,
      programs: extra.programs ?? 10, textures: extra.textures ?? 5,
      geometries: extra.geometries ?? 50, paused: extra.paused ?? false,
      spawned: extra.spawned ?? 0 });
  }
}

test('steady frames produce no hitch records', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  feed(rec, 200, 8);
  assert.equal(rec.drainRecords().length, 0);
});

test('a frame past max(2x median, 1.5x budget) is a hitch, classified with evidence', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  feed(rec, 120, 8);
  rec.frame({ frameMs: 41, insideRenderMs: 6, calls: 112, triangles: 98000,
    programs: 13, textures: 7, geometries: 50, paused: false, spawned: 2 });
  const recs = rec.drainRecords();
  assert.equal(recs.length, 1);
  const h = recs[0];
  assert.equal(h.type, 'hitch');
  assert.equal(h.frameMs, 41);
  assert.equal(h.delta.programs, 3);
  assert.ok(h.classification.length >= 1);
  assert.equal(h.classification[0].guess, 'shader-compile');
  for (const g of h.classification) assert.ok(g.evidence.length > 0);
});

test('a 30fps-by-design game does not report every frame (relative guard)', () => {
  const rec = createRecorder({ budgetFrameMs: 33.4 });
  feed(rec, 300, 33);
  assert.equal(rec.drainRecords().length, 0);
});

test('paused frames are kept for continuity but never hitch', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  feed(rec, 120, 8);
  feed(rec, 3, 500, { paused: true });
  assert.equal(rec.drainRecords().length, 0);
  assert.equal(rec.summary().window.frames > 0, true);
});

test('rate limit: at most 1 record/second, and the drop count is said out loud', () => {
  let t = 0;
  const rec = createRecorder({ budgetFrameMs: 16.7, now: () => t });
  feed(rec, 120, 8);
  for (let i = 0; i < 10; i++) { t += 20; rec.frame({ frameMs: 60, insideRenderMs: 30, calls: 100, triangles: 1, programs: 10, textures: 5, geometries: 50, paused: false, spawned: 0 }); }
  const recs = rec.drainRecords();
  assert.equal(recs.length, 1);           // all 10 hitches inside one second
  t += 2000;
  rec.frame({ frameMs: 60, insideRenderMs: 30, calls: 100, triangles: 1, programs: 10, textures: 5, geometries: 50, paused: false, spawned: 0 });
  const later = rec.drainRecords();
  assert.equal(later.length, 1);
  assert.equal(later[0].droppedSinceLast, 9); // silence must mean nothing was dropped
});

test('summary reports median/p95/counters and never invents absent fields', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  feed(rec, 100, 10);
  const s = rec.summary();
  assert.equal(Math.round(s.frame.medianMs), 10);
  assert.ok(s.frame.p95Ms >= s.frame.medianMs);
  assert.equal(s.render.calls, 100);
  assert.equal(s.memory.programs, 10);
  assert.ok(!('gpuMs' in s.frame));       // absent, never 0
});

test('usermark captures the trailing window with worst offenders ranked', () => {
  let t = 0;
  const rec = createRecorder({ budgetFrameMs: 16.7, now: () => (t += 16) });
  feed(rec, 100, 8);
  rec.frame({ frameMs: 55, insideRenderMs: 8, calls: 100, triangles: 50000, programs: 10, textures: 5, geometries: 50, paused: false, spawned: 0 });
  feed(rec, 50, 8);
  const m = rec.usermark({ windowMs: 5000, note: 'jitter here', inputsHeld: ['KeyW'] });
  assert.equal(m.type, 'usermark');
  assert.equal(m.note, 'jitter here');
  assert.ok(m.window.frames > 0);
  assert.ok(m.worstFrames.length >= 1);
  assert.equal(Math.round(m.worstFrames[0].frameMs), 55);
  assert.ok(m.worstFrames[0].classification.length >= 1);
  assert.ok(m.window.medianMs < 10);
});


test('a usermark over a healthy window says NOMINAL, not a forced guess', () => {
  let t = 0;
  const rec = createRecorder({ budgetFrameMs: 16.7, now: () => (t += 16) });
  feed(rec, 120, 16);
  const m = rec.usermark({ windowMs: 5000 });
  assert.equal(m.worstFrames[0].classification[0].guess, 'nominal');
});
