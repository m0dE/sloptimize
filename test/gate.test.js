// The gate: budgets judged over a whole run, per phase; hitch budgets on
// FIXED bars (a relative count inverts under a uniform slowdown); a build's
// value the median of its runs; too few runs its own exit code, never a pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBudgets, runPhaseMetrics, judgeBudgets, regressionGate, worseDirection } from '../src/gate.js';
import { createRunFold } from '../src/runs.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };

test('parseBudgets: legacy globals, per-phase metrics, fixed bars, sections, rates that say their direction', () => {
  const { rows, errors } = parseBudgets({
    'perf.budget.draw_calls': 300,
    'perf.budget.load.worst_ms': 500,
    'perf.budget.steady.p95_ms': { max: 50 },
    'perf.budget.*.frames_over_100ms_per_min': 2,
    'perf.budget.steady.section.crowd.bodies': 4,
    'perf.budget.steady.rate.delivered': { min: 3 },
    'perf.conditions': { refreshHz: 60 },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => [r.phase, r.metric, r.name ?? r.bar ?? null, r.max ?? null, r.min ?? null]), [
    [null, 'draw_calls', null, 300, null], ['load', 'worst_ms', null, 500, null], ['steady', 'p95_ms', null, 50, null],
    ['*', 'frames_over', 100, 2, null], ['steady', 'section', 'crowd.bodies', 4, null], ['steady', 'rate', 'delivered', null, 3]]);
  const bad = parseBudgets({ 'perf.budget.steady.frames_over_75ms_per_min': 1, 'perf.budget.steady.rate.x': 3, 'perf.budget.steady.fps': 60, 'perf.budget.nope': 1 }).errors;
  assert.equal(bad.length, 4);
  assert.match(bad[0], /counted over 50, 100, 200, 500, 1000 ms/);
  assert.match(bad[1], /says its direction/);
});

test('a relative hitch budget alone is refused (it inverts under a uniform slowdown); beside a p95 ceiling it stands', () => {
  const alone = parseBudgets({ 'perf.budget.steady.hitches_per_h': 10 });
  assert.match(alone.errors[0], /RELATIVE to the rolling median.*frames_over_<N>ms_per_min/);
  assert.deepEqual(parseBudgets({ 'perf.budget.steady.hitches_per_h': 10, 'perf.budget.steady.p95_ms': 40 }).errors, []);
});

// A tier-0 run: phase windows folded into a run file, hitches in the ledger.
function tier0Run({ session = 'S', build = 'b', load = {}, steady = {} } = {}) {
  const f = createRunFold({ session, build });
  f.setConditions({ instrument: 'attach', mode: 'timing' });
  const win = (phase, w, i) => f.addFrame({ phase, at: `2026-10-02T00:0${i}:00Z`, frame: { medianMs: w.median, p95Ms: w.p95 }, render: { calls: 300 },
    window: { frames: 120, seconds: 2 }, over: { 50: w.over50 ?? 0, 100: w.over100 ?? 0, 200: 0, 500: w.over500 ?? 0, 1000: 0 } });
  win('load', { median: 30, p95: 90, over50: 10, over100: 3, over500: 1, ...load }, 0);
  for (let i = 1; i <= 5; i++) win('steady', { median: 16.7, p95: 20, ...steady }, i);
  const recs = [
    { type: 'hitch', session, build, phase: 'load', frameMs: load.worst ?? 640, at: '2026-10-02T00:00:01Z' },
    ...(steady.hitch ? [{ type: 'hitch', session, build, phase: 'steady', frameMs: steady.hitch, at: '2026-10-02T00:02:01Z' }] : []),
  ];
  return { file: f.toJSON(), recs };
}

test('runPhaseMetrics: worst frame from the hitches, frames over fixed bars per minute of the phase, per phase', () => {
  const { file, recs } = tier0Run({ steady: { over100: 1 } });   // one frame over 100 ms in each of five 2 s windows
  const m = runPhaseMetrics(recs, file);
  assert.equal(m.get('load').worst_ms, 640);
  assert.equal(m.get('load').median_ms, 30);
  assert.equal(m.get('steady').p95_ms, 20);
  assert.equal(m.get('steady').seconds, 10);
  // Frames passed 100 ms in steady with no hitch recorded (relative bar):
  // the worst frame lies between 100 and the next bar, 200 — an interval.
  assert.deepEqual(m.get('steady').worst, { lo: 100, hi: 200 });
  assert.equal(m.get('steady').worst_ms, undefined);
  // The load phase's frame over 500 ms was recorded (640): exact.
  assert.deepEqual(m.get('load').worst, { lo: 640, hi: 640 });
  const w = judgeBudgets(parseBudgets({ 'perf.budget.steady.worst_ms': 150 }).rows, [m]).results[0];
  assert.equal(w.value, null, 'a ceiling inside the interval cannot be judged either way');
  assert.match(w.verdict, /cannot tell: the worst frame is between 100 and 200 ms/);
  assert.equal(judgeBudgets(parseBudgets({ 'perf.budget.steady.worst_ms': 90 }).rows, [m]).results[0].breached, true, 'the lower bound alone proves a breach');
  assert.equal(judgeBudgets(parseBudgets({ 'perf.budget.steady.worst_ms': 250 }).rows, [m]).results[0].verdict, 'inside', 'the upper bound alone proves a pass');
  const j = judgeBudgets(parseBudgets({ 'perf.budget.steady.frames_over_100ms_per_min': 2, 'perf.budget.load.worst_ms': 500 }).rows, [m]);
  assert.deepEqual(j.results.map((r) => [r.budget, r.value, r.verdict]), [
    ['perf.budget.steady.frames_over_100ms_per_min', 30, 'over by 15.0x'], ['perf.budget.load.worst_ms', 640, 'over by 1.3x']]);
  assert.equal(j.results[0].rule, 'absolute (frame > 100 ms)');
});

test('the inversion, end to end: a uniformly 20% slower build has FEWER relative hitches, yet the fixed bar and the p95 catch it', () => {
  // A: median 40, its relative bar 80 ms; frames at 90 ms are hitches.
  // B: everything 20% slower — median 48, bar 96: the 108 ms frames are not.
  const a = runPhaseMetrics([...Array(6)].map((_, i) => ({ type: 'hitch', phase: 'steady', frameMs: 90, at: `2026-10-02T00:00:0${i}Z` })), { phases: { steady: { frame: { medianMs: 40, p95Ms: 60 }, seconds: 60, over: { 50: 30, 100: 0, 200: 0, 500: 0, 1000: 0 } } } });
  const b = runPhaseMetrics([], { phases: { steady: { frame: { medianMs: 48, p95Ms: 72 }, seconds: 60, over: { 50: 40, 100: 6, 200: 0, 500: 0, 1000: 0 } } } });
  assert.ok(b.get('steady').hitches < a.get('steady').hitches, 'the relative count went DOWN');
  const rows = parseBudgets({ 'perf.budget.steady.frames_over_100ms_per_min': 1, 'perf.budget.steady.p95_ms': 65 }).rows;
  assert.equal(judgeBudgets(rows, [a]).breached, 0);
  assert.equal(judgeBudgets(rows, [b]).breached, 2);
});

test('judgeBudgets: * expands to every phase; a build is the median of its runs with the range; a missing phase is unmeasured', () => {
  const runs = [16, 18, 30].map((p95, i) => runPhaseMetrics(...Object.values(tier0Run({ session: `S${i}`, steady: { p95 } })).reverse()));
  const j = judgeBudgets(parseBudgets({ 'perf.budget.*.p95_ms': 25, 'perf.budget.menu.p95_ms': 25 }).rows, runs);
  assert.deepEqual(j.results.map((r) => [r.budget, r.value, r.runs?.lo, r.runs?.hi]), [
    ['perf.budget.load.p95_ms', 90, 90, 90], ['perf.budget.steady.p95_ms', 18, 16, 30], ['perf.budget.menu.p95_ms', null, undefined, undefined]]);
  assert.equal(j.breached, 1);
  assert.equal(j.unmeasured, 1);
  assert.match(j.results[2].verdict, /no record in phase menu \(phases: load, steady\)/);
});

test('regressionGate: too few runs is insufficient, not a pass; only significant moves the WORSE way regress', () => {
  const row = (metric, delta, verdict = 'significant') => ({ metric, delta, verdict });
  const cmp = (n, rows) => ({ a: { runs: Array(n).fill('x') }, b: { runs: Array(n).fill('y') }, rows });
  assert.equal(regressionGate(cmp(2, [row('frame p95 ms', 5)])).verdict, 'insufficient');
  assert.equal(regressionGate(cmp(2, [row('frame p95 ms', 5)]), { minRuns: 2 }).verdict, 'regressed');
  const g = regressionGate(cmp(3, [row('frame p95 ms', -3), row('fn stepCars@cars.ts %js', 8), row('draw calls', 40, 'within noise'), row('rate delivered /sim-s', -0.4)]));
  assert.deepEqual(g.regressions.map((r) => r.metric), ['rate delivered /sim-s']);
  assert.equal(worseDirection('rate allocs /s', { allocs: 'max' }), 1);
  assert.equal(worseDirection('section crowd.bodies ms'), 1);
});

function gateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'slop-gate-'));
  mkdirSync(join(dir, 'runs'));
  const lines = [];
  for (const [i, s] of ['R1', 'R2'].entries()) {
    const { file, recs } = tier0Run({ session: s, build: 'b7', load: { worst: 600 + i * 40 } });
    writeFileSync(join(dir, 'runs', `${s}.json`), JSON.stringify(file));
    lines.push(...recs.map((r) => JSON.stringify(r)));
  }
  writeFileSync(join(dir, 'perf.jsonl'), lines.join('\n') + '\n');
  return dir;
}
const run = (dir, ...a) => spawnSync(process.execPath, [BIN, 'check', '--dir', dir, ...a], { encoding: 'utf8', env });

test('check CLI, run mode: a load-phase worst frame over its ceiling is a breach (exit 1), judged over the build\'s runs', () => {
  const dir = gateDir();
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.load.worst_ms': 500, 'perf.budget.steady.p95_ms': 25 }));
  const r = run(dir, '--build', 'b7');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /check build b7 — 2 run\(s\), judged per phase/);
  assert.match(r.stdout, /perf\.budget\.load\.worst_ms\s+620 \[600–640\] ≤ 500\s+✗ over by 1\.2x/);
  assert.match(r.stdout, /perf\.budget\.steady\.p95_ms\s+20 \[20–20\] ≤ 25\s+inside/);
});

test('check CLI: too few runs, or a budget nothing measured, cannot judge — exit 5, never a pass; a bad budget is exit 2', () => {
  const dir = gateDir();
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.steady.p95_ms': 25 }));
  assert.equal(run(dir, '--build', 'b7').status, 0);
  const few = run(dir, '--build', 'b7', '--min-runs', '3');
  assert.equal(few.status, 5);
  assert.match(few.stdout, /cannot judge: 2 run\(s\), --min-runs 3/);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.steady.p95_ms': 25, 'perf.budget.menu.worst_ms': 100 }));
  assert.equal(run(dir, '--build', 'b7').status, 5);
  assert.equal(run(dir, '--build', 'b7', '--allow-unmeasured').status, 0);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.steady.hitches_per_h': 5 }));
  const bad = run(dir, '--build', 'b7');
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /RELATIVE to the rolling median/);
});

test('check CLI: a coverage-mode run is refused as a timing measurement (exit 3)', () => {
  const dir = gateDir();
  const f = createRunFold({ session: 'COV', build: 'b7' });
  f.setConditions({ instrument: 'attach', mode: 'coverage' });
  f.addFrame({ phase: 'steady', at: '2026-10-02T01:00:00Z', frame: { medianMs: 40, p95Ms: 60 } });
  writeFileSync(join(dir, 'runs', 'COV.json'), JSON.stringify(f.toJSON()));
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.steady.p95_ms': 25 }));
  const r = run(dir, '--session', 'COV');
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /refused: this is not a timing run/);
});

function abDir(nPerSide, slower) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-gatecmp-'));
  mkdirSync(join(dir, 'runs'));
  const lines = [];
  for (const [side, build, base] of [['A', 'base', 16], ['B', 'next', 16 * slower]]) {
    for (let i = 0; i < nPerSide; i++) {
      const s = `${side}${i}`;
      const f = createRunFold({ session: s, build });
      f.setConditions({ instrument: 'attach', mode: 'timing', display: { refreshHz: 60 } });
      f.addFrame({ at: `2026-10-02T0${i}:00:00Z`, frame: { medianMs: base + i * 0.05, p95Ms: base * 1.2 + i * 0.05 }, render: { calls: 300 } });
      // Sections move COMPOSITION, so a real regression is not read as the machine.
      lines.push(JSON.stringify({ type: 'profile', session: s, build, tier: 1, at: `2026-10-02T0${i}:00:10Z`, frame: { bodyMs: base },
        sections: { sim: side === 'A' ? 8 : 8 + (slower - 1) * 16, render: 4 } }));
      writeFileSync(join(dir, 'runs', `${s}.json`), JSON.stringify(f.toJSON()));
    }
  }
  writeFileSync(join(dir, 'perf.jsonl'), lines.join('\n') + '\n');
  return dir;
}
const cmp = (dir, ...a) => spawnSync(process.execPath, [BIN, 'compare', 'base', 'next', '--dir', dir, '--fail-on-regression', '--allow-mismatch', ...a], { encoding: 'utf8', env });

test('compare --fail-on-regression: exit 1 on a significant regression, 0 when none, 5 with too few runs a side', () => {
  const reg = cmp(abDir(3, 1.25));
  assert.equal(reg.status, 1, reg.stdout + reg.stderr);
  assert.match(reg.stdout, /gate: ✗ REGRESSED — .*frame median ms \+4/);
  const same = cmp(abDir(3, 1.0));
  assert.equal(same.status, 0, same.stdout);
  assert.match(same.stdout, /gate: ✔ no significant regression/);
  const few = cmp(abDir(2, 1.25));
  assert.equal(few.status, 5, few.stdout);
  assert.match(few.stdout, /gate: cannot pass — 2 run\(s\) on A, 2 on B — the gate needs 3 a side/);
  assert.equal(cmp(abDir(2, 1.25), '--min-runs', '2').status, 1);
});

test('review fixes, snapshot mode: {max}/{min} budgets are judged (not compared as objects); a typo is exit 2; no budget rows is the no-budgets warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-gate-snap-'));
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', regime: 'hardware', frame: { p95Ms: 20 }, render: { calls: 900 } }));
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.draw_calls': { max: 300 } }));
  const r = run(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /perf\.budget\.draw_calls\s+900 \/ 300\s+over by 3\.0x/);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budgets.draw_calls': 300 }));
  assert.equal(run(dir).status, 2);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.conditions': { refreshHz: 60 } }));
  const none = run(dir);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no perf\.budget\.\* in budgets\.json/);
});

test('review fixes: a coverage session under the build id is not one of its timing runs — check and compare leave it out', () => {
  const dir = gateDir();
  writeFileSync(join(dir, 'perf.jsonl'), readFileSync(join(dir, 'perf.jsonl'), 'utf8')
    + JSON.stringify({ type: 'conditions', session: 'COV', build: 'b7', at: '2026-10-02T02:00:00Z', conditions: { instrument: 'attach', mode: 'coverage' } }) + '\n'
    + JSON.stringify({ type: 'heartbeat', session: 'COV', build: 'b7', at: '2026-10-02T02:01:00Z', medianFrameMs: 90, p95Ms: 120, tier: 0 }) + '\n');
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.steady.p95_ms': 25 }));
  const r = run(dir, '--build', 'b7');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 coverage run\(s\) of build b7 left out: COV/);
  assert.equal(run(dir, '--session', 'COV').status, 3, 'named by its session, it is refused');
});

test('review fixes: the machine verdict is a uniform SLOWDOWN only, and a rate that fell beside it still regresses', async () => {
  const { compareSides } = await import('../src/compare.js');
  const side = (label, frame, calls, rate = 2) => ({ label, runs: [0, 1, 2].map((i) => ({ session: `${label}${i}`, tier: 0, conditions: { instrument: 'attach' },
    metrics: { 'frame median ms': frame + i * 0.01, 'draw calls': calls, 'rate delivered /sim-s': rate + i * 0.001 }, fnShares: new Map([['f@a.js', 0.5], ['g@b.js', 0.5]]) })) });
  const faster = regressionGate(compareSides(side('A', 20, 300), side('B', 16, 300)));
  assert.equal(faster.verdict, 'pass');
  assert.ok(compareSides(side('A', 20, 300), side('B', 16, 300)).hostSuspect, 'a uniform speedup is still flagged, but never fails the gate');
  // A uniform 25% slowdown, composition still: the machine (exit 3)...
  const slower = compareSides(side('A', 20, 300), side('B', 25, 300));
  assert.equal(regressionGate(slower).verdict, 'machine');
  // ...but a throughput that fell beside it is not the machine's doing: a
  // slower machine runs fewer frames, not less game per game-second.
  const less = regressionGate(compareSides(side('A', 20, 300), side('B', 25, 300, 1.5)));
  assert.equal(less.verdict, 'regressed');
  assert.deepEqual(less.regressions.map((r) => r.metric), ['rate delivered /sim-s']);
  // Draw calls that moved mean the code moved: not the machine at all.
  assert.deepEqual(regressionGate(compareSides(side('A', 20, 300), side('B', 25, 360))).regressions.map((r) => r.metric), ['frame median ms', 'draw calls']);
});
