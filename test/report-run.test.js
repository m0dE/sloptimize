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
