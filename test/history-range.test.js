// A date range scopes the whole fold — buckets, builds and fixes — so the
// panel's "improvement between these dates" is the same arithmetic over
// fewer records. Either end open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../src/history.js';

const hb = (at, build, p95) => ({ type: 'heartbeat', at, build, medianFrameMs: p95 / 2, p95Ms: p95, regime: 'hardware' });
const records = [
  hb('2026-08-20T00:00:00Z', 'v1', 40), hb('2026-08-20T01:00:00Z', 'v1', 40),
  hb('2026-08-25T00:00:00Z', 'v2', 20), hb('2026-08-25T01:00:00Z', 'v2', 20),
  hb('2026-08-28T00:00:00Z', 'v3', 10), hb('2026-08-28T01:00:00Z', 'v3', 10),
];
const fixes = [
  { type: 'fix', at: '2026-08-21T00:00:00Z', title: 'old' },
  { type: 'fix', at: '2026-08-27T00:00:00Z', title: 'recent' },
];

test('no range: everything', () => {
  const h = buildHistory(records, { fixes, buckets: 6 });
  assert.equal(h.builds.map((b) => b.build).join(','), 'v1,v2,v3');
  assert.equal(h.fixes.length, 2);
});

test('from only: since that date to now', () => {
  const h = buildHistory(records, { fixes, buckets: 6, from: '2026-08-24T00:00:00Z' });
  assert.equal(h.builds.map((b) => b.build).join(','), 'v2,v3');
  assert.deepEqual(h.fixes.map((f) => f.title), ['recent']);
  assert.equal(h.span.from, '2026-08-25T00:00:00.000Z');
});

test('from..to: a closed window; the first and last build in it are the improvement pair', () => {
  const h = buildHistory(records, { fixes, buckets: 6, from: '2026-08-19T00:00:00Z', to: '2026-08-26T00:00:00Z' });
  assert.equal(h.builds.map((b) => b.build).join(','), 'v1,v2');
  assert.equal(h.builds[0].p95Ms, 40);
  assert.equal(h.builds[h.builds.length - 1].p95Ms, 20);
  assert.deepEqual(h.fixes.map((f) => f.title), ['old']);
});

test('an empty range has no span, not an exception', () => {
  const h = buildHistory(records, { fixes, from: '2027-01-01T00:00:00Z' });
  assert.equal(h.span, null);
  assert.equal(h.fixes.length, 0);
});
