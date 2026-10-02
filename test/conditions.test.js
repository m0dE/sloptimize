// Run provenance: what a run was measured under, and the refusal to set two
// runs side by side when that differs. Every case here is a false
// conclusion this tool was once party to, or would have been.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConditions, compareConditions, expectConditions, describeConditions, vsyncNote } from '../src/conditions.js';
import { compareSides } from '../src/compare.js';
import { createRunFold } from '../src/runs.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };

const attached = (over = {}) => ({ instrument: 'attach', mode: 'timing', regime: 'hardware', sampler: { intervalUs: 10000 },
  display: { refreshHz: 60, from: 'raf-cadence' }, gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.3623)',
  device: { platform: 'Windows', cores: 16, vw: 1600, vh: 900, dpr: 1 }, browser: 'Chrome/131.0.6778.86', recorder: { minHitchMs: 25, slots: true }, ...over });

test('the vsync case: an in-app run beside an attached run is refused on the instrument, before any delta is read', () => {
  const c = compareSides(
    { label: 'in-app', runs: [{ session: 'a', tier: 1, metrics: { 'frame median ms': 26.37 } }] },
    { label: 'attached', runs: [{ session: 'b', tier: 0, metrics: { 'frame median ms': 34.7 } }] });
  assert.equal(c.conditions.comparable, false);
  assert.deepEqual(c.conditions.mismatches.map((m) => [m.key, m.a, m.b]), [['instrument', 'in-app', 'attach']]);
});

test('a different display refresh is material: 60 Hz against 144 Hz does not compare', () => {
  const r = compareConditions([attached()], [attached({ display: { refreshHz: 144 } })]);
  assert.equal(r.comparable, false);
  const m = r.mismatches.find((x) => x.key === 'refreshHz');
  assert.equal(m.a, '60 Hz'); assert.equal(m.b, '144 Hz');
  assert.match(m.why, /whole vsyncs/);
});

test('a coverage-mode run is never a timing side', () => {
  const r = compareConditions([attached()], [attached({ mode: 'coverage' })]);
  assert.equal(r.comparable, false);
  assert.equal(r.mismatches[0].key, 'mode');
});

test('a side whose own runs disagree is refused as mixed', () => {
  const r = compareConditions([attached(), attached({ display: { refreshHz: 120 } })], [attached()]);
  assert.equal(r.comparable, false);
  assert.deepEqual(r.mismatches.map((m) => [m.key, m.side, m.values]), [['refreshHz', 'A', ['60 Hz', '120 Hz']]]);
});

test('minor differences are said, not refused; a driver update is not a new GPU; a 5% resize is the same size', () => {
  const r = compareConditions([attached()], [attached({ browser: 'Chrome/132.0.1', recorder: { minHitchMs: 40, slots: true },
    gpu: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11-32.0.15.6094)',
    device: { platform: 'Windows', cores: 16, vw: 1600, vh: 860, dpr: 1 } })]);
  assert.equal(r.comparable, true);
  assert.deepEqual(r.mismatches.map((m) => [m.key, m.material]), [['browser', false], ['minHitchMs', false]]);
  const big = compareConditions([attached()], [attached({ device: { platform: 'Windows', cores: 16, vw: 1600, vh: 900, dpr: 2 } })]);
  assert.equal(big.comparable, false);
  assert.equal(big.mismatches[0].key, 'pixels');
});

test('a run written before conditions existed is unverified, not incomparable', () => {
  const r = compareConditions([{ instrument: 'attach' }], [attached()]);
  assert.equal(r.comparable, true);
  assert.ok(r.unverified.some((u) => u.key === 'refreshHz' && u.missing.includes('A')));
});

test('phase mixes differ → refused, unless both sides were scoped to one phase', () => {
  const a = attached({ phases: ['load', 'steady'] }), b = attached({ phases: ['load'] });
  assert.equal(compareConditions([a], [b]).comparable, false);
  assert.equal(compareConditions([a], [b], { phaseScoped: true }).comparable, true);
});

test('runConditions overlays: ledger-implied < run file < the session\'s last conditions line; phases are what the run carried', () => {
  const f = createRunFold({ session: 'S' });
  f.setConditions({ instrument: 'attach', sampler: { intervalUs: 10000 } });
  f.addFrame({ phase: 'steady', frame: { medianMs: 16.7 }, at: '2026-10-02T00:00:00Z' });
  const run = f.toJSON();
  assert.deepEqual(run.conditions.phases, ['steady']);
  const c = runConditions([{ type: 'hitch', phase: 'load', tier: 0 }, { type: 'conditions', session: 'S', conditions: { display: { refreshHz: 60 } } }], run);
  assert.equal(c.instrument, 'attach');
  assert.equal(c.display.refreshHz, 60);
  assert.deepEqual(c.phases, ['load', 'steady']);
  assert.equal(runConditions([{ type: 'profile', regime: 'hardware' }]).instrument, 'in-app');
});

test('expectConditions: budgets set for 60 Hz refuse a 144 Hz measurement; an unrecorded expectation is unverified', () => {
  assert.equal(expectConditions(attached(), { refreshHz: 60, regime: 'hardware', pixels: '1600x900' }).comparable, true);
  const r = expectConditions(attached({ display: { refreshHz: 144 } }), { refreshHz: 60 });
  assert.equal(r.comparable, false);
  assert.equal(r.mismatches[0].a, '144 Hz');
  assert.deepEqual(expectConditions({ instrument: 'attach' }, { refreshHz: 60 }).unverified.map((u) => u.key), ['refreshHz']);
  assert.match(expectConditions(attached(), { refreshRate: 60 }).mismatches[0].why, /not a condition/);
});

test('describeConditions and the vsync note', () => {
  assert.match(describeConditions(attached()), /^attach · timing · 60 Hz · hardware · ANGLE .* · 1600×900@1 · Chrome\/131/);
  assert.equal(describeConditions({}), 'conditions unrecorded');
  assert.match(vsyncNote(attached(), 34.7), /display 60 Hz: frames present on whole vsyncs \(16\.7, 33\.3, 50 ms …\).*34\.7 ms median/);
  assert.equal(vsyncNote(attached(), 16.6), undefined, 'one vsync: nothing to explain');
  assert.equal(vsyncNote({ instrument: 'attach' }, 34.7), undefined, 'no refresh rate, no claim');
});

test('pipeline: the page\'s conditions merge into the run\'s block, refine an unknown regime, land in the ledger and the run file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cond-'));
  const send = async (m) => (m === 'Profiler.stop' ? { profile: { nodes: [{ id: 1, callFrame: { functionName: 'f', url: 'x.js' } }], samples: [1] } } : {});
  const p = createIncidentPipeline({ dir, send, log: () => {}, session: 'S1', build: 'b1', conditions: { headless: false, recorder: { minHitchMs: 25, slots: true } } });
  await p.start();
  await p.onRecord({ type: 'profile', phase: 'steady', at: '2026-10-02T00:00:00Z', frame: { medianMs: 16.7 }, tier: 0 });
  await p.onRecord({ type: 'conditions', phase: 'steady', display: { refreshHz: 60, from: 'raf-cadence' }, gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2)', device: { platform: 'macOS', cores: 8 }, tier: 0 });
  await p.stop();
  const line = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.type === 'conditions');
  assert.equal(line.session, 'S1');
  assert.equal(line.phase, undefined, 'a --phase filter must not drop the run\'s conditions');
  assert.deepEqual(Object.keys(line.conditions).sort(), ['device', 'display', 'gpu', 'headless', 'instrument', 'mode', 'recorder', 'regime', 'sampler', 'v']);
  assert.equal(line.conditions.regime, 'hardware');
  assert.equal(p.regime, 'hardware');
  const run = JSON.parse(readFileSync(join(dir, 'runs', 'S1.json'), 'utf8'));
  assert.equal(run.conditions.display.refreshHz, 60);
  assert.deepEqual(run.conditions.phases, ['steady']);
  // A software rasterizer says so.
  const q = createIncidentPipeline({ dir: mkdtempSync(join(tmpdir(), 'slop-cond-')), send, log: () => {} });
  await q.onRecord({ type: 'conditions', gpu: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)' });
  assert.equal(q.regime, 'software');
});

function ledgerDir(refreshB) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cmpc-'));
  mkdirSync(join(dir, 'runs'));
  const lines = [];
  const runs = [['A1', 'base', 60], ['A2', 'base', 60], ['B1', 'next', refreshB], ['B2', 'next', refreshB]];
  runs.forEach(([s, build, hz], i) => {
    const f = createRunFold({ session: s, build });
    f.setConditions(attached({ display: { refreshHz: hz } }));
    f.addFrame({ frame: { medianMs: 16.6 + i * 0.01, p95Ms: 18 }, render: { calls: 300 }, at: `2026-10-02T0${i}:00:00Z` });
    writeFileSync(join(dir, 'runs', `${s}.json`), JSON.stringify(f.toJSON()));
    lines.push(JSON.stringify({ type: 'conditions', session: s, build, at: `2026-10-02T0${i}:00:01Z`, tier: 0, conditions: attached({ display: { refreshHz: hz } }) }));
  });
  writeFileSync(join(dir, 'perf.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('compare CLI: refuses (exit 3) across displays and names the difference; --allow-mismatch reads under a banner; same display compares', () => {
  const dir = ledgerDir(144);
  const r = spawnSync(process.execPath, [BIN, 'compare', 'base', 'next', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /A: attach · timing · 60 Hz/);
  assert.match(r.stdout, /B: attach · timing · 144 Hz/);
  assert.match(r.stdout, /refused: the sides were measured under different conditions/);
  assert.match(r.stdout, /✗ display refresh: 60 Hz vs 144 Hz — a frame lasts whole vsyncs/);
  const j = spawnSync(process.execPath, [BIN, 'compare', 'base', 'next', '--dir', dir, '--json'], { encoding: 'utf8', env });
  assert.equal(j.status, 3);
  assert.equal(JSON.parse(j.stdout).refused, true);
  const allow = spawnSync(process.execPath, [BIN, 'compare', 'base', 'next', '--dir', dir, '--allow-mismatch'], { encoding: 'utf8', env });
  assert.equal(allow.status, 0);
  assert.match(allow.stdout, /INCOMPARABLE CONDITIONS/);
  assert.match(allow.stdout, /frame median ms/);
  const ok = spawnSync(process.execPath, [BIN, 'compare', 'base', 'next', '--dir', ledgerDir(60)], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stdout);
  assert.doesNotMatch(ok.stdout, /refused|INCOMPARABLE/);
});

test('check CLI: perf.conditions in budgets.json refuses a measurement taken under others (exit 3); a match checks budgets as before', () => {
  const dir = ledgerDir(144);
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', session: 'B1', tier: 0, regime: 'hardware', frame: { medianMs: 7, p95Ms: 8 }, render: { calls: 300 } }));
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.draw_calls': 500, 'perf.conditions': { refreshHz: 60 } }));
  const r = spawnSync(process.execPath, [BIN, 'check', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stdout, /measured under: attach · timing · 144 Hz/);
  assert.match(r.stdout, /✗ display refresh: 144 Hz vs 60/);
  writeFileSync(join(dir, 'budgets.json'), JSON.stringify({ 'perf.budget.draw_calls': 500, 'perf.conditions': { refreshHz: 144 } }));
  const ok = spawnSync(process.execPath, [BIN, 'check', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /budgets: 1 checked, 0 breached/);
});
