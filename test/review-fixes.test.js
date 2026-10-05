// Regression tests for the bugs three reviewers reproduced on this branch
// before merge — each case is the reproduction, turned into an assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldCoverage, byModule, analyzeCoverage, changedRanges, changedFunctions } from '../src/coverage.js';
import { recurrenceOf } from '../src/history.js';
import { parseBudgets, runPhaseMetrics, judgeBudgets, regressionGate } from '../src/gate.js';
import { compareSides } from '../src/compare.js';
import { createRunFold } from '../src/runs.js';
import { buildInjectScript } from '../src/attach.mjs';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };
const T0 = Date.parse('2026-10-05T10:00:00Z');

// ── coverage ────────────────────────────────────────────────────────────────

test('coverage: a function starting where its script does is not folded into the top level', () => {
  const sc = { url: 'http://h/src/a.js', size: 59, fns: [['', 1, 0, 3, 1, 59], ['update', 1, 0, 2, 0, 40]] };
  const folded = foldCoverage([{ scripts: [sc] }]);
  assert.deepEqual(folded[0].fns.map((f) => f[0]), ['', 'update']);
  assert.deepEqual(analyzeCoverage(byModule(folded)).idle[0].uncalled.map((f) => f.name), ['update']);
});

test('coverage: through a map, a function\'s end is its last position (an indented closing line has no mapping at column 0)', () => {
  // Generated line 10..14 is src/traffic.js 1..5; line 14's only mapping is at column 2.
  const sm = { original: (line, col) => (line >= 10 && line <= 14 && !(line === 14 && col < 2) ? { file: 'src/traffic.js', line: line - 9 } : null) };
  const mods = byModule([{ url: 'http://h/assets/app.js', size: 900, fns: [['update', 10, 2, 14, 0, 120, 3]] }], { maps: [{ file: 'app.js', sm }] });
  const f = changedFunctions(mods, new Map([['src/traffic.js', [[3, 3]]]]));
  assert.deepEqual(f[0].fns, [{ name: 'update', line: 1, count: 0 }], 'line 3 is inside update (1..5), not module-level');
  assert.equal(f[0].uncalled, 1);
});

test('coverage: a scope-hoisted module (top level not visible through the map) with uncalled functions is idle, never "nothing ran"', () => {
  const sm = { original: () => ({ file: 'src/traffic.js', line: 1 }) };
  const a = analyzeCoverage(byModule([{ url: 'http://h/app.js', size: 9, fns: [['update', 3, 0, 5, 0, 50, 0]] }], { maps: [{ file: 'app.js', sm }] }));
  assert.deepEqual(a.silent, []);
  assert.equal(a.idle[0].file, 'src/traffic.js');
});

test('coverage: git diff paths — C-quoted, tab-terminated, and a new file header that resets the current file', () => {
  const d = ['diff --git a/a.js b/a.js', '+++ b/a.js', '@@ -2 +2 @@', 'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '+++ "b/caf\\303\\251.js"', '@@ -3 +3 @@',
    'diff --git a/x.bin b/x.bin', 'Binary files differ', '@@ -9 +9 @@', '+++ b/my file.js\t', '@@ -1,2 +1,2 @@'].join('\n');
  assert.deepEqual([...changedRanges(d)], [['a.js', [[2, 2]]], ['café.js', [[3, 3]]], ['my file.js', [[1, 2]]]]);
});

test('coverage CLI: --changed or --since with no value is exit 2 (exit 1 means changed code never ran)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-rf-'));
  mkdirSync(join(dir, 'coverage'));
  writeFileSync(join(dir, 'coverage', 'S.json'), JSON.stringify({ type: 'coverage', session: 'S', at: '2026-10-05T10:00:00Z', scripts: [] }));
  for (const flag of ['--changed', '--since']) assert.equal(spawnSync(process.execPath, [BIN, 'coverage', '--dir', dir, flag], { encoding: 'utf8', env }).status, 2);
});

// ── recurrence ──────────────────────────────────────────────────────────────

test('recurrence: bursts of 1 s hitches with long irregular pauses are not a 1 s timer (a gap is at most three periods)', () => {
  const ts = [0, 1, 2, 49.3, 50.3, 264, 265, 266, 354.1, 355.1];
  assert.equal(recurrenceOf(ts.map((s) => ({ t: T0 + s * 1000, session: 'S' }))), undefined);
});

test('recurrence: two sessions\' 15 s timers interleaving in time are each a timer', () => {
  const occ = [...[0, 15, 30, 45, 60].map((s) => ({ t: T0 + s * 1000, session: 'A' })), ...[7, 22, 37, 52, 67].map((s) => ({ t: T0 + s * 1000, session: 'B' }))];
  assert.equal(recurrenceOf(occ).periodSec, 15);
});

// ── the gate ────────────────────────────────────────────────────────────────

const side = (label, n, f) => ({ label, runs: [...Array(n)].map((_, i) => ({ session: `${label}${i}`, tier: 0, conditions: { instrument: 'attach' }, metrics: f(i), fnShares: new Map([['f@a.js', 0.5], ['g@b.js', 0.5]]) })) });

test('gate: a p95 that more than doubled inside a 12% uniform slowdown is a regression, not "the machine"', () => {
  const c = compareSides(side('A', 3, (i) => ({ 'frame median ms': 16.1 + i * 0.01, 'frame p95 ms': 18.1 + i * 0.01 })), side('B', 3, (i) => ({ 'frame median ms': 18.1 + i * 0.01, 'frame p95 ms': 40.1 + i * 0.01 })));
  assert.ok(c.hostSuspect);
  const g = regressionGate(c);
  assert.equal(g.verdict, 'regressed');
  assert.deepEqual(g.regressions.map((r) => r.metric), ['frame p95 ms']);
});

test('gate: a metric only one run of a side measured is insufficient, not a pass', () => {
  const c = compareSides(side('A', 3, () => ({ 'frame median ms': 16, 'draw calls': 100 })), side('B', 3, (i) => ({ 'frame median ms': 16, ...(i === 0 ? { 'draw calls': 300 } : {}) })));
  assert.equal(regressionGate(c).verdict, 'insufficient');
  assert.match(regressionGate(c).why, /draw calls \(3\/1 runs\)/);
});

test('gate: per-phase metrics prefer the run file\'s windows to heartbeats\' rolling rings (check agrees with compare)', () => {
  const beats = [...Array(5)].map((_, i) => ({ type: 'heartbeat', phase: 'play', medianFrameMs: 25, p95Ms: 30, at: new Date(T0 + i * 60_000).toISOString() }));
  const m = runPhaseMetrics(beats, { phases: { play: { frame: { medianMs: 16.7, p95Ms: 18 } } } });
  assert.equal(m.get('play').p95_ms, 18);
  assert.equal(runPhaseMetrics(beats, null).get('play').p95_ms, 30, 'heartbeats still stand alone');
});

test('gate: each window\'s longest frame makes the worst frame exact, whatever window a hitch was credited to', () => {
  const f = createRunFold({ session: 'S' });
  f.addFrame({ phase: 'load', at: '2026-10-05T10:00:00Z', frame: { medianMs: 60, p95Ms: 90, maxMs: 150 }, window: { frames: 120, seconds: 7 }, over: { 50: 40, 100: 1, 200: 0, 500: 0, 1000: 0 } });
  const m = runPhaseMetrics([{ type: 'hitch', phase: 'play', frameMs: 120, at: '2026-10-05T10:00:01Z' }], f.toJSON());
  assert.deepEqual(m.get('load').worst, { lo: 150, hi: 150 });
  assert.equal(judgeBudgets(parseBudgets({ 'perf.budget.load.worst_ms': 130 }).rows, [m]).results[0].breached, true);
});

test('gate: perf.conditions must be an object of known conditions; prototype names are not budgets', () => {
  assert.match(parseBudgets({ 'perf.conditions': '60hz' }).errors[0], /an object of conditions/);
  assert.match(parseBudgets({ 'perf.conditions': { refreshhz: 60 } }).errors[0], /perf\.conditions\.refreshhz: not a condition/);
  assert.equal(parseBudgets({ 'perf.budget.constructor': 1, 'perf.budget.play.toString': 1 }).errors.length, 2);
});

function runDir() {
  const dir = mkdtempSync(join(tmpdir(), 'slop-rf-'));
  mkdirSync(join(dir, 'runs'));
  return dir;
}

test('check run mode: a software renderer\'s timings are skipped, not judged; a budget one run of three measured is cannot-judge', () => {
  const dir = runDir();
  for (const [i, s] of ['R1', 'R2', 'R3'].entries()) {
    const f = createRunFold({ session: s, build: 'b' });
    f.setConditions({ instrument: 'attach', regime: 'software' });
    f.addFrame({ phase: 'play', at: `2026-10-05T10:0${i}:00Z`, frame: { medianMs: 40, p95Ms: 60 }, render: { calls: 300 } });
    if (i === 0) f.addFrame({ phase: 'boss', at: `2026-10-05T10:0${i}:30Z`, frame: { medianMs: 40, p95Ms: 60 }, render: { calls: 900 } });
    writeFileSync(join(dir, 'runs', `${s}.json`), JSON.stringify(f.toJSON()));
  }
  writeFileSync(join(dir, 'perf.jsonl'), '');
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.play.p95_ms': 20, 'perf.budget.play.draw_calls': 500 }));
  const r = spawnSync(process.execPath, [BIN, 'check', '--dir', dir, '--build', 'b'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /perf\.budget\.play\.p95_ms .*skipped \(counters-only/);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.boss.draw_calls': 1000 }));
  const thin = spawnSync(process.execPath, [BIN, 'check', '--dir', dir, '--build', 'b', '--min-runs', '3'], { encoding: 'utf8', env });
  assert.equal(thin.status, 5, thin.stdout);
  assert.match(thin.stdout, /perf\.budget\.boss\.draw_calls measured in 1 of 3 run\(s\)/);
});

test('check --build reads a runtime that stamps no session, cut into runs at 5-minute silences', () => {
  const dir = runDir();
  const lines = [0, 1, 2, 20, 21, 22].map((m) => JSON.stringify({ type: 'heartbeat', build: 'old', at: new Date(T0 + m * 60_000).toISOString(), medianFrameMs: 16, p95Ms: 18 }));
  writeFileSync(join(dir, 'perf.jsonl'), lines.join('\n') + '\n');
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.?.p95_ms': 20 }));
  const r = spawnSync(process.execPath, [BIN, 'check', '--dir', dir, '--build', 'old', '--min-runs', '2'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /2 run\(s\)/);
});

// ── page and pipeline ───────────────────────────────────────────────────────

test('page: a game clock named past 40 characters still counts its seconds', () => {
  const rafs = [], emitted = [];
  const ctx = { requestAnimationFrame: (cb) => rafs.push(cb), setInterval: () => 1, PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)),
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Map, Object };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0, sim = 0;
  const name = 'a-very-long-simulation-clock-name-over-forty-chars';
  for (let i = 0; i < 122; i++) { ctx.__sloptimizeClock(name, (sim += 16), 1000); ts += 16; const cb = rafs.pop(); rafs.length = 0; cb(ts); }
  const p = emitted.find((e) => e.type === 'profile');
  assert.ok(p.clock.seconds > 1.8, JSON.stringify(p.clock));
});

test('pipeline: stop() twice is one stop — one end snapshot, one ledger line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-rf-'));
  let p;
  const send = async (m) => { if (m === 'HeapProfiler.takeHeapSnapshot') { await new Promise((r) => setTimeout(r, 5)); p.onEvent('HeapProfiler.addHeapSnapshotChunk', { chunk: '{}' }); } return {}; };
  p = createIncidentPipeline({ dir, send, log: () => {}, session: 'S', heap: { snapshots: true }, setTimeout: () => null, clearTimeout: () => {} });
  await p.start();
  await Promise.all([p.stop(), p.stop()]);
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((r) => r.type === 'heap-snapshot').length, 1);
  assert.equal(readFileSync(join(dir, 'heap', 'S-end.heapsnapshot'), 'utf8'), '{}');
});
