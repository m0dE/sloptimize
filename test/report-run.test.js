// `sloptimize report` over a run file: what the recorder cost (profiler
// restarts AND the in-page instance-slot watch), the threads table, and
// the other run-level lines — each from exactly what attach writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli, runDir } from './fixtures/run-dir.mjs';

test('the recorder line counts the instance-slot watch, and says when it is a real share of the run', () => {
  const quiet = runCli('report', '--dir', runDir({ run: { recorder: { restarts: 10, restartMs: 10, maxRestartMs: 2, anchored: true, page: { slotsMs: 90, slotsMaxEvery: 120 } } } }));
  assert.match(quiet, /recorder: 10 profiler restarts, 10 ms in total, the longest 2 ms · instance-slot watch 90 ms in the page — 0\.1% of the run/);
  assert.doesNotMatch(quiet, /⚠ the instance-slot watch/);
  const loud = runCli('report', '--dir', runDir({ run: { recorder: { restarts: 0, restartMs: 0, maxRestartMs: 0, anchored: true, page: { slotsMs: 13200, slotsMaxEvery: 1920 } } } }));
  assert.match(loud, /recorder: instance-slot watch 13200 ms in the page \(backed off to every 1920 frames\) — 13% of the run/);
  assert.match(loud, /⚠ the instance-slot watch cost 13% of this run — .*attach --no-slots/);
});

test('report: frame pacing once, with mean and p95 beside the median', () => {
  const pace = { type: 'pacing', at: '2026-10-12T10:00:30Z', state: 'on', lowMs: 5.2, highMs: 60.4, every: 2, longShare: 0.5, meanMs: 32.8, p95Ms: 61, medianMs: 15.4, bandMs: [48, 76] };
  const out = runCli('report', '--dir', runDir({ lines: [pace], profile: { frame: { medianMs: 15.4, meanMs: 32.8, p95Ms: 61 } } }));
  assert.match(out, /frame median 15\.4ms {2}mean 32\.8ms {2}p95 61ms/);
  assert.match(out, /frame pacing: alternating ~5\.2 \/ ~60\.4 ms frames \(1 long in 2\) — mean 32\.8 ms, p95 61 ms, median 15\.4 ms — .*not counted as hitches/);
});
