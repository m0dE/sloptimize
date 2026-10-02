// Game counters as rates over the GAME's clock: a build that renders 20%
// faster covers 20% more simulated world per wall second, so its deliveries
// per wall second rise with no throughput gained. Per game-second they hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInjectScript } from '../src/attach.mjs';
import { emptyTally, foldTally, ratesOf, createRunFold } from '../src/runs.js';
import { compareSides, runMetrics } from '../src/compare.js';
import { compareConditions } from '../src/conditions.js';
import { parseBudgets, runPhaseMetrics, judgeBudgets } from '../src/gate.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };

function page() {
  const rafs = [], emitted = [];
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 1,
    PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'app://x' }, document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Map, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0;
  const frame = (dt) => { ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  return { ctx, frame, profiles: () => emitted.filter((e) => e.type === 'profile') };
}

test('page: counts and the game clock ride each window; a stopped counter reports zero; a clock that went backwards is flagged', () => {
  const p = page();
  let sim = 0;
  p.frame(16.7);   // the first rAF only seeds the clock
  for (let i = 0; i < 120; i++) { p.ctx.__sloptimizeClock('sim', (sim += 16.7 * 2), 1000); if (i % 10 === 0) p.ctx.__sloptimizeCount('delivered', 1); p.frame(16.7); }
  for (let i = 0; i < 120; i++) { p.ctx.__sloptimizeClock('sim', (sim += 16.7 * 2), 1000); p.frame(16.7); }
  p.ctx.__sloptimizeClock('sim', 0, 1000);   // a new game
  for (let i = 0; i < 120; i++) p.frame(16.7);
  const [a, b, c] = p.profiles();
  assert.deepEqual(a.tally, { delivered: 12 });
  assert.equal(a.clock.name, 'sim');
  assert.ok(Math.abs(a.clock.seconds - 4.008) < 0.05, `sim ran at 2× wall: ${a.clock.seconds}`);
  assert.ok(Math.abs(a.window.seconds - 2.004) < 0.05);
  assert.deepEqual(b.tally, { delivered: 0 }, 'a counter that stopped is reported, as zero');
  assert.equal(c.clock.reset, true);
});

test('the field bug: a build that renders 20% faster flatters itself per wall second, not per game second', () => {
  // Fixed timestep per frame: sim advances 16.7 ms per frame whatever the
  // frame took; deliveries are 1 per 0.5 s of SIM. A frames 20 ms, B 16.7 ms.
  const run = (frameMs) => {
    const acc = emptyTally();
    for (let w = 0; w < 10; w++) {
      const frames = 120, simSec = frames * 0.0167, wallSec = frames * frameMs / 1000;
      foldTally(acc, { tally: { delivered: simSec / 0.5 }, clock: { name: 'sim', seconds: simSec }, window: { seconds: wallSec } });
    }
    return acc;
  };
  const a = run(20), b = run(16.7);
  const perWall = (acc) => [...acc.wall.values()][0] / acc.wallSec;
  assert.ok(perWall(b) / perWall(a) > 1.19, 'per wall second: a "throughput win" of 20%');
  assert.deepEqual(ratesOf(a), ratesOf(b));
  assert.deepEqual(ratesOf(a), { denominator: 'clock:sim', per: 'sim-s', values: { delivered: 2 } });
});

test('foldTally: windows without the clock never enter a clock rate; a reset window is dropped; two clocks have no rate', () => {
  const acc = emptyTally();
  foldTally(acc, { tally: { x: 100 }, window: { seconds: 2 } });                                // before the game set a clock
  foldTally(acc, { tally: { x: 4 }, clock: { name: 'sim', seconds: 2 }, window: { seconds: 2 } });
  foldTally(acc, { tally: { x: 999 }, clock: { name: 'sim', seconds: 1, reset: true }, window: { seconds: 2 } });
  assert.deepEqual(ratesOf(acc).values, { x: 2 });
  assert.equal(ratesOf(foldTally(emptyTally(), { tally: { x: 4 }, window: { seconds: 2 } })).denominator, 'wall');
  const two = emptyTally();
  foldTally(two, { tally: { x: 1 }, clock: { name: 'sim', seconds: 1 }, window: { seconds: 1 } });
  foldTally(two, { tally: { x: 1 }, clock: { name: 'ticks', seconds: 1 }, window: { seconds: 1 } });
  assert.equal(ratesOf(two), null);
});

test('the run file keeps counters per phase; compare reads one row per rate over the clock; a wall side and a clock side do not compare', () => {
  const side = (label, rate, clock = true) => ({ label, runs: [0, 1, 2].map((i) => {
    const f = createRunFold({ session: `${label}${i}` });
    f.setConditions({ instrument: 'attach', counters: { denominator: clock ? 'clock:sim' : 'wall' } });
    f.addFrame({ phase: 'steady', at: '2026-10-02T00:00:00Z', frame: { medianMs: 16.7 }, window: { seconds: 2 }, over: { 50: 0 },
      tally: { delivered: (rate + i * 0.01) * 4 }, ...(clock ? { clock: { name: 'sim', seconds: 4 } } : {}) });
    const run = f.toJSON();
    assert.deepEqual(Object.keys(run.phases.steady.counters).sort(), clock ? ['clock', 'tally', 'wallSec'] : ['tally', 'wallSec']);
    return runMetrics(`${label}${i}`, [], run);
  }) });
  const c = compareSides(side('A', 2), side('B', 1.5));
  const row = c.rows.find((r) => r.metric === 'rate delivered /sim-s');
  assert.equal(row.verdict, 'significant');
  assert.equal(row.delta, -0.5);
  assert.equal(compareSides(side('A', 2), side('B', 2, false)).conditions.comparable, false);
  assert.equal(compareConditions([{ counters: { denominator: 'wall' } }], [{ counters: { denominator: 'clock:sim' } }]).mismatches[0].key, 'counterClock');
});

test('gate: a rate budget {min} reads the phase\'s rate over the clock, and says so', () => {
  const m = runPhaseMetrics([], { phases: { steady: { counters: { tally: { delivered: 30 }, wallSec: 10, clock: { name: 'sim', seconds: 20, tally: { delivered: 30 } } } } } });
  const j = judgeBudgets(parseBudgets({ 'perf.budget.steady.rate.delivered': { min: 2 } }).rows, [m]);
  assert.deepEqual([j.results[0].value, j.results[0].verdict, j.results[0].rule], [1.5, 'under by 1.3x', "per sim-s (the game's sim clock)"]);
});

test('pipeline: the denominator joins the run\'s conditions; report prints the rates, and warns when they are per wall second', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cnt-'));
  const p = createIncidentPipeline({ dir, send: async () => ({}), log: () => {}, session: 'S' });
  const prof = (clock) => ({ type: 'profile', phase: 'steady', at: '2026-10-02T00:00:00Z', frame: { medianMs: 16.7, p95Ms: 18 }, window: { frames: 120, seconds: 2 }, over: { 50: 0 },
    tally: { delivered: 6 }, ...(clock ? { clock: { name: 'sim', seconds: 4 } } : {}), tier: 0 });
  await p.onRecord(prof(false));
  await p.stop();
  const conds = () => readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'conditions');
  assert.equal(conds().at(-1).conditions.counters.denominator, 'wall');
  let out = spawnSync(process.execPath, [BIN, 'report', '--dir', dir], { encoding: 'utf8', env }).stdout;
  assert.match(out, /rates \(per wall second — no game clock: .*flatters itself.*\): delivered 3\/s/);
  const dir2 = mkdtempSync(join(tmpdir(), 'slop-cnt-'));
  const q = createIncidentPipeline({ dir: dir2, send: async () => ({}), log: () => {}, session: 'S' });
  await q.onRecord(prof(true));
  await q.stop();
  out = spawnSync(process.execPath, [BIN, 'report', '--dir', dir2], { encoding: 'utf8', env }).stdout;
  assert.match(out, /rates \(per second of the game's sim clock\): delivered 1\.5\/sim-s/);
});
