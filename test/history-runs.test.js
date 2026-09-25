// Several runs of one build (SPEC §8.5): the hitch rate is over the minutes
// the feed was RECORDING — heartbeats say when — and a build measured more
// than once carries each run's rate and their range, so run-to-run noise is
// visible beside the number. And the catalogue reads one phase at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, summarizeWindow, buildIssues } from '../src/history.js';

const T0 = Date.parse('2026-09-25T10:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const beat = (min, session, build = 'B') => ({ type: 'heartbeat', at: iso(min), medianFrameMs: 16, p95Ms: 30, session, build });
const hitch = (min, session, build = 'B', extra = {}) => ({ type: 'hitch', at: iso(min), frameMs: 120, medianMs: 16, session, build,
  classification: [{ guess: 'long-script', confidence: 'medium', evidence: 'e' }], ...extra });

/** Beats from `start` to `start + minutes`, and `n` hitches spread through them. */
function run(session, start, minutes, n, build = 'B') {
  const recs = [];
  for (let m = 0; m <= minutes; m++) recs.push(beat(start + m, session, build));
  for (let i = 0; i < n; i++) recs.push(hitch(start + (i * minutes) / n, session, build));
  return recs;
}

test('two runs of one build an hour apart: the rate is over the 20 recorded minutes, not the 80-minute window', () => {
  const recs = [...run('s1', 0, 10, 10), ...run('s2', 70, 10, 20)];
  const [b] = buildHistory(recs).builds;
  assert.equal(b.build, 'B');
  assert.equal(b.hitches, 30);
  assert.equal(b.recordedMin, 20);
  assert.equal(b.hitchesPerHour, 90);               // 30 in 20 min — not 30 in 80 (22.5)
  assert.equal(b.runs.length, 2);
  assert.deepEqual(b.runs.map((r) => [r.session, r.minutes, r.hitches, r.hitchesPerHour]), [['s1', 10, 10, 60], ['s2', 10, 20, 120]]);
  assert.deepEqual(b.spread, { n: 2, lo: 60, hi: 120 });
});

test('runs without a session are cut where a beating feed went silent; a short pause is not a new run', () => {
  const recs = [...run(undefined, 0, 10, 5), ...run(undefined, 12, 5, 0), ...run(undefined, 40, 10, 5)];
  const [b] = buildHistory(recs).builds;
  assert.equal(b.runs.length, 2);                   // the 2-minute pause joined; the 25-minute silence cut
  assert.equal(b.recordedMin, 17 + 10);
  assert.equal(b.runs[0].session, undefined);
});

test('one run: a rate over its recorded minutes, and no runs/spread to read', () => {
  const s = summarizeWindow(run('s1', 0, 30, 15), T0, T0 + 30 * 60_000);
  assert.equal(s.recordedMin, 30);
  assert.equal(s.hitchesPerHour, 30);
  assert.equal(s.runs, undefined);
  assert.equal(s.spread, undefined);
});

test('a window with no heartbeats keeps its whole length: silence there cannot be told from a quiet session', () => {
  const recs = [hitch(0, 's1'), hitch(59, 's1'), hitch(120, 's2')];
  const s = summarizeWindow(recs, T0, T0 + 120 * 60_000);
  assert.equal(s.hitchesPerHour, 1.5);              // 3 in two hours
  assert.equal(s.recordedMin, undefined);
  assert.equal(s.runs, undefined);
});

test('buckets are slices: no rate, no runs', () => {
  const h = buildHistory([...run('s1', 0, 10, 10), ...run('s2', 70, 10, 20)], { buckets: 4 });
  for (const k of h.buckets) { assert.equal(k.runs, undefined); assert.equal(k.spread, undefined); assert.equal(k.recordedMin, undefined); }
});

test('buildIssues --phase: only occurrences stamped with that phase; `?` for the unstamped', () => {
  const recs = [
    hitch(1, 's', 'B', { phase: 'spawn' }), hitch(2, 's', 'B', { phase: 'spawn' }), hitch(3, 's', 'B', { phase: 'steady' }), hitch(4, 's'),
    { type: 'error', at: iso(5), name: 'TypeError', message: 'x is undefined', stack: 'at f (a.js:1:1)', phase: 'steady' },
  ];
  assert.equal(buildIssues(recs).length, 4);
  const steady = buildIssues(recs, { phase: 'steady' });
  assert.deepEqual(steady.map((r) => r.type).sort(), ['error', 'hitch']);
  assert.equal(buildIssues(recs, { phase: 'spawn' })[0].count, 2);
  assert.equal(buildIssues(recs, { phase: '?' }).length, 1);
});
