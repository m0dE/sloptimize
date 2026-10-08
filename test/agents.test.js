// Many-agent games (SPEC §3.16–3.18): behavioural equivalence from per-tick
// digests, the scaling sweep's fit, and worker threads as threads.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildInjectScript } from '../src/attach.mjs';
import { createTickLog, readTickLog, equivalence, digestDiff } from '../src/ticks.js';
import { fitExponent, shapeOf, sweepTable, levelDrive } from '../src/sweep.js';
import { threadRows, threadVerdict, clockRateOf } from '../src/threads.js';
import { createRunFold, runBucket } from '../src/runs.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'slop-agents-'));
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');
const cli = (...argv) => {
  try { return { code: 0, out: execFileSync(process.execPath, [BIN, ...argv], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status, out: String(e.stdout) }; }
};

/** A deterministic toy sim's tick log; `bugAt` perturbs the agents from that tick. */
function simLog(dir, session, { build, ticks = 500, bugAt, seed = 42, tickHz = 60, speedBias = 0 } = {}) {
  const log = createTickLog({ dir, session, build });
  log.sim({ seed, tickHz });
  let agents = seed, rng = seed * 7;
  for (let t = 1; t <= ticks; t++) {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    agents = (agents * 31 + rng + (bugAt && t >= bugAt ? 1 : 0)) % 1000000007;
    log.tick(t, { agents, rng }, { meanSpeed: 10 + Math.sin(t / 20) + speedBias * (t / ticks) });
  }
  return log.path;
}

test('equivalence: identical through every tick, or the first divergent tick and the part that diverged', () => {
  const dir = tmp();
  const a = readTickLog(simLog(dir, 'A'));
  assert.equal(equivalence(a, readTickLog(simLog(dir, 'A2'))).verdict, 'identical');
  const r = equivalence(a, readTickLog(simLog(dir, 'B', { bugAt: 184 })));
  assert.equal(r.verdict, 'diverged');
  assert.equal(r.tick, 184);
  assert.equal(r.identicalThrough, 183);
  assert.deepEqual(r.parts, ['agents']);
  assert.deepEqual(r.same, ['rng']);
  assert.deepEqual(digestDiff('0x3f2a', '0x3f2b'), ['(digest)']);
});

test('equivalence refuses runs that simulated different things, and says what weakens the answer', () => {
  const dir = tmp();
  const a = readTickLog(simLog(dir, 'A'));
  const r = equivalence(a, readTickLog(simLog(dir, 'B', { seed: 7 })));
  assert.equal(r.verdict, 'refused');
  assert.match(r.why, /seed: 42 vs 7/);
  const bare = createTickLog({ dir, session: 'C' });
  for (let t = 1; t <= 10; t++) bare.tick(t, 't' + t);
  const w = equivalence(readTickLog(bare.path), readTickLog(bare.path));
  assert.ok(w.warnings.some((x) => /seed is not declared/.test(x)));
  assert.ok(w.warnings.some((x) => /tick rate is not declared/.test(x)));
});

test('equivalence: too few common ticks is "cannot judge", never identical', () => {
  const dir = tmp();
  const r = equivalence(readTickLog(simLog(dir, 'A', { ticks: 300 })), readTickLog(simLog(dir, 'B', { ticks: 300 })), { ticks: 5000 });
  assert.equal(r.verdict, 'insufficient');
  assert.match(r.why, /only 300 of the 5000 ticks/);
});

test('tolerant mode: a stagger that changes state on purpose stays within tolerance; a real drift is located', () => {
  const dir = tmp();
  const a = readTickLog(simLog(dir, 'A'));
  const stagger = readTickLog(simLog(dir, 'S', { bugAt: 2 }));
  assert.equal(equivalence(a, stagger).verdict, 'diverged', 'exact mode sees the stagger at once');
  assert.equal(equivalence(a, stagger, { mode: 'tolerant' }).verdict, 'within');
  const drift = equivalence(a, readTickLog(simLog(dir, 'D', { speedBias: 3 })), { mode: 'tolerant' });
  assert.equal(drift.verdict, 'drifted');
  assert.equal(drift.first.value, 'meanSpeed');
  assert.ok(drift.first.from > 1 && drift.first.from < 500);
});

test('the page batches ticks and flushes them; knobs register for the sweep', () => {
  const emitted = [];
  const ctx = { requestAnimationFrame: () => {}, setInterval: () => 1, PerformanceObserver: class { observe() {} }, performance: { now: () => 0 },
    location: { href: 'x' }, document: { addEventListener() {} }, __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)), Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  vm.runInContext("__sloptimizeSim({ seed: 42, tickHz: 60 }); for (let t = 1; t <= 130; t++) __sloptimizeTick(t, { agents: t * 3 }, { speed: 1, bad: 'x' }); __sloptimizeTick('nope', 1)", ctx);
  const batches = emitted.filter((e) => e.type === 'ticks');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].entries.length, 120);
  assert.deepEqual(batches[0].entries[0], [1, { agents: 3 }, { speed: 1 }]);
  vm.runInContext('__sloptimizeFlush()', ctx);
  assert.equal(emitted.filter((e) => e.type === 'ticks')[1].entries.length, 10);
  assert.deepEqual(emitted.find((e) => e.type === 'sim'), { type: 'sim', at: emitted.find((e) => e.type === 'sim').at, seed: 42, tickHz: 60, tier: 0 });
  vm.runInContext("let cars = 0; __sloptimizeKnob('cars', (n) => { cars = n; }); __sloptimizeKnobs.cars(3000)", ctx);
  assert.equal(vm.runInContext('cars', ctx), 3000);
});

test('attach writes the page\'s ticks to ticks/<session>.jsonl, not the ledger', async () => {
  const dir = tmp();
  const p = createIncidentPipeline({ dir, send: async () => ({}), log: () => {}, session: 'S1', build: 'b1' });
  await p.onRecord({ type: 'sim', at: '2026-10-08T00:00:00Z', seed: 42, tickHz: 60 });
  await p.onRecord({ type: 'ticks', at: '2026-10-08T00:00:01Z', entries: [[1, 'aa'], [2, { agents: 'bb' }, { speed: 3 }]] });
  const log = readTickLog(join(dir, 'ticks', 'S1.jsonl'));
  assert.equal(log.build, 'b1');
  assert.deepEqual(log.sim, { seed: 42, tickHz: 60 });
  assert.deepEqual(log.ticks.get(2), { d: { agents: 'bb' }, v: { speed: 3 } });
  assert.ok(!readFileSync(join(dir, 'perf.jsonl'), 'utf8').includes('"ticks"'));
});

test('sloptimize equivalence: the verdict and exit code a CI step reads', () => {
  const dir = tmp();
  simLog(dir, 'sA', { build: 'before' });
  simLog(dir, 'sB', { build: 'after', bugAt: 300 });
  simLog(dir, 'sC', { build: 'other-seed', seed: 9 });
  const bad = cli('equivalence', 'before', 'after', '--dir', dir);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /first divergence at tick 300 \(identical through 299\)/);
  assert.match(bad.out, /differs: agents {3}\(identical: rng\)/);
  const same = cli('equivalence', 'before', 'sA', '--dir', dir, '--ticks', '500');
  assert.equal(same.code, 0);
  assert.match(same.out, /identical through tick 500/);
  assert.equal(cli('equivalence', 'before', 'other-seed', '--dir', dir).code, 3);
  assert.equal(cli('equivalence', 'before', 'nothing', '--dir', dir).code, 4);
  assert.equal(cli('equivalence', 'before', 'after', '--dir', dir, '--tolerant').code, 0);
});

test('the exponent comes with its interval; the label only when the interval earns it', () => {
  const lin = fitExponent([[1000, 0.7], [1000, 0.72], [3000, 2.1], [3000, 2.2], [5000, 3.5], [5000, 3.6], [9000, 6.3], [9000, 6.4]]);
  assert.ok(Math.abs(lin.k - 1) < 0.05);
  assert.equal(shapeOf(lin), 'linear');
  const sq = fitExponent([[1000, 0.4], [3000, 1.5], [5000, 3.1], [9000, 8.4]].flatMap(([n, y]) => [[n, y], [n, y * 1.02]]));
  assert.equal(shapeOf(sq), 'SUPER-LINEAR');
  assert.match(shapeOf(fitExponent([[1000, 1], [9000, 9]])), /two levels/);
  assert.match(shapeOf(fitExponent([[1000, 1], [3000, 9], [5000, 2], [9000, 30]])), /noisy/);
  assert.match(shapeOf({ k: 1.3, lo: 1.2, hi: 1.4 }, [1.0, 1.1, 1.6]), /bending upward/);
});

test('the sweep table: per-section cost against N, steps, fit, and where the frame crosses its budget', () => {
  const levels = [1000, 3000, 5000, 9000];
  const records = [], runs = [];
  for (const n of levels) for (const r of [0, 1]) {
    const session = `s${n}-${r}`;
    const jitter = 1 + r * 0.01;
    records.push({ type: 'phase-span', session, span: '1', phase: 'sweep', ms: 20000, scale: { cars: n },
      sections: { collision: [0.0007 * n * 1200 * jitter, 1200], junction: [0.0004 * (n / 1000) ** 1.4 * 1000 * 1200 * jitter, 1200] } });
    const fold = createRunFold({ session, intervalUs: 10_000 });
    fold.addFrame({ phase: 'sweep', frame: { medianMs: 4 + 0.0016 * n * jitter } });
    runs.push(fold.toJSON());
  }
  const t = sweepTable(levels.map((value) => ({ value, sessions: [`s${value}-0`, `s${value}-1`] })), records, runs);
  const row = (m) => t.rows.find((r) => r.metric === m);
  assert.equal(row('section collision ms/call').shape, 'linear');
  assert.equal(row('section junction ms/call').shape, 'SUPER-LINEAR');
  assert.equal(row('section junction ms/call').steps.length, 3);
  assert.equal(t.capacity.holds, 5000);
  assert.equal(t.capacity.over, 9000);
  assert.ok(t.capacity.n > 7000 && t.capacity.n < 9000, `capacity ${t.capacity.n}`);
  // A level AT the budget (vsync-locked) gives no slope to interpolate from.
  const runs2 = runs.map((r) => ({ ...r, phases: { sweep: { ...r.phases.sweep, frame: { windows: 1, medianMs: r.session.startsWith('s1000') ? 16.9 : 30 } } } }));
  const t2 = sweepTable(levels.map((value) => ({ value, sessions: [`s${value}-0`, `s${value}-1`] })), records, runs2);
  assert.deepEqual([t2.capacity.holds, t2.capacity.over, t2.capacity.n], [1000, 3000, undefined]);
});

test('a sweep level drive waits for the knob, sets it, settles, and measures in the sweep phase with N as its scale', async () => {
  const calls = [];
  const api = { until: async (e) => calls.push(['until', e]), eval: async (e) => calls.push(['eval', e]), phase: async (p) => calls.push(['phase', p]), wait: async (ms) => calls.push(['wait', ms]) };
  await levelDrive('cars', 3000, { settleS: 2, measureS: 10 })(api);
  assert.deepEqual(calls.slice(1), [['eval', 'globalThis.__sloptimizeKnobs["cars"](3000)'], ['phase', 'sweep-settle'], ['wait', 2000], ['phase', 'sweep'],
    ['eval', 'globalThis.__sloptimizeScale("cars", 3000)'], ['wait', 10000], ['phase', 'sweep-done']]);
  await assert.rejects(levelDrive('cars', 1)({ until: async () => { throw new Error('timeout'); } }), /never registered knob "cars"/);
});

const chunk = (fn, busyMs, wallMs, t0 = 0) => {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)' } }, { id: 2, callFrame: { functionName: '(idle)' } }, { id: 3, callFrame: { functionName: fn, url: 'sim.js', lineNumber: 4 } }];
  const n = Math.round(wallMs / 10), busy = Math.round(busyMs / 10);
  return { nodes, samples: Array.from({ length: n }, (_, i) => (i < busy ? 3 : 2)), timeDeltas: Array(n).fill(10_000), startTime: t0, endTime: t0 + wallMs * 1000 };
};

test('threads: busy per thread and per frame, and the verdict names the ceiling', () => {
  const fold = createRunFold({ session: 'S', intervalUs: 10_000 });
  fold.addProfile(chunk('draw', 2200, 10_000), 'play');
  fold.addProfile(chunk('stepAgents', 9700, 10_000), 'play', Date.now(), 'worker[sim]');
  fold.addFrame({ phase: 'play', frame: { medianMs: 16.2 } });
  const b = runBucket(JSON.parse(JSON.stringify(fold.toJSON())));
  const rows = threadRows(b, 16.2);
  assert.deepEqual(rows.map((r) => [r.name, r.busy, r.perFrameMs]), [['main', 0.22, 3.6], ['worker[sim]', 0.97, 15.7]]);
  assert.equal(threadVerdict(rows).verdict, 'worker-bound');
  assert.equal(threadVerdict(rows, { clockRate: 0.8 }).verdict, 'sim-behind', 'a decoupled sim falling behind is its own symptom');
  assert.equal(threadVerdict([{ name: 'main', busy: 0.9 }, { name: 'worker[a]', busy: 0.3 }]).verdict, 'main-bound');
  assert.equal(threadVerdict([{ name: 'main', busy: 0.9 }]), null, 'no worker, no thread verdict');
  assert.equal(clockRateOf({ clock: { seconds: 48, name: 'sim' }, wallSec: 60 }), 0.8);
});

test('workers: auto-attached paused, sampled, released — and anything else released untouched', async () => {
  const dir = tmp();
  const sent = [], toWorker = [];
  let profile = chunk('stepAgents', 900, 1000);
  const send = async (m) => { sent.push(m); return m === 'Profiler.stop' ? { profile: chunk('draw', 100, 1000) } : {}; };
  const sendTo = async (sid, m) => { toWorker.push([sid, m]); return m === 'Profiler.stop' ? { profile } : {}; };
  const p = createIncidentPipeline({ dir, send, sendTo, log: () => {}, session: 'W' });
  await p.start();
  assert.ok(sent.includes('Target.setAutoAttach'));
  p.onEvent('Target.attachedToTarget', { sessionId: 'w1', targetInfo: { type: 'worker', title: 'sim', url: 'blob:x/123' }, waitingForDebugger: true });
  p.onEvent('Target.attachedToTarget', { sessionId: 'f1', targetInfo: { type: 'iframe', url: 'https://ads' }, waitingForDebugger: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(toWorker.filter(([s]) => s === 'w1').map(([, m]) => m), ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
  assert.deepEqual(toWorker.filter(([s]) => s === 'f1').map(([, m]) => m), ['Runtime.runIfWaitingForDebugger'], 'an iframe is released, never profiled');
  await p.stop();
  const run = JSON.parse(readFileSync(join(dir, 'runs', 'W.json'), 'utf8'));
  const sim = Object.values(run.phases)[0].threads['worker[sim]'];
  assert.equal(sim.busyMs, 900);
  assert.equal(sim.fns[0][0], 'stepAgents');
  assert.deepEqual(run.conditions.sampler.workers, ['worker[sim]']);
  assert.ok(existsSync(join(dir, 'perf.jsonl')));
});

test('a worker whose sampler cannot start is still released: a paused worker is a hung game', async () => {
  const toWorker = [];
  const sendTo = async (sid, m) => { toWorker.push(m); if (m === 'Profiler.enable') throw new Error('nope'); return {}; };
  const p = createIncidentPipeline({ dir: tmp(), send: async () => ({}), sendTo, log: () => {} });
  await p.start();
  p.onEvent('Target.attachedToTarget', { sessionId: 'w1', targetInfo: { type: 'worker', url: 'sim.js' }, waitingForDebugger: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(toWorker.at(-1), 'Runtime.runIfWaitingForDebugger');
  await p.stop();
});
