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
  let nextProfile = profileWith('buildWorld');
  const send = async (method, params) => {
    calls.push(method);
    if (method === 'Profiler.stop') return { profile: nextProfile };
    return {};
  };
  const logs = [];
  const p = createIncidentPipeline({ dir, send, log: (l) => logs.push(l), ...opts });
  return { dir, calls, logs, p, setProfile: (fn) => { nextProfile = profileWith(fn); } };
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
