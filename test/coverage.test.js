// Coverage: what the run never CALLED, by function — a module that loaded
// and sat idle (bench content missing) reads as executed at module level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldCoverage, byModule, analyzeCoverage, changedRanges, changedFunctions } from '../src/coverage.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };

// [name, line, col, endLine, count, size]
const traffic = { url: 'http://localhost:5173/src/entities/TrafficLight.ts', size: 900, fns: [
  ['', 1, 0, 40, 1, 900], ['TrafficLight', 2, 2, 4, 0, 60], ['update', 5, 2, 20, 0, 400], ['setPhase', 21, 2, 23, 0, 50],
  ['TrafficLightManager', 25, 2, 27, 1, 40], ['tick', 28, 2, 32, 300, 120]] };
const cars = { url: 'http://localhost:5173/src/sim/cars.ts', size: 300, fns: [['', 1, 0, 10, 1, 300], ['stepCars', 2, 0, 9, 300, 200]] };
const dep = { url: 'http://localhost:5173/node_modules/.vite/deps/three.js', size: 99999, fns: [['', 1, 0, 9, 1, 99999], ['unused', 2, 0, 3, 0, 500]] };

test('the field miss: TrafficLight\'s module ran (its manager ticked an empty map) — its update was never called, and that is the finding', () => {
  const mods = byModule([traffic, cars, dep]);
  const a = analyzeCoverage(mods);
  assert.deepEqual(a.idle.map((m) => [m.file, m.called, m.total, m.idle]), [['src/entities/TrafficLight.ts', 2, 5, true]]);
  assert.deepEqual(a.idle[0].uncalled.map((f) => f.name), ['update', 'TrafficLight', 'setPhase']);
  assert.equal(analyzeCoverage(mods, { includeDeps: true }).idle.length, 2, '--all shows dependencies');
});

test('never loaded: repo code beside the loaded code, largest first — tests, tooling and declarations are not candidates', () => {
  const repoFiles = [
    { file: 'packages/client/src/entities/TrafficLight.ts', size: 900 }, { file: 'packages/client/src/sim/cars.ts', size: 300 },
    { file: 'packages/client/src/entities/Tram.ts', size: 5000 }, { file: 'packages/client/src/ui/Debug.ts', size: 800 },
    { file: 'packages/client/src/entities/Tram.test.ts', size: 9000 }, { file: 'packages/client/src/types.d.ts', size: 9000 },
    { file: 'packages/server/src/main.ts', size: 9999 }, { file: 'packages/client/vite.config.ts', size: 100 }, { file: 'README.md', size: 1 }];
  const a = analyzeCoverage(byModule([traffic, cars]), { repoFiles });
  assert.equal(a.matched, true);
  assert.deepEqual(a.never.map((f) => f.file), ['packages/client/src/entities/Tram.ts', 'packages/client/src/ui/Debug.ts']);
  assert.equal(a.idle[0].file, 'packages/client/src/entities/TrafficLight.ts', 'said by its repo path');
  assert.equal(analyzeCoverage(byModule([traffic]), { repoFiles: [{ file: 'other/x.ts', size: 1 }] }).matched, false);
});

test('foldCoverage sums a build\'s runs per function; a bundle is credited to sources through its map', () => {
  const run2 = { scripts: [{ ...traffic, fns: traffic.fns.map((f) => (f[0] === 'update' ? [...f.slice(0, 4), 7, f[5]] : f)) }] };
  const folded = foldCoverage([{ scripts: [traffic] }, run2]);
  assert.equal(folded[0].fns.find((f) => f[0] === 'update')[4], 7);
  assert.equal(folded[0].fns.find((f) => f[0] === 'tick')[4], 600);
  const sm = { original: (line) => (line === 3 ? { file: '../../src/entities/TrafficLight.ts', line: 5 } : line === 9 ? { file: '../../src/entities/TrafficLight.ts', line: 20 } : null) };
  const mods = byModule([{ url: 'http://h/assets/index-Ab12.js', size: 5000, fns: [['', 1, 0, 99, 1, 5000], ['k', 3, 10, 9, 0, 300]] }], { maps: [{ file: 'index-Ab12.js', sm }] });
  const m = mods.get('src/entities/TrafficLight.ts');
  assert.deepEqual(m.fns.map((f) => [f.name, f.line, f.endLine, f.count]), [['k', 5, 20, 0]]);
});

test('changed functions: git -U0 hunks → the innermost function each changed line sits in; module-level lines credit the module', () => {
  const diff = ['diff --git a/src/entities/TrafficLight.ts b/src/entities/TrafficLight.ts', '--- a/src/entities/TrafficLight.ts', '+++ b/src/entities/TrafficLight.ts',
    '@@ -6,2 +6,3 @@ class TrafficLight', '+x', '@@ -30 +31 @@', '+y', '@@ -38,0 +39,1 @@', '+z',
    '+++ b/shaders/car.glsl', '@@ -1 +1 @@', '+++ b/src/entities/Tram.ts', '@@ -1 +1 @@'].join('\n');
  const r = changedRanges(diff);
  assert.deepEqual(r.get('src/entities/TrafficLight.ts'), [[6, 8], [31, 31], [39, 39]]);
  const f = changedFunctions(byModule([traffic, cars]), r);
  assert.deepEqual(f.map((x) => [x.file, x.code, x.loaded, x.uncalled]), [
    ['src/entities/TrafficLight.ts', true, true, 1], ['shaders/car.glsl', false, undefined, undefined], ['src/entities/Tram.ts', true, false, undefined]]);
  assert.deepEqual(f[0].fns.map((x) => [x.name, x.count]), [['update', 0], ['tick', 300]]);
  assert.equal(f[0].moduleLevel, true);
});

test('pipeline coverage mode: precise function coverage instead of the sampler; the old document\'s scripts are not the new one\'s; mode is coverage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-cov-'));
  const calls = [];
  const send = async (m, p) => {
    calls.push(m);
    if (m === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
    if (m === 'Debugger.getScriptSource') return { scriptSource: p.scriptId === 'new' ? 'function a() {\n  return 1;\n}\na();\n' : 'x' };
    if (m === 'Profiler.takePreciseCoverage') return { result: [
      { scriptId: 'old', url: 'http://h/src/a.js', functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }] },
      { scriptId: 'new', url: 'http://h/src/a.js', functions: [{ functionName: '', ranges: [{ startOffset: 0, endOffset: 30, count: 1 }] }, { functionName: 'a', ranges: [{ startOffset: 0, endOffset: 28, count: 1 }] }] },
      { scriptId: 'ext', url: 'chrome-extension://abc/x.js', functions: [] }] };
    return {};
  };
  const p = createIncidentPipeline({ dir, send, log: () => {}, session: 'C', coverage: true });
  p.onEvent('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, frameId: 'F' } } });
  await p.start();
  p.onEvent('Debugger.scriptParsed', { scriptId: 'old', executionContextId: 1 });
  p.onEvent('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: true, frameId: 'F' } } });
  p.onEvent('Debugger.scriptParsed', { scriptId: 'new', executionContextId: 2 });
  await p.stop(); await p.stop();
  assert.deepEqual(calls.slice(0, 5), ['Page.getFrameTree', 'Debugger.enable', 'Debugger.setSkipAllPauses', 'Profiler.enable', 'Profiler.startPreciseCoverage']);
  assert.ok(!calls.includes('Profiler.start'), 'no sampler in a coverage run');
  assert.equal(calls.filter((c) => c === 'Profiler.takePreciseCoverage').length, 1);
  const cov = JSON.parse(readFileSync(join(dir, 'coverage', readdirSync(join(dir, 'coverage'))[0]), 'utf8'));
  assert.deepEqual(cov.scripts.map((s) => [s.url, s.fns.length]), [['http://h/src/a.js', 2]]);
  assert.deepEqual(cov.scripts[0].fns[1], ['a', 1, 0, 3, 1, 28, 0]);
  assert.equal(p.conditions.mode, 'coverage');
  assert.equal(p.conditions.sampler, undefined);
});

test('coverage CLI: no coverage run is exit 4 and says how to record one', () => {
  const r = spawnSync(process.execPath, [BIN, 'coverage', '--dir', mkdtempSync(join(tmpdir(), 'slop-cov-'))], { encoding: 'utf8', env });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /attach --coverage .*never shares a run with timings/);
});
