// Rates over RECORDED time, runs per build, and a phase-scoped catalogue
// (ticket 20cd5dc2, issue 5). The reporter ran byte-identical bundles and
// got 82 and 104 hitches: a count per run is a noisy sample, run lengths
// differ, and a build window that spans two sessions a day apart divided its
// hitches by the whole day. Pinned here: the denominator is the time the
// recorder was actually running, a build with several runs says n and the
// spread, and a ledger with a spawn phase and a steady phase can be read
// one phase at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, summarizeWindow, buildIssues, recordedMs, runsOf, issueScopeMinutes, RECORDING_GAP_MS } from '../src/history.js';

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const beat = (min, extra = {}) => ({ type: 'heartbeat', at: at(min), medianFrameMs: 16, p95Ms: 30, ...extra });
const hitch = (min, extra = {}) => ({ type: 'hitch', at: at(min), frameMs: 120, medianMs: 16,
  classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], ...extra });

/** One run: beats every minute over [start, start+len], `n` hitches spread inside. */
function run(start, len, n, extra = {}) {
  const recs = [];
  for (let m = 0; m <= len; m++) recs.push(beat(start + m, extra));
  for (let i = 0; i < n; i++) recs.push(hitch(start + (i + 0.5) * len / n, extra));
  return recs;
}

test('recordedMs: silences longer than the gap are not recording time', () => {
  assert.equal(RECORDING_GAP_MS, 5 * 60_000);
  const recs = [...run(0, 10, 0), ...run(24 * 60, 10, 0)];    // two ten-minute runs a day apart
  assert.equal(recordedMs(recs), 20 * 60_000);
  assert.equal(recordedMs([]), 0);
  assert.equal(recordedMs([beat(0)]), 0);
  // Scoped to a window.
  assert.equal(recordedMs(recs, T0, T0 + 5 * 60_000), 5 * 60_000);
});

test('a build recorded in two sessions a day apart: its rate is over the twenty recorded minutes, with n and the spread', () => {
  const recs = [
    ...run(0, 10, 20, { build: 'fixed', session: 's1' }),          // 120/h
    ...run(24 * 60, 10, 30, { build: 'fixed', session: 's2' }),    // 180/h
  ];
  const [b] = buildHistory(recs).builds;
  assert.equal(b.build, 'fixed');
  assert.equal(b.hitches, 50);
  assert.equal(b.recordedMin, 20);
  assert.equal(b.hitchesPerHour, 150);                 // was 50 / 24h ≈ 2.1
  assert.equal(b.runs, 2);
  assert.deepEqual(b.hitchesPerHourRange, [120, 180]);
  // One run: no spread to show.
  const one = summarizeWindow(run(0, 10, 20, { session: 's1' }), T0, T0 + 10 * 60_000);
  assert.equal(one.runs, 1);
  assert.equal(one.hitchesPerHourRange, undefined);
});

test('runs: one per session id; records without one split at recording gaps', () => {
  const recs = [...run(0, 10, 2, { session: 'a' }), ...run(3, 4, 1, { session: 'b' }),   // two tabs at once
    ...run(60, 5, 1), ...run(200, 5, 3)];                                                // unsessioned, two stretches
  const runs = runsOf(recs, -Infinity, Infinity);
  assert.equal(runs.length, 4);
  assert.deepEqual(runs.map((r) => r.hitches), [2, 1, 1, 3]);
  assert.deepEqual(runs.map((r) => r.recordedMs / 60_000), [10, 4, 5, 5]);
  // A "run" with no evidence (an armed line and nothing else) is not a run.
  assert.equal(runsOf([{ type: 'armed', at: at(0), session: 'z' }], -Infinity, Infinity).length, 0);
});

test('buckets are slices: no rate, no runs', () => {
  const h = buildHistory(run(0, 10, 5, { build: 'v1', session: 's' }), { buckets: 2 });
  for (const b of h.buckets) {
    assert.equal(b.hitchesPerHour, undefined);
    assert.equal(b.runs, undefined);
    assert.equal(b.hitchesPerHourRange, undefined);
  }
});

test('buildIssues: a rate per recorded minute, and a phase or build scope that scopes the time too', () => {
  // A five-minute spawn flood, then a one-minute steady sample, as one ledger.
  const recs = [
    ...run(0, 5, 50, { phase: 'spawn', build: 'b1' }).map((r) => (r.type === 'hitch' ? { ...r, sections: [{ label: 'spawn', excessMs: 90, baselineMs: 1 }] } : r)),
    ...run(5, 1, 2, { phase: 'steady', build: 'b1' }),
  ];
  const all = buildIssues(recs);
  assert.equal(all.length, 2);
  assert.equal(issueScopeMinutes(recs), 6);
  const flood = all.find((r) => r.phase === 'spawn');
  assert.equal(flood.count, 50);
  assert.equal(flood.perMin, 8.33);                    // 50 over the 6 recorded minutes
  const steady = buildIssues(recs, { phase: 'steady' });
  assert.equal(steady.length, 1);
  assert.equal(steady[0].count, 2);
  assert.equal(issueScopeMinutes(recs, { phase: 'steady' }), 1);
  assert.equal(steady[0].perMin, 2);                   // over the steady minute, not the whole run
  assert.equal(buildIssues(recs, { phase: 'nope' }).length, 0);
  assert.equal(buildIssues(recs, { build: 'b1' }).length, 2);
  assert.equal(buildIssues(recs, { build: 'b2' }).length, 0);
  // A record with no phase is in the '?' phase — the one its key says.
  assert.equal(buildIssues([hitch(0)], { phase: '?' }).length, 1);
  // Less than a minute recorded rates over one minute, never divides by zero.
  assert.equal(buildIssues([hitch(0)])[0].perMin, 1);
});
