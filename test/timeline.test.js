// A metric across commits, read as a cliff, a staircase, drift or flat —
// with the floor measured from the commits themselves and the per-step
// profile diff for every step that moved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineTable, stepDrive, TIMELINE_PHASE } from '../src/timeline.js';

/** One session: the timeline span (frames, ms) and a run file whose main thread did `busyMs` of every 16.7 ms, split across fns. */
function session(id, busyMs, fns = { update: busyMs }) {
  const records = [{ type: 'phase-span', session: id, at: '2026-10-12T10:00:30Z', phase: TIMELINE_PHASE, span: `${id}.1`, ms: 20000, frames: 1200, t0: 5000, t1: 25000, next: 'timeline-done' }];
  const total = Object.values(fns).reduce((a, b) => a + b, 0);
  const file = { type: 'run', session: id, intervalUs: 10000, from: '2026-10-12T10:00:00Z', to: '2026-10-12T10:00:30Z',
    phases: { [TIMELINE_PHASE]: { samples: Math.round(busyMs * 1200 / 10), idle: 100, program: 0, gc: 0, busyMs: busyMs * 1200, wallMs: 20000,
      fns: Object.entries(fns).map(([fn, ms], i) => [fn, 'https://x/game.js', 10 * i, 0, Math.round(ms * 1200 / 10), Math.round(ms * 1200 / 10)]) } } };
  return { records, file };
}
function table(steps, opts) {
  const all = steps.flatMap((s) => s.sessions.map((id, k) => session(id, s.busy[k], s.fns?.[k])));
  return timelineTable(steps.map((s) => ({ sha: s.sha, subject: s.subject, sessions: s.sessions })), all.flatMap((x) => x.records), all.map((x) => x.file), opts);
}

test('a cliff: one commit carries the change — named, with the functions that moved', () => {
  const t = table([
    { sha: 'aaaa000001', sessions: ['a'], busy: [2] },
    { sha: 'bbbb000002', sessions: ['b'], busy: [2.1] },
    { sha: 'cccc000003', subject: 'pool vehicles per lane', sessions: ['c'], busy: [8.1], fns: [{ update: 2.1, rebuildLanes: 6 }] },
    { sha: 'dddd000004', sessions: ['d'], busy: [8] },
    { sha: 'eeee000005', sessions: ['e'], busy: [8.2] },
  ]);
  assert.equal(t.metric, 'main busy ms/frame', 'a vsync-quantized frame would read 16.7 at every commit');
  assert.equal(t.shape.kind, 'cliff');
  assert.equal(t.shape.at, 'cccc000003');
  assert.match(t.shape.text, /^CLIFF at cccc000003 \(\+6 of \+6\.2, 97%\) — pool vehicles per lane/);
  assert.equal(t.noise.from, 'the typical step between commits');
  const lanes = t.diffs.cccc000003.fns.find((r) => r.fn === 'rebuildLanes@game.js');
  assert.ok(lanes && Math.abs(lanes.total - 6) < 0.1 && Math.abs(lanes.self - 6) < 0.1, JSON.stringify(t.diffs.cccc000003));
  assert.deepEqual(t.steps.map((s) => !!s.significant), [false, false, true, false, false]);
});

test('a staircase: several commits each moved it; drift: none above the floor; flat: nothing moved', () => {
  const st = table([
    { sha: 's1', sessions: ['s1a', 's1b'], busy: [2, 2.1] },
    { sha: 's2', sessions: ['s2a', 's2b'], busy: [4, 4.1] },
    { sha: 's3', sessions: ['s3a', 's3b'], busy: [4.1, 4] },
    { sha: 's4', sessions: ['s4a', 's4b'], busy: [6.1, 6] },
  ]);
  assert.equal(st.shape.kind, 'staircase');
  assert.equal(st.noise.from, 'runs of one commit');
  assert.deepEqual(st.shape.steps.map((x) => x.at), ['s2', 's4']);
  const flat = table(['f1', 'f2', 'f3', 'f4', 'f5'].map((sha, i) => ({ sha, sessions: [sha], busy: [5 + (i % 2) * 0.05] })));
  assert.equal(flat.shape.kind, 'flat');
  const drift = table(['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((sha, i) => ({ sha, sessions: [sha], busy: [5 + i * 0.4] })));
  assert.equal(drift.shape.kind, 'drift');
});

test('the app\'s own frame timer is the default metric when every step has it; a commit that failed to build is skipped over', () => {
  const steps = [{ sha: 'x1', sessions: ['x1'] }, { sha: 'x2', sessions: [], status: 'build-failed' }, { sha: 'x3', sessions: ['x3'] }];
  const a = session('x1', 2), b = session('x3', 9);
  a.file.phases[TIMELINE_PHASE].frame = { windows: 10, medianMs: 16.7, bodyMs: 3 };
  b.file.phases[TIMELINE_PHASE].frame = { windows: 10, medianMs: 16.7, bodyMs: 10 };
  const t = timelineTable(steps, [...a.records, ...b.records], [a.file, b.file]);
  assert.equal(t.metric, 'frame body ms');
  assert.deepEqual(t.steps.map((s) => [s.sha, s.value, s.status]), [['x1', 3, undefined], ['x2', undefined, 'build-failed'], ['x3', 10, undefined]]);
  assert.equal(t.noise.from.startsWith('assumed 10%'), true);
  assert.equal(t.shape.kind, 'cliff');
});

test('each step settles, then measures in the timeline phase', async () => {
  const calls = [];
  await stepDrive({ settleS: 2, measureS: 10 })({ phase: async (p) => calls.push(['phase', p]), wait: async (ms) => calls.push(['wait', ms]) });
  assert.deepEqual(calls, [['phase', 'timeline-settle'], ['wait', 2000], ['phase', 'timeline'], ['wait', 10000], ['phase', 'timeline-done']]);
});
