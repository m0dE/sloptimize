// A footprint on a timer: "recurs every 15.0 s ± 0.2" says autosave, not a
// player action. Gaps only within one session and one page boot; a missed
// occurrence is a double gap; three occurrences say nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recurrenceOf, buildIssues } from '../src/history.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };
const T0 = Date.parse('2026-10-02T10:00:00Z');
const at = (secs, session = 'S') => secs.map((s, i) => ({ t: T0 + s * 1000 + ((i * 37) % 5 - 2) * 40, session }));

test('an autosave: six ~600 ms stalls 15 s apart read as a 15 s timer, with its spread', () => {
  const r = recurrenceOf(at([12, 27, 42, 57, 72, 87]));
  assert.equal(r.periodSec, 15);
  assert.ok(r.jitterSec < 0.2);
  assert.equal(r.missed, 0);
  assert.equal(r.occurrences, 6);
});

test('a missed occurrence (one under the detection bar) is a double gap, not a different period', () => {
  const r = recurrenceOf(at([0, 15, 45, 60, 75]));
  assert.equal(r.periodSec, 15);
  assert.equal(r.missed, 1);
});

test('irregular events, and three occurrences (two gaps any two events have), say nothing', () => {
  assert.equal(recurrenceOf(at([0, 4, 19, 23, 51, 52, 80])), undefined);
  assert.equal(recurrenceOf(at([0, 15, 30])), undefined);
});

test('gaps across sessions and across a reload are not gaps: every timer restarts', () => {
  const occ = [...at([0, 15, 30], 'A'), ...at([33, 48, 63], 'A'), ...at([100, 107], 'B')];
  const boots = new Map([['A', [T0 + 31_000]]]);
  const r = recurrenceOf(occ, boots);
  assert.ok(Math.abs(r.periodSec - 15) <= 0.1, String(r.periodSec));
  assert.equal(r.gaps, 4);
  assert.equal(recurrenceOf(occ), undefined, 'without the boot, the 3 s gap across the reload breaks it');
});

function ledger() {
  const lines = [{ type: 'armed', at: new Date(T0).toISOString(), session: 'S' }];
  for (let i = 0; i < 6; i++) lines.push({ type: 'hitch', session: 'S', phase: 'steady', at: new Date(T0 + 12_000 + i * 15_000 + (i % 2) * 90).toISOString(), frameMs: 610, classification: [{ guess: 'long-script' }], tier: 0 });
  lines.push({ type: 'hitch', session: 'S', phase: 'steady', at: new Date(T0 + 50_000).toISOString(), frameMs: 120, classification: [{ guess: 'gc-pause' }], tier: 0 });
  return lines;
}

test('buildIssues: the footprint carries `recurs`; a one-off does not', () => {
  const issues = buildIssues(ledger(), { now: T0 + 200_000 });
  const timer = issues.find((i) => i.count === 6);
  assert.equal(timer.recurs.periodSec, 15);
  assert.equal(issues.find((i) => i.count === 1).recurs, undefined);
});

test('issues CLI says it: a timer, not a player action', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-recur-'));
  writeFileSync(join(dir, 'perf.jsonl'), ledger().map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [BIN, 'issues', '--dir', dir], { encoding: 'utf8', env });
  assert.match(r.stdout, /⟳ every 15\.0s ±0\.\d+/);
  assert.match(r.stdout, /⟳ recurs every 15\.0 s ± 0\.\d+ \(6 occurrences\) — a timer, not a player action/);
});
