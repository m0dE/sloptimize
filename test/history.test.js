// The timeline and the fix ledger (SPEC §8.5): perf.jsonl folded into time
// buckets and per-build windows, and a fix record whose before/after are
// MEASURED windows of that same ledger — never a typed-in number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistory, summarizeWindow, buildFix, latestBuilds, buildIssues, agoText } from '../src/history.js';
import { footprintOf } from '../src/footprint.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60_000).toISOString();
const beat = (min, p95, extra = {}) => ({ type: 'heartbeat', at: iso(min), medianFrameMs: 8, p95Ms: p95, regime: 'hardware', ...extra });
const hitch = (min, ms, guess = 'long-script', build) => ({
  type: 'hitch', at: iso(min), frameMs: ms, medianMs: 8, insideRenderMs: 0,
  classification: [{ guess, confidence: 'low', evidence: 'e' }], build,
});

// Two builds: v1 for the first hour (bad: p95 120, four hitches, worst 900ms),
// v2 for the second hour (good: p95 12, one small hitch).
function ledger() {
  const recs = [];
  for (let m = 0; m < 60; m += 1) recs.push(beat(m, 120, { build: 'v1', calls: 900, triangles: 1e6, programs: 40 }));
  recs.push(hitch(5, 300, 'shader-compile', 'v1'), hitch(20, 900, 'long-script', 'v1'), hitch(21, 400, 'long-script', 'v1'), hitch(50, 150, 'long-script', 'v1'));
  for (let m = 60; m < 120; m += 1) recs.push(beat(m, 12, { build: 'v2', calls: 300, triangles: 6e5, programs: 41 }));
  recs.push(hitch(90, 40, 'long-script', 'v2'));
  recs.push({ type: 'arm-probe', at: iso(60), build: 'v2' });
  return recs;
}

test('summarizeWindow: jitters are counted with a rate, absent when there were none, and count as build evidence', () => {
  const recs = ledger();
  const jit = (min, build) => ({ type: 'jitter', at: iso(min), track: 'unit', kind: 'snap', units: 0.5, build,
    classification: [{ guess: 'snap', confidence: 'high', evidence: 'e' }] });
  recs.push(jit(10, 'v1'), jit(11, 'v1'), jit(12, 'v1'));
  const before = summarizeWindow(recs, T0, T0 + 60 * 60_000 - 1);
  assert.equal(before.jitters, 3);
  assert.equal(before.jittersPerHour, 3);
  assert.equal(before.hitches, 4);                 // a jitter is not a hitch
  const after = summarizeWindow(recs, T0 + 60 * 60_000, T0 + 120 * 60_000);
  assert.equal(after.jitters, undefined);
  assert.equal(after.jittersPerHour, undefined);
  // A build whose only records are jitters still has a measured window.
  recs.push(jit(130, 'v3'));
  assert.deepEqual(latestBuilds(recs), ['v2', 'v3']);
  const h = buildHistory(recs, { buckets: 4 });
  assert.equal(h.buckets[0].jitters, 3);
  assert.equal(h.buckets[0].jittersPerHour, undefined);   // a bucket is a slice, not a rate
});

test('summarizeWindow: medians of the heartbeats, hitch count/rate/worst, top guess; absent when unmeasured', () => {
  const s = summarizeWindow(ledger(), T0, T0 + 60 * 60_000 - 1);   // bounds are inclusive
  assert.equal(s.beats, 60);
  assert.equal(s.p95Ms, 120);
  assert.equal(s.medianMs, 8);
  assert.equal(s.calls, 900);
  assert.equal(s.programs, 40);
  assert.equal(s.hitches, 4);
  assert.equal(s.hitchesPerHour, 4);
  assert.equal(s.worstMs, 900);
  assert.equal(s.topGuess, 'long-script');
  assert.equal(s.regime, 'hardware');
  // A window with beats that carry no counters says nothing about counters.
  const bare = summarizeWindow([beat(0, 10), beat(1, 10)], T0, T0 + 120_000);
  assert.equal(bare.calls, undefined);
  assert.equal(bare.hitches, 0);
  assert.equal(bare.worstMs, undefined);
  // An empty window is not zeros.
  const empty = summarizeWindow([], T0, T0 + 1);
  assert.equal(empty.beats, 0);
  assert.equal(empty.p95Ms, undefined);
});

test('buildHistory: equal time buckets carry frame/counter medians, hitch spikes and the build that ran', () => {
  const h = buildHistory(ledger(), { buckets: 12 });
  assert.equal(h.buckets.length, 12);
  assert.equal(h.span.from, iso(0));
  assert.equal(h.span.to, iso(119));
  const b0 = h.buckets[0], b2 = h.buckets[2], b6 = h.buckets[6];
  assert.equal(b0.build, 'v1');
  assert.equal(b0.p95Ms, 120);
  assert.equal(b0.calls, 900);
  assert.equal(b0.hitches, 1);
  assert.equal(b0.worstMs, 300);
  assert.equal(b0.worstGuess, 'shader-compile');
  assert.equal(b2.hitches, 2);       // minutes 20 and 21
  assert.equal(b2.worstMs, 900);
  assert.equal(b6.build, 'v2');
  assert.equal(b6.p95Ms, 12);
  assert.equal(b6.calls, 300);
  assert.equal(b6.hitches, 0);
  assert.equal(b6.worstMs, undefined);
  // Builds, in order of first appearance, each with its measured window.
  assert.deepEqual(h.builds.map((b) => b.build), ['v1', 'v2']);
  assert.equal(h.builds[0].hitches, 4);
  assert.equal(h.builds[1].p95Ms, 12);
  assert.equal(h.builds[0].from, iso(0));
  assert.equal(h.builds[1].to, iso(119));
});

test('buildHistory: an empty or beat-less ledger yields an empty timeline, not a crash', () => {
  assert.deepEqual(buildHistory([]).buckets, []);
  const h = buildHistory([{ type: 'arm-probe', at: iso(0) }]);
  assert.equal(h.buckets.length, 0);
  assert.equal(h.builds.length, 0);
});

test('latestBuilds: the newest build with evidence and the one before it, oldest first', () => {
  assert.deepEqual(latestBuilds(ledger()), ['v1', 'v2']);
  // A build seen only through an arm-probe (a tab that never fed) does not count.
  assert.deepEqual(latestBuilds([...ledger(), { type: 'arm-probe', at: iso(130), build: 'v3' }]), ['v1', 'v2']);
  assert.deepEqual(latestBuilds([beat(0, 1, { build: 'only' })]), ['only']);
  assert.deepEqual(latestBuilds([]), []);
});

test('buildFix: before/after default to the previous vs latest build, measured from the ledger', () => {
  const fix = buildFix(ledger(), { title: 'Instance the town', issue: 'programs +40 on launch', solution: 'one InstancedMesh', commit: 'abc1234', now: iso(130) });
  assert.equal(fix.type, 'fix');
  assert.equal(fix.at, iso(130));
  assert.equal(fix.commit, 'abc1234');
  assert.equal(fix.before.build, 'v1');
  assert.equal(fix.after.build, 'v2');
  assert.equal(fix.before.p95Ms, 120);
  assert.equal(fix.after.p95Ms, 12);
  assert.equal(fix.before.calls, 900);
  assert.equal(fix.after.calls, 300);
  // A build's window runs first-evidence..last-evidence (59 min here).
  assert.equal(fix.before.hitchesPerHour, 4.1);
  assert.equal(fix.after.hitchesPerHour, 1);
  // The sparkline the card draws: p95 per bucket inside each window.
  assert.ok(fix.before.series.length > 0 && fix.after.series.length > 0);
  assert.ok(Math.max(...fix.before.series) > Math.max(...fix.after.series));
});

test('buildFix: explicit windows by build name or by time; a window with no evidence is refused', () => {
  const byBuild = buildFix(ledger(), { title: 't', before: 'v1', after: 'v2', now: iso(130) });
  assert.equal(byBuild.before.build, 'v1');
  const byTime = buildFix(ledger(), { title: 't', before: `${iso(0)}..${iso(30)}`, after: `${iso(60)}..${iso(120)}`, now: iso(130) });
  assert.equal(byTime.before.build, undefined);
  assert.equal(byTime.before.from, iso(0));
  assert.equal(byTime.before.hitches, 3);
  assert.throws(() => buildFix(ledger(), { title: 't', before: 'nope', after: 'v2' }), /no evidence for before window "nope"/);
  assert.throws(() => buildFix([beat(0, 1, { build: 'x' })], { title: 't' }), /needs two builds/);
});

test('buildHistory carries fixes through, newest first, clipped to their own fields', () => {
  const fix = buildFix(ledger(), { title: 'a', now: iso(130) });
  const h = buildHistory(ledger(), { fixes: [fix, { ...fix, at: iso(140), title: 'b' }] });
  assert.deepEqual(h.fixes.map((f) => f.title), ['b', 'a']);
});

test('buildIssues: one row per footprint across builds, with count, first/last, builds, worst, and the fixes that name it', () => {
  const recs = ledger();
  const jit = (min, build, extra = {}) => ({ type: 'jitter', at: iso(min), track: 'unit', kind: 'snap', units: 0.5, jump: [0.5, 0, 0], build,
    classification: [{ guess: 'snap', confidence: 'high', evidence: 'e' }], phase: 'play', ...extra });
  recs.push(jit(10, 'v1'), jit(11, 'v1', { units: 0.9, jump: [0.9, 0, 0] }), jit(70, 'v2'));
  recs.push(jit(12, 'v1', { ctx: 'crew=copilot,hull=walker' }));                 // a different situation: its own row
  recs.push(jit(13, 'v1', { automated: true }));                                  // a robot's: not a player's issue
  const now = T0 + 120 * 60_000;
  const fixes = [
    { type: 'fix', id: 'f1', at: iso(65), title: 'Ease hull corrections', commit: 'abc1234', status: 'merged', footprints: [footprintOf(jit(0)).id] },
    { type: 'fix', id: 'f2', at: iso(66), title: 'Unrelated', footprints: ['00000000'] },
    { type: 'fix', id: 'f3', at: iso(67), title: 'No footprints' },
  ];
  const issues = buildIssues(recs, { fixes, now });
  const snap = issues.find((i) => i.key === 'jitter|unit|snap|play|snap|horizontal');
  assert.ok(snap, JSON.stringify(issues.map((i) => i.key)));
  assert.equal(snap.count, 3);
  assert.deepEqual(snap.builds, ['v1', 'v2']);
  assert.equal(snap.first, iso(10));
  assert.equal(snap.last, iso(70));
  assert.equal(snap.lastAgoMs, 50 * 60_000);
  assert.deepEqual(snap.worst, { value: 0.9, unit: 'u' });
  assert.equal(snap.glyph, '↯');
  assert.equal(snap.phase, 'play');
  assert.deepEqual(snap.fixes.map((f) => f.id), ['f1']);
  assert.equal(snap.fixes[0].status, 'merged');
  const copilot = issues.find((i) => i.key.endsWith('ctx:crew=copilot,hull=walker'));
  assert.equal(copilot.count, 1);
  // The hitches of the fixture fold too — the catalogue is every incident type.
  const longScript = issues.find((i) => i.key === 'hitch|undefined|long-script' || i.key.startsWith('hitch|'));
  assert.ok(longScript);
  assert.ok(longScript.count >= 3);
  assert.deepEqual(longScript.worst, { value: 900, unit: 'ms' });
  // Most frequent first.
  for (let i = 1; i < issues.length; i++) assert.ok(issues[i - 1].count >= issues[i].count);
  // A range scopes the occurrences: only v2's jitter in the second hour.
  const late = buildIssues(recs, { fixes, now, from: iso(60) });
  assert.equal(late.find((i) => i.key === snap.key).count, 1);
  assert.equal(agoText(50 * 60_000), '50m ago');
  assert.equal(agoText(30 * 3600_000), '30h ago');
  assert.equal(agoText(5 * 86400_000), '5d ago');
  assert.equal(agoText(20_000), '20s ago');
});

test('buildFix carries the footprints a fix names', () => {
  const fix = buildFix(ledger(), { title: 'x', footprints: ['a3f92c1d'] });
  assert.deepEqual(fix.footprints, ['a3f92c1d']);
});
