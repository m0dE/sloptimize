// Hitches on a clock: 70–78 ms frames exactly 15.0 s apart, each below the
// attribution floor, are one cause on a timer — found by cadence, and
// attributed from the samples of every occurrence pooled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPeriod, periodText } from '../src/periodic.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';
import { runCli, runDir } from './fixtures/run-dir.mjs';

test('findPeriod: the timer\'s spacing among unrelated hitches, with a frame of jitter and one missed occurrence', () => {
  const timer = [15000, 30016, 45000, 75016, 90000, 105000];   // 60 s missing
  const noise = [3200, 17700, 51000, 52000, 88000];
  const all = [...noise, ...timer];
  const r = findPeriod(all);
  assert.ok(Math.abs(r.periodMs - 15000) <= 20, `period ${r.periodMs}`);
  assert.deepEqual(r.members.map((i) => all[i]).sort((a, b) => a - b), timer);
  assert.equal(periodText(r.periodMs), 'every 15.0 s');
  assert.equal(periodText(750), 'every 750 ms');
  assert.equal(periodText(2500), 'every 2.50 s');
  assert.equal(findPeriod([1000, 9000, 12500, 30000, 31000]), null, 'no cadence in random hitches');
  assert.equal(findPeriod([0, 15000, 30000]), null, 'three is not yet a cadence');
});

const OFF = 1000;
const at = (ms) => new Date(Date.UTC(2026, 9, 12, 0, 0, 0) + ms).toISOString();
/** One chunk from `from` to `to` (page ms), a sample every 10 ms; `fnAt(t)` names the function. */
function chunk(from, to, fnAt) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)' } }];
  const ids = new Map(), samples = [], timeDeltas = [];
  for (let t = from + 10; t <= to; t += 10) {
    const fn = fnAt(t) ?? '(idle)';
    if (!ids.has(fn)) { ids.set(fn, nodes.length + 1); nodes.push({ id: nodes.length + 1, callFrame: { functionName: fn, url: fn.startsWith('(') ? '' : 'https://x/game.js', lineNumber: 11 } }); }
    samples.push(ids.get(fn)); timeDeltas.push(10_000);
  }
  return { nodes, samples, timeDeltas, startTime: (from + OFF) * 1000, endTime: (to + OFF) * 1000 };
}

test('gated hitches on a 15 s timer: cut from the chunks already stopped, pooled, and written as one hitch-pattern', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-period-'));
  const chunks = [], reads = [];
  const send = async (method, params) => {
    if (method === 'Profiler.stop') return { profile: chunks.shift() };
    if (method === 'Runtime.evaluate' && params?.expression === 'performance.now()') return reads.length ? { result: { value: reads.shift() } } : {};
    return {};
  };
  const p = createIncidentPipeline({ dir, send, log: () => {}, session: 'S', windowMs: 0 });
  await p.start();
  // One attributed hitch maps the page clock onto the sampler's.
  chunks.push(chunk(0, 1000, (t) => (t > 900 ? 'boot' : undefined)));
  reads.push(1000, 1000);
  await p.onRecord({ type: 'hitch', at: at(1000), frameMs: 100, frameSpan: [900, 1000], classification: [{ guess: 'long-script' }] });
  // Six 75 ms frames, 15 s apart: each under the 80 ms floor.
  const autosave = (t) => [15000, 30000, 45000, 60000, 75000, 90000].some((e) => t > e - 75 && t <= e) ? (t % 30 ? 'serializeWorld' : 'compress') : undefined;
  for (let k = 1; k <= 6; k++) await p.onRecord({ type: 'hitch', at: at(15000 * k), frameMs: 75, frameSpan: [15000 * k - 75, 15000 * k], phase: 'play', classification: [{ guess: 'long-script' }] });
  const gated = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.unattributed === 'below-floor');
  assert.equal(gated.length, 6, 'each one alone is below the floor');
  chunks.push(chunk(1000, 95000, autosave));
  await p.stop();
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const pat = lines.filter((r) => r.type === 'hitch-pattern');
  assert.equal(pat.length, 1);
  const r = pat[0];
  assert.equal(r.periodMs, 15000);
  assert.equal(r.occurrences, 6);
  assert.deepEqual(r.gates, { 'below-floor': 6 });
  assert.equal(r.phase, 'play');
  assert.equal(r.pooled.hitches, 6);
  assert.equal(r.topFrames[0].fn, 'serializeWorld');
  assert.ok(r.topFrames[0].share > 0.5, `share ${r.topFrames[0].share}`);
  assert.equal(r.unattributed, undefined);
  assert.equal(r.session, 'S');
});

test('report: the pattern line with its pooled cause, and ↻ on the hitches that keep the cadence', () => {
  const hitches = [1, 2, 3, 4, 5].map((k) => ({ type: 'hitch', at: at(15000 * k), frameMs: 74 + k % 3, medianMs: 16.7, unattributed: 'below-floor', topFrames: [], classification: [{ guess: 'long-script', evidence: 'e' }] }));
  const pattern = { type: 'hitch-pattern', at: at(80000), periodMs: 15000, occurrences: 5, spanSec: 60, frameMs: { min: 74, median: 75, max: 76 }, gates: { 'below-floor': 5 }, phase: 'play',
    pooled: { hitches: 5, frameMs: 375, sampledMs: 370 }, topFrames: [{ fn: 'serializeWorld', url: 'game.js:12', selfMs: 290, share: 0.773 }] };
  const out = runCli('report', '--dir', runDir({ lines: [...hitches, pattern] }));
  assert.match(out, /↻ hitches every 15\.0 s — timer-driven: 5× 74–76 ms over 60 s \(5 below-floor\) \[play\]; pooled over 5 frames \(370 ms sampled\): top serializeWorld@game\.js:12 290ms \(77% of those frames\)/);
  assert.match(out, /unattributed \(below-floor\) {2}↻ every 15\.0 s/);
  // Without the pipeline's record (an older attach), the cadence alone.
  const bare = runCli('report', '--dir', runDir({ lines: hitches }));
  assert.match(bare, /↻ hitches every 15\.0 s — timer-driven: 5× 74–76 ms over 60\.0 s/);
});

test('a cadence must beat chance: random hitches, a load\'s irregular frames and a crowd never read as timer-driven', async () => {
  const { findCadences } = await import('../src/periodic.js');
  let seed = 5; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let fake = 0;
  for (const [n, span] of [[300, 120000], [150, 60000], [40, 60000], [12, 60000]]) {
    for (let k = 0; k < 100; k++) if (findPeriod(Array.from({ length: n }, () => rnd() * span))) fake++;
  }
  assert.equal(fake, 0, 'the first version found a "period" in 20 of 20 random sets');
  // A load's reduced-rate frames: 300 long frames at irregular strides.
  let t = 0; const load = [];
  for (let k = 0; k < 300; k++) { t += [33, 50, 66, 83][Math.floor(rnd() * 4)]; load.push({ t, ms: 55 + rnd() * 10, phase: 'load' }); }
  assert.deepEqual(findCadences(load), []);
});

test('one kind of hitch per cadence: a 2.6 s stall is not an occurrence of the 75 ms autosave, and phases are apart', async () => {
  const { findCadences } = await import('../src/periodic.js');
  const ev = [{ t: 2600, ms: 2631, phase: 'play' }, ...[1, 2, 3, 4, 5].map((k) => ({ t: 15000 * k + (k % 2) * 20, ms: 70 + k, phase: 'play' })),
    ...[1, 2, 3, 4, 5, 6].map((k) => ({ t: 1000 * k, ms: 40, phase: 'load' }))];   // four alone are not enough to beat chance
  const c = findCadences(ev);
  assert.equal(c.length, 2);
  const play = c.find((x) => x.phase === 'play');
  assert.ok(Math.abs(play.periodMs - 15000) <= 20);
  assert.deepEqual([play.members.length, play.msMin, play.msMax], [5, 71, 75]);
  assert.equal(c.find((x) => x.phase === 'load').periodMs, 1000);
});

test('one timer whose frames snap to 50 and 66.7 ms by turns is one kind of hitch', async () => {
  const { findCadences } = await import('../src/periodic.js');
  const ev = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ t: 3000 * k + (k % 3) * 4, ms: k % 2 ? 66.7 : 50 }));
  const [c] = findCadences(ev);
  assert.equal(c?.members.length, 8);
});
