// The longest frames, explained: a frame past ATTRIBUTE_LONG_FRAME_MS ignores
// the cooldown; a hitch is attributed from the samples INSIDE its own frame
// (the page clock mapped onto the sampler's), not from whichever chunk its
// rotation happened to stop; and the top functions carry their hot LINES
// from V8's positionTicks — the statement inside the big update().
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIncidentPipeline, topFramesFromProfile, sliceFrame, ATTRIBUTE_LONG_FRAME_MS } from '../src/incident-pipeline.mjs';
import { createRunFold, runBucket, heaviestSelf, hotLines } from '../src/runs.js';

const OFF = 1000;   // sampler clock (ms) − page clock (ms) in these fixtures
const URL = 'https://x/assets/index-BU6aIbGf.js';

/** A chunk sampled every 10 ms of page time from `from` to `to`; `segs`
 *  say which function ran when, and `hot(t)` which of its lines. */
function chunk(from, to, segs) {
  const nodes = [{ id: 1, callFrame: { functionName: '(root)' } }];
  const ids = new Map();
  const samples = [], timeDeltas = [];
  let last = (from + OFF) * 1000;
  for (let t = from + 10; t <= to; t += 10) {
    const seg = segs.find((s) => t > s.from && t <= s.to);
    const fn = seg ? seg.fn : '(idle)';
    if (!ids.has(fn)) {
      ids.set(fn, nodes.length + 1);
      nodes.push({ id: nodes.length + 1, callFrame: { functionName: fn, url: seg ? URL : '', lineNumber: seg?.line ?? 0 }, positionTicks: [] });
    }
    const id = ids.get(fn);
    samples.push(id);
    const us = (t + OFF) * 1000;
    timeDeltas.push(us - last); last = us;
    if (seg?.hot) {
      const n = nodes[id - 1], line = seg.hot(t);
      const e = n.positionTicks.find((x) => x.line === line);
      if (e) e.ticks++; else n.positionTicks.push({ line, ticks: 1 });
    }
  }
  return { nodes, samples, timeDeltas, startTime: (from + OFF) * 1000, endTime: (to + OFF) * 1000 };
}

test('the top function carries its hot lines, summed across code versions and call paths', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' } },
      { id: 2, callFrame: { functionName: 'update', url: URL, lineNumber: 84907 }, positionTicks: [{ line: 84931, ticks: 40 }, { line: 84944, ticks: 22 }, { line: 84931, ticks: 21 }] },
      // the same function reached by another call path: one cost, not two rows
      { id: 3, callFrame: { functionName: 'update', url: URL, lineNumber: 84907 }, positionTicks: [{ line: 84950, ticks: 17 }] },
    ],
    samples: [...Array(83).fill(2), ...Array(17).fill(3)],
    timeDeltas: Array(100).fill(10_000),
  };
  const [top] = topFramesFromProfile(profile);
  assert.equal(top.fn, 'update');
  assert.equal(top.url, 'index-BU6aIbGf.js:84908');
  assert.equal(top.selfMs, 1000);
  assert.deepEqual(top.lines, [{ line: 84931, share: 0.61 }, { line: 84944, share: 0.22 }, { line: 84950, share: 0.17 }]);
});

test('two minified functions with one name on line 1 are two rows, told apart by column', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: 'e', url: URL, lineNumber: 0, columnNumber: 100 } },
      { id: 2, callFrame: { functionName: 'e', url: URL, lineNumber: 0, columnNumber: 9000 } },
    ],
    samples: [1, 1, 2], timeDeltas: [10_000, 10_000, 10_000],
  };
  assert.deepEqual(topFramesFromProfile(profile).map((f) => f.selfMs), [20, 10]);
});

test('a minified bundle (every tick on the function\'s own line) prints no lines', () => {
  assert.deepEqual(hotLines(new Map([[1, 50]]), 1), []);
  assert.deepEqual(hotLines(new Map([[7, 50]]), 1), [{ line: 7, share: 1 }], 'one line that is not the declaration still says where');
  assert.deepEqual(hotLines(new Map([[3, 97], [4, 3]]), 1), [{ line: 3, share: 0.97 }], 'under 5% is not a hot line');
});

function harness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-long-'));
  const chunks = [];
  const reads = [];
  const calls = [];
  const send = async (method) => {
    calls.push(method);
    if (method === 'Profiler.stop') return { profile: chunks.shift() };
    if (method === 'Runtime.evaluate') return reads.length ? { result: { type: 'number', value: reads.shift() } } : {};
    return {};
  };
  const p = createIncidentPipeline({ dir, send, log: () => {}, ...opts });
  const lines = () => readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, p, chunks, reads, calls, lines };
}
const at = (ms) => new Date(Date.UTC(2026, 9, 8, 0, 0, 0) + ms).toISOString();
const hitch = (from, to, extra = {}) => ({ type: 'hitch', at: at(to), frameMs: to - from, frameSpan: [from, to], classification: [{ guess: 'long-script' }], ...extra });

test('a long frame ignores the cooldown; an ordinary hitch inside it is still gated', async () => {
  const h = harness();
  await h.p.start();
  for (let i = 0; i < 4; i++) h.chunks.push(chunk(0, 10, []));
  await h.p.onRecord(hitch(0, 389));
  await h.p.onRecord(hitch(389, 764));          // 375 ms, 375 ms after the last rotation
  await h.p.onRecord(hitch(764, 884));          // 120 ms: an ordinary hitch, inside the cooldown
  await h.p.onRecord(hitch(884, 884 + ATTRIBUTE_LONG_FRAME_MS));
  const l = h.lines();
  assert.equal(l[1].unattributed, undefined, 'the second long frame was not given up on');
  assert.equal(l[2].unattributed, 'cooldown');
  assert.equal(l[3].unattributed, undefined);
  assert.equal(h.calls.filter((c) => c === 'Profiler.stop').length, 3);
  const never = harness({ attributeLongFrameMs: Infinity });
  await never.p.start();
  never.chunks.push(chunk(0, 10, []));
  await never.p.onRecord(hitch(0, 389));
  await never.p.onRecord(hitch(389, 764));
  assert.equal(never.lines()[1].unattributed, 'cooldown', 'Infinity turns the exemption off');
});

test('back-to-back long frames: each hitch is attributed from its OWN frame, not the chunk its rotation stopped', async () => {
  // A stop waits for the page's current task, so the stop hitch A asked for
  // lands after frame B: chunk 1 holds A and B, chunk 2 holds C. Read as
  // chunks, A would be "fnA+fnB" and B would be fnC — one frame late.
  const h = harness();
  await h.p.start();
  h.chunks.push(chunk(500, 1400, [
    { fn: 'createSidewalks', line: 99, from: 600, to: 1000, hot: (t) => (t % 50 ? 120 : 131) },
    { fn: 'buildLanes', line: 199, from: 1000, to: 1400 },
  ]));
  h.chunks.push(chunk(1400, 1800, [{ fn: 'placeProps', line: 299, from: 1400, to: 1800 }]));
  // The clock reads either side of the first stop: 1400.5 and 1401.5 page ms;
  // that chunk ended at sampler 2400 → but stop really ran at ~1401 page ms.
  h.chunks[0].endTime = (1401 + OFF) * 1000;
  h.reads.push(1400.5, 1401.5);
  await h.p.onRecord(hitch(600, 1000));
  await h.p.onRecord(hitch(1000, 1400));
  const [a, b] = h.lines();
  assert.equal(a.profileWindow, 'frame');
  assert.equal(a.topFrames.length, 1, 'nothing from frame B leaked into A');
  assert.equal(a.topFrames[0].fn, 'createSidewalks');
  assert.equal(a.topFrames[0].share, 1);
  assert.equal(a.frameSampledMs, 400);
  assert.deepEqual(a.topFrames[0].lines.map((x) => x.line), [120, 131]);
  assert.equal(b.profileWindow, 'frame');
  assert.equal(b.topFrames[0].fn, 'buildLanes', 'B is cut out of the chunk A\'s rotation took, not read off C\'s');
  assert.equal(b.cluster.key, 'long-script|buildLanes@index-BU6aIbGf.js:200');
});

test('no clock mapping — reads too far apart, or a target that will not evaluate — falls back to the chunk', async () => {
  const h = harness();
  await h.p.start();
  h.chunks.push(chunk(500, 1400, [{ fn: 'a', line: 1, from: 600, to: 1000 }, { fn: 'b', line: 2, from: 1000, to: 1400 }]));
  h.reads.push(1400, 1460);   // 60 ms between the reads: the page was busy, the bracket is useless
  await h.p.onRecord(hitch(600, 1000));
  assert.equal(h.lines()[0].profileWindow, 'rolling-chunk');
  assert.equal(h.lines()[0].topFrames.length, 2);
  assert.equal(h.calls.filter((c) => c === 'Runtime.evaluate').length, 2);
});

test('a new document re-maps the clock: its time origin is its own', async () => {
  const h = harness();
  await h.p.start();
  h.chunks.push(chunk(0, 100, []));
  h.reads.push(100, 101);
  await h.p.onRecord(hitch(0, 100));
  await h.p.onRecord({ type: 'armed', at: at(200), url: 'app://x' });
  h.chunks.push(chunk(100, 200, []));
  await h.p.onRecord(hitch(100, 200, { at: at(5000) }));
  assert.equal(h.calls.filter((c) => c === 'Runtime.evaluate').length, 4, 'calibrated again after the reload');
});

test('sliceFrame keeps only the samples inside the span, across chunks', () => {
  const c1 = chunk(0, 300, [{ fn: 'x', line: 1, from: 0, to: 300 }]);
  const c2 = chunk(300, 600, [{ fn: 'y', line: 2, from: 300, to: 600 }]);
  const { parts, sampledMs } = sliceFrame([c1, c2], [250, 360], OFF);
  assert.equal(sampledMs, 110);
  assert.deepEqual(topFramesFromProfile(parts).map((f) => [f.fn, f.selfMs]), [['y', 60], ['x', 50]]);
});

test('the run file keeps each heavy function\'s hot lines; the run\'s heaviest self time reads them back', () => {
  const fold = createRunFold({ session: 'S', intervalUs: 10_000 });
  fold.addProfile(chunk(0, 1000, [{ fn: 'update', line: 84907, from: 0, to: 800, hot: (t) => (t % 100 < 60 ? 84931 : 84944) }]), 'load');
  const file = JSON.parse(JSON.stringify(fold.toJSON()));
  const row = file.phases.load.fns.find((f) => f[0] === 'update');
  assert.deepEqual(row[6], { 84931: 48, 84944: 32 });
  const [top] = heaviestSelf(runBucket(file), 3, file.intervalUs);
  assert.equal(top.fn, 'update');
  assert.equal(top.line, 84908);
  assert.equal(top.selfMs, 800);
  assert.deepEqual(top.lines, [{ line: 84931, share: 0.6 }, { line: 84944, share: 0.4 }]);
});

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sloptimize.mjs');

test('report prints the hot lines under a hitch\'s top frame and under the run\'s heaviest functions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-lines-'));
  const fold = createRunFold({ session: 'S', intervalUs: 10_000 });
  fold.addProfile(chunk(0, 1000, [{ fn: 'update', line: 84907, from: 0, to: 800, hot: (t) => (t % 100 < 60 ? 84931 : 84944) }]), 'load');
  mkdirSync(join(dir, 'runs'));
  writeFileSync(join(dir, 'runs', 'S.json'), JSON.stringify(fold.toJSON()));
  writeFileSync(join(dir, 'perf.jsonl'), JSON.stringify({ type: 'hitch', at: at(0), session: 'S', phase: 'load', frameMs: 389, medianMs: 16.7, tier: 0,
    classification: [{ guess: 'long-script', evidence: 'e' }], profileWindow: 'frame',
    topFrames: [{ fn: 'update', url: 'index-BU6aIbGf.js:84908', selfMs: 312, share: 0.802, lines: [{ line: 84931, share: 0.61 }, { line: 84944, share: 0.22 }] }] }) + '\n');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ type: 'profile', tier: 0, session: 'S', frame: { medianMs: 16.7 }, at: at(0) }));
  const out = execFileSync(process.execPath, [BIN, 'report', '--dir', dir], { encoding: 'utf8', env: { ...process.env, SLOPTIMIZE_KEY: '', SLOPTIMIZE_ENDPOINT: '' } });
  assert.match(out, /top update@index-BU6aIbGf\.js:84908 312ms \(80% of frame\) — :84931 61% · :84944 22%/);
  assert.match(out, /heaviest self time \(whole run\):\n {4}update@index-BU6aIbGf\.js:84908 800ms \(100% of JS\) {2}:84931 60% {2}:84944 40%/);
});

test('a chunk is credited to its phases by sample time once the clock and the phase edges are known', async () => {
  const h = harness();
  await h.p.start();
  h.chunks.push(chunk(0, 500, [{ fn: 'boot', line: 1, from: 0, to: 500 }]));
  h.reads.push(500.5, 501.5);
  h.chunks[0].endTime = (501 + OFF) * 1000;
  await h.p.onRecord(hitch(0, 500));                 // calibrates the clock
  // The page: 'load' from 600 to 1000, then 'play' — one chunk spans all of it.
  await h.p.onRecord({ type: 'phase-span', at: at(1000), phase: 'load', span: 'x.1', ms: 400, t0: 600, t1: 1000, next: 'play' });
  h.chunks.push(chunk(500, 1400, [{ fn: 'loadCity', line: 5, from: 600, to: 1000 }, { fn: 'tick', line: 9, from: 1000, to: 1400 }]));
  await h.p.stop();
  const run = JSON.parse(readFileSync(join(h.dir, 'runs', `${h.p.session}.json`), 'utf8'));
  const fns = (ph) => (run.phases[ph]?.fns ?? []).map((f) => f[0]);
  assert.deepEqual(fns('load'), ['loadCity']);
  assert.deepEqual(fns('play'), ['tick']);
  assert.ok(!fns('?').includes('loadCity'), 'nothing of the load is credited elsewhere');
});

test('a frame no held chunk covers is not-sampled — never attributed from a chunk of another time', async () => {
  const h = harness();
  await h.p.start();
  h.chunks.push(chunk(5000, 5500, [{ fn: 'later', line: 1, from: 5000, to: 5500 }]));
  h.reads.push(5500.5, 5501.5);
  h.chunks[0].endTime = (5501 + OFF) * 1000;
  await h.p.onRecord(hitch(100, 400));               // long gone: 5 s before the chunk began
  const [l] = h.lines();
  assert.equal(l.unattributed, 'not-sampled');
  assert.deepEqual(l.topFrames, []);
});
