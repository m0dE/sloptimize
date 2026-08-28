// The push channel (SPEC §8.1.1): `sloptimize watch` tails perf.jsonl with a
// byte cursor and prints ONE line per record an agent should wake for. Pinned
// here: what wakes, what stays silent, and that the cursor survives
// truncation and partial writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWatcher, wakeLine } from '../src/watch.mjs';

function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'sloptimize-watch-'));
  mkdirSync(join(d, '.sloptimize'));
  return join(d, '.sloptimize');
}
const line = (o) => JSON.stringify(o) + '\n';
// Fixture records are stamped 2026-01-01; the watcher's clock is pinned just
// after, so liveness never trips in the record tests.
const FIXED = { now: () => Date.parse('2026-01-01T00:00:01.000Z') };
const hitch = (ms, at = '2026-01-01T00:00:00.000Z') => ({
  type: 'hitch', at, frameMs: ms, medianMs: 8, insideRenderMs: 0,
  classification: [{ guess: 'long-script', confidence: 'low', evidence: `frame ${ms}ms with only 0.0ms inside render` }],
  phase: 'match', build: 'v1',
});

test('wakeLine: usermark, big hitch, capped gpu-settle, gpu-stall wake; heartbeat/arm-probe/small hitch do not', () => {
  const mark = { type: 'usermark', at: 'T', note: 'huge stutter', window: { frames: 300, medianMs: 8 },
    worstFrames: [{ frameMs: 725, classification: [{ guess: 'long-script', evidence: 'frame 725ms with only 0.0ms inside render' }] }] };
  assert.match(wakeLine(mark, 'D'), /★ usermark "huge stutter".*725ms → long-script/);
  assert.match(wakeLine(hitch(120), 'D'), /hitch 120ms.*long-script/);
  assert.equal(wakeLine(hitch(99), 'D'), null);
  const minted = { ...hitch(300), mints: [
    { material: 'house-dark', object: 'Mesh', ms: 0.3, changed: ['env', 'ctx'] },
    { material: 'launch-booster-lamp', object: 'Mesh', ms: 0.2, changed: [] },
    { material: 'rig-kit-solid', object: 'Mesh', ms: 0.1 },
  ] };
  assert.match(wakeLine(minted, 'D'), /mints=\[house-dark@Mesh changed:env,ctx; launch-booster-lamp@Mesh re-minted:same-key; rig-kit-solid@Mesh\]/);
  assert.equal(wakeLine(hitch(120), 'D', { minHitchMs: 200 }), null);
  assert.match(wakeLine({ type: 'gpu-settle', at: 'T', tag: 'hangar-reveal', ms: 3000, settled: false }, 'D'), /gpu-settle hangar-reveal 3000ms NOT settled/);
  // A settled wait — however long — is verification evidence, not an incident.
  assert.equal(wakeLine({ type: 'gpu-settle', at: 'T', tag: 'x', ms: 726, settled: true }, 'D'), null);
  assert.match(wakeLine({ type: 'gpu-stall', at: 'T', queueDoneMs: 614, classification: [{ guess: 'gpu-process-stall', evidence: 'e' }] }, 'D'), /gpu-stall 614ms/);
  const warm = { type: 'warm', at: 'T', kind: 'batched', tag: 'post', budgetMs: 8, keys: 12, batches: 5, worstBatchMs: 706, batchBuilt: [0, 1, 4, 4, 3], costliest: '706ms entity-pool-blend', phase: 'launch:depart' };
  assert.match(wakeLine(warm, 'D'), /🔥 warm post \(batched, budget 8ms\): 12 key\(s\) in 5 batch\(es\), worst 706ms builds\/batch=\[0,1,4,4,3\] — 706ms entity-pool-blend/);
  assert.equal(wakeLine({ ...warm, worstBatchMs: 40 }, 'D'), null);
  assert.equal(wakeLine({ ...warm, worstBatchMs: 9049, hidden: true }, 'D'), null);   // background tab: nobody watched
  assert.equal(wakeLine({ ...hitch(900), automated: true }, 'D'), null);        // a robot's session: not an incident
  assert.equal(wakeLine({ ...mark, automated: true }, 'D'), null);
  assert.equal(wakeLine({ type: 'heartbeat', at: 'T' }, 'D'), null);
  assert.equal(wakeLine({ type: 'arm-probe', at: 'T' }, 'D'), null);
});

test('watcher starts at EOF: history does not wake, appended records do, each once', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'perf.jsonl'), line(hitch(500)) + line({ type: 'heartbeat', at: 'T' }));
  const w = createWatcher([dir], FIXED);
  assert.deepEqual(w.poll(), []);
  appendFileSync(join(dir, 'perf.jsonl'), line(hitch(150, 'A')) + line({ type: 'heartbeat', at: 'B' }) + line(hitch(20, 'C')));
  const got = w.poll();
  assert.equal(got.length, 1);
  assert.match(got[0], /hitch 150ms/);
  assert.deepEqual(w.poll(), []);
});

test('watcher holds a partial trailing line until its newline lands', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'perf.jsonl'), '');
  const w = createWatcher([dir], FIXED);
  const full = line(hitch(300));
  appendFileSync(join(dir, 'perf.jsonl'), full.slice(0, 40));
  assert.deepEqual(w.poll(), []);
  appendFileSync(join(dir, 'perf.jsonl'), full.slice(40));
  assert.equal(w.poll().length, 1);
});

test('watcher survives truncation (ledger rotated) and a file that does not exist yet', () => {
  const dir = scratch();
  const w = createWatcher([dir], FIXED);    // no perf.jsonl at all
  assert.deepEqual(w.poll(), []);
  writeFileSync(join(dir, 'perf.jsonl'), line(hitch(300)));
  assert.equal(w.poll().length, 1);
  appendFileSync(join(dir, 'perf.jsonl'), line(hitch(1200)) + line(hitch(1300)));
  assert.equal(w.poll().length, 2);
  // Rotation: the ledger is truncated and restarted (shorter than the cursor).
  writeFileSync(join(dir, 'perf.jsonl'), line(hitch(150)));
  assert.equal(w.poll().length, 1);
  assert.deepEqual(w.poll(), []);
});

test('watcher reports the feed going dark once, and recovering once', () => {
  const dir = scratch();
  let now = Date.parse('2026-01-01T01:00:00.000Z');
  writeFileSync(join(dir, 'perf.jsonl'), line({ type: 'heartbeat', at: '2026-01-01T00:59:00.000Z' }));
  const w = createWatcher([dir], { staleMin: 45, now: () => now });
  assert.deepEqual(w.poll(), []);
  now += 50 * 60_000;
  const dark = w.poll();
  assert.equal(dark.length, 1);
  assert.match(dark[0], /feed quiet 5[01]min/);
  assert.deepEqual(w.poll(), []);
  appendFileSync(join(dir, 'perf.jsonl'), line({ type: 'heartbeat', at: new Date(now).toISOString() }));
  const back = w.poll();
  assert.equal(back.length, 1);
  assert.match(back[0], /feed live again/);
});
