// The host's own frame in the ledger (SPEC §3.2b): a `profile` line carries
// the loop's sections and counters, a window folds them by median, and a fix
// says which of them moved — so a before/after needs nobody at the keyboard.
//
// The case, verbatim from the field: a day of "press F2 and paste" because
// the game's richest attribution (section means, ~150 counters) lived only in
// its panel, while the ledger carried a heartbeat a minute with median/p95
// and three counters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWindow, buildFix, diffProfiles, latestBuilds } from '../src/history.js';

const T0 = Date.parse('2026-09-10T09:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const prof = (s, build, sections, counts) => ({
  type: 'profile', at: at(s), build, phase: 'play', regime: 'hardware',
  window: { frames: 120, seconds: 2 }, frame: { medianMs: 16.7, p95Ms: 25, bodyMs: 18.2 },
  sections, counts,
});

test('a window folds profile lines by median, per section and per counter', () => {
  const recs = [
    prof(0, 'b1', { render: 5.0, 'crowd.bodies': 3.4 }, { 'rig.posed': 150 }),
    prof(10, 'b1', { render: 5.2, 'crowd.bodies': 3.2 }, { 'rig.posed': 158 }),
    prof(20, 'b1', { render: 9.9, 'crowd.bodies': 3.3, vfx: 1.1 }, { 'rig.posed': 400 }),   // a firefight, once
  ];
  const s = summarizeWindow(recs, T0, T0 + 60_000);
  assert.equal(s.profiles, 3);
  assert.deepEqual(s.sections, { render: 5.2, 'crowd.bodies': 3.3, vfx: 1.1 });
  assert.deepEqual(s.counts, { 'rig.posed': 158 });
  assert.equal(s.medianMs, 16.7);
  assert.equal(s.regime, 'hardware');
  // A window with no profile lines says nothing about sections — absent, not {}.
  const none = summarizeWindow([{ type: 'heartbeat', at: at(0), medianFrameMs: 8 }], T0, T0 + 60_000);
  assert.equal(none.sections, undefined);
  assert.equal(none.profiles, undefined);
});

test('profile lines are evidence: a build seen only through them has a window', () => {
  const recs = [prof(0, 'b1', { render: 5 }, {}), prof(100, 'b2', { render: 4 }, {})];
  assert.deepEqual(latestBuilds(recs), ['b1', 'b2']);
});

test('a fix names the sections and the counters that moved between its two builds', () => {
  const recs = [
    prof(0, 'b1', { render: 5.0, 'crowd.bodies': 3.4, entitySync: 2.2 }, { 'rig.posed': 150, 'rig.jointNodeReads': 10000, 'net.delta.rows': 8 }),
    prof(10, 'b1', { render: 5.0, 'crowd.bodies': 3.4, entitySync: 2.2 }, { 'rig.posed': 150, 'rig.jointNodeReads': 10000, 'net.delta.rows': 8 }),
    prof(100, 'b2', { render: 5.1, 'crowd.bodies': 3.3, entitySync: 1.4 }, { 'rig.posed': 110, 'rig.jointNodeReads': 10100, 'net.delta.rows': 8 }),
    prof(110, 'b2', { render: 5.1, 'crowd.bodies': 3.3, entitySync: 1.4 }, { 'rig.posed': 110, 'rig.jointNodeReads': 10100, 'net.delta.rows': 8 }),
  ];
  const fix = buildFix(recs, { title: 't', now: at(200) });
  assert.equal(fix.before.build, 'b1');
  assert.equal(fix.after.build, 'b2');
  // Every section is listed, biggest first, with both sides and the change.
  assert.deepEqual(fix.moved.sections.map((r) => r.name), ['render', 'crowd.bodies', 'entitySync']);
  const sync = fix.moved.sections.find((r) => r.name === 'entitySync');
  assert.equal(sync.before, 2.2); assert.equal(sync.after, 1.4); assert.equal(sync.delta, -0.8);
  assert.equal(Math.round(sync.share * 100), -36);
  // Counters: only the ones that moved by a fifth or more — the reads (+1%)
  // and the rows (0%) are noise, the posed count is the finding.
  assert.deepEqual(fix.moved.counts.map((r) => r.name), ['rig.posed']);
  assert.equal(fix.moved.counts[0].before, 150);
  assert.equal(fix.moved.counts[0].after, 110);
});

test('a section on one side only is reported with the other side absent', () => {
  const d = diffProfiles({ sections: { a: 1, gone: 2 } }, { sections: { a: 1, added: 3 } });
  const gone = d.sections.find((r) => r.name === 'gone'), added = d.sections.find((r) => r.name === 'added');
  assert.equal(gone.before, 2); assert.equal(gone.after, undefined); assert.equal(gone.delta, undefined);
  assert.equal(added.after, 3); assert.equal(added.before, undefined);
});

test('a fix recorded from heartbeats alone carries no `moved`', () => {
  const beat = (s, build) => ({ type: 'heartbeat', at: at(s), build, medianFrameMs: 8, p95Ms: 12 });
  const fix = buildFix([beat(0, 'b1'), beat(100, 'b2')], { title: 't', now: at(200) });
  assert.equal(fix.moved, undefined);
});
