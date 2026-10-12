// `sloptimize report` over a run file: what the recorder cost (profiler
// restarts AND the in-page instance-slot watch), the threads table, and
// the other run-level lines — each from exactly what attach writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
export const runCli = (...argv) => execFileSync(process.execPath, [BIN, ...argv], { encoding: 'utf8', env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } });

/** A ledger dir with profile.json, perf.jsonl lines and one run file. */
export function runDir({ run = {}, lines = [], profile = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-run-'));
  mkdirSync(join(dir, 'runs'));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', frame: { medianMs: 16.7 }, tier: 0, regime: 'hardware', at: '2026-10-12T10:01:00Z', session: 'S', ...profile }));
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify({ session: 'S', ...l })).join('\n') + (lines.length ? '\n' : ''));
  writeFileSync(join(dir, 'runs', 'S.json'), JSON.stringify({ type: 'run', v: 1, session: 'S', intervalUs: 10000, from: '2026-10-12T10:00:00.000Z', to: '2026-10-12T10:01:40.000Z',
    phases: { '?': { samples: 1000, idle: 9000, program: 0, gc: 0, fns: [], busyMs: 10000, wallMs: 100000, frame: { windows: 50, medianMs: 16.7 } } }, ...run }));
  return dir;
}

test('the recorder line counts the instance-slot watch, and says when it is a real share of the run', () => {
  const quiet = runCli('report', '--dir', runDir({ run: { recorder: { restarts: 10, restartMs: 10, maxRestartMs: 2, anchored: true, page: { slotsMs: 90, slotsMaxEvery: 120 } } } }));
  assert.match(quiet, /recorder: 10 profiler restarts, 10 ms in total, the longest 2 ms · instance-slot watch 90 ms in the page — 0\.1% of the run/);
  assert.doesNotMatch(quiet, /⚠ the instance-slot watch/);
  const loud = runCli('report', '--dir', runDir({ run: { recorder: { restarts: 0, restartMs: 0, maxRestartMs: 0, anchored: true, page: { slotsMs: 13200, slotsMaxEvery: 1920 } } } }));
  assert.match(loud, /recorder: instance-slot watch 13200 ms in the page \(backed off to every 1920 frames\) — 13% of the run/);
  assert.match(loud, /⚠ the instance-slot watch cost 13% of this run — .*attach --no-slots/);
});
