// The Optimizations strips (SPEC §8.5): one x per build with evidence, the
// four strips side by side on one row, the builds that shipped a fix marked,
// and "the last N builds" as a range the ledger cuts — not a date.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory } from '../src/history.js';
import { stripPoints, stripsSvg, DEFAULT_LAST } from '../src/panel.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const beat = (min, build, p95, extra = {}) => ({ type: 'heartbeat', at: iso(min), medianFrameMs: 8, p95Ms: p95, regime: 'hardware', build, calls: 500, ...extra });

// Thirty builds, ten minutes of evidence each, a day of silence between
// every one: a time axis would be 97% gap.
function ledger(n = 30) {
  const recs = [];
  for (let b = 0; b < n; b++) for (let m = 0; m < 10; m++) recs.push(beat(b * 1440 + m, `b${b}`, 100 - b * 2));
  recs.push({ type: 'hitch', at: iso(5), frameMs: 400, medianMs: 8, insideRenderMs: 0, classification: [{ guess: 'long-script', confidence: 'low', evidence: 'e' }], build: 'b0' });
  return recs;
}
const fixAt = (b) => ({ type: 'fix', at: iso(b * 1440 + 11), title: `fix ${b}`, before: { build: `b${b - 1}` }, after: { build: `b${b}` } });

test('stripPoints: one x per build with evidence, oldest first, fixes marked at the build they shipped as', () => {
  const h = buildHistory(ledger(6), { fixes: [fixAt(2), fixAt(5), { type: 'fix', at: iso(0), title: 'no window' }] });
  const { builds, marks } = stripPoints(h);
  assert.deepEqual(builds.map((b) => b.build), ['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
  assert.deepEqual(marks, [2, 5]);
  assert.equal(builds[0].hitchesPerHour, 6.7);     // one hitch in a nine-minute window: a rate, since build windows differ in length
});

test('stripsSvg: the strips share one row, every build is a point, and the axis names builds not dates', () => {
  const h = buildHistory(ledger(6), { fixes: [fixAt(3)] });
  const { svg, cols } = stripsSvg(h);
  assert.equal(cols, 3);                            // no profile lines → no body strip
  assert.equal((svg.match(/<svg /g) || []).length, 1);
  assert.match(svg, /viewBox="0 0 1000 84"/);       // one strip tall (72 + 12), not four
  assert.equal((svg.match(/<circle /g) || []).length, 6 * 2);   // p95 + draw calls, six builds each, no gaps
  assert.equal((svg.match(/<rect /g) || []).length, 1);         // one build had hitches
  assert.match(svg, />b0<\/text>/);
  assert.match(svg, />b5<\/text>/);
  assert.match(svg, /6 builds · one x per build · 1 shipped a fix/);
  assert.equal((svg.match(/stroke-dasharray/g) || []).length, 3); // the fix's hairline, once per strip
  assert.doesNotMatch(svg, /Jan 1/);
  // A fourth column once the host posts profile lines.
  const recs = ledger(3);
  recs.push({ type: 'profile', at: iso(2 * 1440 + 1), build: 'b2', frame: { bodyMs: 7 }, sections: { sim: 4 } });
  const four = stripsSvg(buildHistory(recs));
  assert.equal(four.cols, 4);
  assert.match(four.svg, /frame body \(host loop\)/);
});

test('stripsSvg: no records, or records with no build id, is a reason not a crash', () => {
  assert.match(stripsSvg(buildHistory([])).svg, /No measured records/);
  const noBuild = buildHistory([{ type: 'heartbeat', at: iso(0), medianFrameMs: 8, p95Ms: 20 }]);
  assert.match(stripsSvg(noBuild).svg, /No build named/);
});

test('buildHistory last: the newest N builds, a cut the ledger picks — and the dates still apply inside it', () => {
  assert.equal(DEFAULT_LAST, 20);
  const fixes = [fixAt(5), fixAt(25)];
  const all = buildHistory(ledger(30), { fixes });
  assert.equal(all.builds.length, 30);
  const h = buildHistory(ledger(30), { fixes, last: 20 });
  assert.deepEqual(h.builds.map((b) => b.build), Array.from({ length: 20 }, (_, i) => `b${i + 10}`));
  assert.equal(h.span.from, iso(10 * 1440));       // the oldest kept build's first evidence
  assert.deepEqual(h.fixes.map((f) => f.title), ['fix 25', 'fix 5']);  // the date range alone did not cut fixes…
  assert.equal(h.buckets.length, 48);
  assert.ok(h.buckets.every((k) => !k.build || /^b(1\d|2\d)$/.test(k.build)));
  // …the panel scopes them by the cut (rangeLo = span.from) as it does dates.
  assert.ok(Date.parse(fixes[0].at) < Date.parse(h.span.from));
  const inDates = buildHistory(ledger(30), { fixes, last: 5, to: iso(9 * 1440 + 9) });
  assert.deepEqual(inDates.builds.map((b) => b.build), ['b5', 'b6', 'b7', 'b8', 'b9']);
  // More than there are: everything.
  assert.equal(buildHistory(ledger(3), { last: 20 }).builds.length, 3);
  // An older build still running past the cut does not sneak in as an extra x.
  const recs = ledger(4);
  recs.push(beat(3 * 1440 + 5, 'b0', 99));
  assert.deepEqual(buildHistory(recs, { last: 2 }).builds.map((b) => b.build), ['b2', 'b3']);
});
