// The transport-free half of tier 0: profiler rotation over an injected
// send, cluster identity + merge, the NEW-cluster hook, regime stamping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';

const profileWith = (fn) => ({
  nodes: [{ id: 1, callFrame: { functionName: fn, url: 'https://x/game.js', lineNumber: 9 } }],
  samples: [1], timeDeltas: [4000],
});

function harness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slop-pipe-'));
  const calls = [];
  const sent = [];
  let nextProfile = profileWith('buildWorld');
  const send = async (method, params) => {
    calls.push(method); sent.push([method, params]);
    if (method === 'Profiler.stop') return { profile: nextProfile };
    return {};
  };
  const logs = [];
  const p = createIncidentPipeline({ dir, send, log: (l) => logs.push(l), ...opts });
  const lines = () => readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, calls, sent, logs, p, lines, setProfile: (fn) => { nextProfile = profileWith(fn); } };
}
const hitch = (at = '2026-09-09T00:00:00Z') => ({ type: 'hitch', at, frameMs: 120, classification: [{ guess: 'long-script' }] });

test('start/stop drive the profiler over send; stop is idempotent', async () => {
  const h = harness();
  await h.p.start();
  assert.deepEqual(h.calls, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
  await h.p.stop(); await h.p.stop();
  assert.equal(h.calls.filter((c) => c === 'Profiler.stop').length, 1);
});

test('a hitch rotates the profiler, is attributed, clustered, written; repeats count instead of re-logging', async () => {
  const h = harness();
  await h.p.start();
  await h.p.onRecord(hitch());
  await h.p.onRecord(hitch('2026-09-09T00:00:05Z'));
  const lines = readFileSync(join(h.dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].topFrames[0].fn, 'buildWorld');
  assert.deepEqual(lines[0].cluster, { key: 'long-script|buildWorld@game.js:10', count: 1, new: true });
  assert.equal(lines[1].cluster.count, 2);
  assert.equal(lines[1].cluster.new, false);
  assert.equal(h.logs.filter((l) => l.startsWith('INCIDENT')).length, 1);
  const clusters = JSON.parse(readFileSync(join(h.dir, 'clusters.json'), 'utf8'));
  assert.equal(clusters[0].count, 2);
});

test('onNewCluster fires once per cause, before the write, and may stamp the record', async () => {
  const seen = [];
  const h = harness({ onNewCluster: (rec, key) => { seen.push(key); rec.trace = 'trace-1.json'; } });
  await h.p.start();
  await h.p.onRecord(hitch());
  await h.p.onRecord(hitch());
  assert.deepEqual(seen, ['long-script|buildWorld@game.js:10']);
  const first = JSON.parse(readFileSync(join(h.dir, 'perf.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(first.trace, 'trace-1.json');
});

test('a throwing onNewCluster never loses the record', async () => {
  const h = harness({ onNewCluster: () => { throw new Error('tracing broke'); } });
  await h.p.start();
  await h.p.onRecord(hitch());
  const first = JSON.parse(readFileSync(join(h.dir, 'perf.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(first.hookError, 'tracing broke');
});

test('profile records carry the regime the pipeline was told', async () => {
  const h = harness({ regime: 'hardware' });
  await h.p.onRecord({ type: 'profile', frame: { medianMs: 16 } });
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'profile.json'), 'utf8')).regime, 'hardware');
  const u = harness();
  await u.p.onRecord({ type: 'profile' });
  assert.equal(JSON.parse(readFileSync(join(u.dir, 'profile.json'), 'utf8')).regime, 'unknown');
});

test('without a profiler running, a hitch still lands, unattributed', async () => {
  const h = harness();
  await h.p.onRecord(hitch());
  assert.ok(!h.calls.includes('Profiler.stop'));
  const first = JSON.parse(readFileSync(join(h.dir, 'perf.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(first.topFrames, []);
  assert.equal(first.cluster.key, 'long-script|');
  assert.ok(existsSync(join(h.dir, 'clusters.json')));
});

// ── The observer effect (ticket 2c11481d): a mid-size three.js game went from
// 60 fps to 12 under attach. 2000 samples/s plus a Profiler.stop/start on
// EVERY hitch fed back on itself: the rotation cost made the next frame a
// hitch, which rotated again. Sampling is coarser and rotation is gated.
const T0 = Date.parse('2026-09-09T00:00:00Z');
const atMs = (ms) => new Date(T0 + ms).toISOString();

test('the sampler runs at 10 ms, not 0.5 ms', async () => {
  const h = harness();
  await h.p.start();
  assert.equal(h.sent.find(([m]) => m === 'Profiler.setSamplingInterval')[1].interval, 10000);
});

test('rotation is gated: below the floor or inside the cooldown a hitch is recorded, not minted; the skips ride the next minted record', async () => {
  const h = harness();
  await h.p.start();
  await h.p.onRecord({ ...hitch(atMs(0)), frameMs: 40 });      // below the 80 ms floor
  await h.p.onRecord(hitch(atMs(1000)));                        // 120 ms → rotates, mints
  await h.p.onRecord(hitch(atMs(1500)));                        // 500 ms later → cooldown
  await h.p.onRecord(hitch(atMs(3000)));                        // past the cooldown → rotates
  assert.equal(h.calls.filter((c) => c === 'Profiler.stop').length, 2);
  const l = h.lines();
  assert.equal(l.length, 4, 'detection is untouched: every hitch lands in perf.jsonl');
  assert.equal(l[0].unattributed, 'below-floor');
  assert.equal(l[0].cluster, undefined);
  assert.deepEqual(l[0].topFrames, []);
  assert.deepEqual(l[1].cluster, { key: 'long-script|buildWorld@game.js:10', count: 1, new: true });
  assert.equal(l[1].skippedSinceLast, 1);
  assert.equal(l[2].unattributed, 'cooldown');
  assert.equal(l[2].cluster, undefined);
  assert.equal(l[3].cluster.count, 2);
  assert.equal(l[3].skippedSinceLast, 1);
  assert.equal(l[1].profileWindow, 'rolling-chunk');
  assert.equal(l[2].profileWindow, 'none');
  assert.equal(h.logs.filter((x) => x.startsWith('INCIDENT')).length, 1);
  assert.equal(JSON.parse(readFileSync(join(h.dir, 'clusters.json'), 'utf8'))[0].count, 2);
});

test('the gate is configurable, and a record without a parseable `at` gates on the wall clock', async () => {
  let now = 0;
  const h = harness({ attributeFloorMs: 30, attributeCooldownMs: 5000, now: () => now });
  await h.p.start();
  await h.p.onRecord({ type: 'hitch', frameMs: 40, classification: [{ guess: 'long-script' }] });
  now = 4000;
  await h.p.onRecord({ type: 'hitch', frameMs: 400, classification: [{ guess: 'long-script' }] });
  now = 5000;
  await h.p.onRecord({ type: 'hitch', frameMs: 400, classification: [{ guess: 'long-script' }] });
  assert.equal(h.calls.filter((c) => c === 'Profiler.stop').length, 2);
  assert.equal(h.lines()[1].unattributed, 'cooldown');
});

test('an unread window rolls itself over so Profiler.stop never serializes a session of samples; stop() disarms it', async () => {
  const timers = []; const cleared = [];
  const h = harness({
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => cleared.push(id),
  });
  await h.p.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 10000);
  await timers[0].fn();
  assert.deepEqual(h.calls.slice(3), ['Profiler.stop', 'Profiler.start']);
  assert.ok(!existsSync(join(h.dir, 'perf.jsonl')), 'a roll writes nothing');
  assert.equal(timers.length, 2, 're-armed');
  // A hitch's rotation re-arms the window too: the window measures unread time.
  await h.p.onRecord(hitch(atMs(0)));
  assert.equal(timers.length, 3);
  await h.p.stop();
  assert.ok(cleared.includes(3));
  await timers[2].fn();
  assert.equal(h.calls.filter((c) => c === 'Profiler.stop').length, 3, 'a roll after stop is a no-op');
});
