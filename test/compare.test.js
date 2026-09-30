// compare: every metric against its own run-to-run floor, and the machine
// flagged when it — not the code — changed. touched: did the run execute
// the changed files at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSides, runMetrics, tvd } from '../src/compare.js';
import { createRunFold, runBucket, touchedFiles, normPath, samePath } from '../src/runs.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const env = { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' };

// The field A/B: frame deltas inside a ~1.2 ms floor, one section that
// reproduced to two decimals across both reps.
function abLedger() {
  const lines = [];
  const runs = [['A', 's1', 26.1, 1.00], ['A', 's2', 27.3, 1.00], ['B', 's3', 26.5, 1.24], ['B', 's4', 27.6, 1.24]];
  runs.forEach(([build, session, body, collision], i) => {
    for (let k = 0; k < 3; k++) {
      lines.push({ type: 'profile', at: new Date(Date.UTC(2026, 8, 30, 10, i * 5, k * 10)).toISOString(), build, session, phase: 'steady',
        frame: { medianMs: body + 1.2, p95Ms: body + 4, bodyMs: body }, sections: { render: body - 10, collision, ai: 9 - collision } });
    }
    lines.push({ type: 'heartbeat', at: new Date(Date.UTC(2026, 8, 30, 10, i * 5, 40)).toISOString(), build, session, phase: 'steady', calls: 350, medianFrameMs: body + 1.2 });
  });
  const dir = mkdtempSync(join(tmpdir(), 'slop-cmp-'));
  writeFileSync(join(dir, 'perf.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return dir;
}

test('compare: the frame is within noise, the section that reproduced is significant', () => {
  const dir = abLedger();
  const c = JSON.parse(execFileSync(process.execPath, [BIN, 'compare', 'A', 'B', '--json', '--dir', dir], { encoding: 'utf8', env }));
  const row = (m) => c.rows.find((r) => r.metric === m);
  assert.deepEqual(c.a.runs, ['s1', 's2']);
  assert.equal(row('frame body ms').verdict, 'within noise');
  assert.equal(row('frame body ms').noise, 1.2);
  assert.equal(row('section collision ms').verdict, 'significant');
  assert.equal(row('section collision ms').delta, 0.24);
  assert.equal(row('section collision ms').noise, 0);
  assert.equal(row('draw calls').verdict, 'within noise');
  assert.equal(c.hostSuspect, undefined);
  const human = execFileSync(process.execPath, [BIN, 'compare', 'A', 'B', '--dir', dir], { encoding: 'utf8', env });
  assert.match(human, /section collision ms\s+1 \[1–1\]\s+1\.24 \[1\.24–1\.24\]\s+\+0\.24\s+0\s+✱ significant/);
  const bad = spawnSync(process.execPath, [BIN, 'compare', 'A', 'nope', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(bad.status, 4);
  assert.match(bad.stderr, /builds on this ledger: A, B/);
});

test('compare: one run a side is unproven, never "within noise"', () => {
  const r = (s, v) => ({ session: s, metrics: { 'frame median ms': v } });
  const c = compareSides({ label: 'A', runs: [r('a', 20)] }, { label: 'B', runs: [r('b', 30)] });
  assert.equal(c.rows[0].verdict, 'unproven');
});

test('compare: a uniform slowdown with unchanged composition is the machine; a moved share is the code', () => {
  const shares = (m) => new Map(Object.entries(m));
  const run = (s, frame, sh) => ({ session: s, tier: 0, metrics: { 'frame median ms': frame, 'draw calls': 300 }, fnShares: shares(sh) });
  const base = { stepCars: 0.5, render: 0.3, ai: 0.2 };
  const A = { label: 'A', runs: [run('a1', 20, base), run('a2', 20.4, { stepCars: 0.51, render: 0.29, ai: 0.2 })] };
  const host = compareSides(A, { label: 'B', runs: [run('b1', 29.2, base), run('b2', 29.6, base)] });
  assert.ok(host.hostSuspect);
  assert.match(host.warnings.join('\n'), /uniform slowdown \(frame median \+46%\) with unchanged composition .* suspect the machine/);
  const code = compareSides(A, { label: 'B', runs: [run('b1', 29.2, { stepCars: 0.66, render: 0.2, ai: 0.14 }), run('b2', 29.6, { stepCars: 0.66, render: 0.2, ai: 0.14 })] });
  assert.equal(code.hostSuspect, undefined);
  assert.ok(code.rows.find((r) => r.metric === 'fn stepCars %js'));
  assert.equal(tvd(shares({ x: 1 }), shares({ y: 1 })), 1);
});

test('compare: a tier-0 side against a tier-1 side is flagged as two instruments', () => {
  const c = compareSides({ label: 'A', runs: [{ session: 'a', tier: 0, metrics: { 'frame median ms': 34.7 } }] },
    { label: 'B', runs: [{ session: 'b', tier: 1, metrics: { 'frame median ms': 26.4 } }] });
  assert.match(c.warnings.join('\n'), /different instruments/);
});

test('runMetrics: a tier-0 run file supplies frame, draws and function shares', () => {
  const f = createRunFold({ session: 's', build: 'b' });
  f.addFrame({ at: '2026-09-30T10:00:00Z', frame: { medianMs: 16.7, p95Ms: 20 }, render: { calls: 120 } });
  f.addProfile({ nodes: [{ id: 1, callFrame: { functionName: 'tick', url: 'http://h/index-BOkDWhGO.js', lineNumber: 1 } }], samples: [1, 1] }, undefined, Date.parse('2026-09-30T10:00:10Z'));
  const m = runMetrics('s', [], f.toJSON());
  assert.equal(m.tier, 0);
  assert.equal(m.metrics['frame median ms'], 16.7);
  assert.equal(m.metrics['draw calls'], 120);
  assert.equal(m.fnShares.get('tick@index.js'), 1);   // hash stripped: A and B are different bundles
});

test('touched: paths match across dev-server URLs, source maps and repo roots; non-JS files are said, not counted', () => {
  assert.equal(normPath('http://localhost:5173/src/sim/cars.ts?t=1'), 'src/sim/cars.ts');
  assert.equal(normPath('webpack://app/./src/a.js'), 'src/a.js');
  assert.ok(samePath('src/sim/cars.ts', 'packages/client/src/sim/cars.ts'));
  assert.ok(!samePath('index.js', 'packages/client/index.js'), 'a bare name is never a suffix match');
  assert.ok(!samePath('node_modules/three/src/core/Object3D.js', 'src/core/Object3D.js'), 'a dependency is not the change');
  const f = createRunFold({ session: 's' });
  f.addProfile({
    nodes: [
      { id: 1, callFrame: { functionName: 'tick', url: 'http://h/src/loop.ts' }, children: [2] },
      { id: 2, callFrame: { functionName: 'stepCars', url: 'http://h/src/sim/cars.ts', lineNumber: 4 } },
    ],
    samples: [2, 2, 1, 2],
  }, 'steady');
  f.addProfile({ nodes: [{ id: 9, callFrame: { functionName: '(idle)' } }], samples: [9, 9, 9] }, 'steady');   // idle never counts as JS
  const t = touchedFiles(runBucket(f.toJSON()), ['packages/client/src/sim/cars.ts', 'src/entities/tram.ts', 'shaders/car.glsl']);
  assert.deepEqual(t.files.map((x) => [x.file, x.code, x.hit]), [['packages/client/src/sim/cars.ts', true, true], ['src/entities/tram.ts', true, false], ['shaders/car.glsl', false, undefined]]);
  assert.equal(t.files[0].heaviest, 3);
  assert.equal(t.jsSamples, 4);
  assert.equal(t.bound, 0.75);
  // A bundle position credited through its map.
  const sm = { original: (line) => (line === 5 ? { file: '../../src/entities/tram.ts', line: 3 } : null) };
  const g = createRunFold({ session: 's' });
  g.addProfile({ nodes: [{ id: 1, callFrame: { functionName: 'a', url: 'http://h/assets/index-BOkDWhGO.js', lineNumber: 4, columnNumber: 7 } }], samples: [1] });
  assert.equal(touchedFiles(runBucket(g.toJSON()), ['src/entities/tram.ts'], { maps: [{ file: 'index-BOkDWhGO.js', sm }] }).files[0].hit, true);
});

test('touched CLI: exit 1 and the warning when a changed code file got no samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-touch-'));
  mkdirSync(join(dir, 'runs'));
  const f = createRunFold({ session: 'S1', build: 'b', intervalUs: 10000 });
  f.addProfile({ nodes: [{ id: 1, callFrame: { functionName: 'stepCars', url: 'http://h/src/sim/cars.ts' } }], samples: [1, 1, 1] }, undefined, Date.parse('2026-09-30T10:00:00Z'));
  writeFileSync(join(dir, 'runs', 'S1.json'), JSON.stringify(f.toJSON()));
  const r = spawnSync(process.execPath, [BIN, 'touched', '--changed', 'src/sim/cars.ts,src/entities/tram.ts,a.glsl', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✔ src\/sim\/cars\.ts\s+3 samples under stepCars/);
  assert.match(r.stdout, /✗ src\/entities\/tram\.ts\s+0 samples/);
  assert.match(r.stdout, /0 samples in 1 of 2 changed code file\(s\)/);
  assert.equal(spawnSync(process.execPath, [BIN, 'touched', '--changed', 'src/sim/cars.ts', '--dir', dir], { encoding: 'utf8', env }).status, 0);
  const none = spawnSync(process.execPath, [BIN, 'touched', '--changed', 'src/sim/cars.ts', '--phase', 'load', '--dir', dir], { encoding: 'utf8', env });
  assert.equal(none.status, 4);
  assert.match(none.stdout, /no samples in phase load — phases in the run file: \?/);
});

test('resolveSide: tier-1 lines with no session are cut into runs at 5-minute silences; a comma list pools windows', async () => {
  const { resolveSide } = await import('../src/compare.js');
  const at = (min) => new Date(Date.UTC(2026, 8, 30, 10, min)).toISOString();
  const prof = (min, body, build = 'A') => ({ type: 'profile', at: at(min), build, frame: { bodyMs: body }, sections: { collision: 1 } });
  const recs = [prof(0, 20), prof(1, 20), prof(10, 21), prof(11, 21)];
  const side = resolveSide('A', recs, []);
  assert.equal(side.runs.length, 2);
  assert.deepEqual(side.runs.map((r) => r.metrics['frame body ms']), [20, 21]);
  const pooled = resolveSide(`${at(0)}..${at(2)},${at(9)}..${at(12)}`, recs, []);
  assert.equal(pooled.runs.length, 2);
  assert.match(resolveSide('nope', recs, []).error, /builds on this ledger: A/);
});
