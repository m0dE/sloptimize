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
import { footprintOf } from '../src/footprint.js';

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

test('wakeLine: a jitter snap or oscillation wakes; a long-frame catch-up or a passenger does not', () => {
  const snap = { type: 'jitter', at: 'T', track: 'unit', kind: 'snap', units: 0.62, jump: [0.6, 0.15, 0], travelUnits: 0.133, speed: 8, dtMs: 16.7,
    classification: [{ guess: 'snap', confidence: 'high', evidence: '0.62m off its trajectory' }], phase: 'play', build: 'v1', coincident: ['camera'] };
  assert.match(wakeLine(snap, 'D'), /↯ jitter unit snap 0\.62 \(jump \[0\.6, 0\.15, 0\], expected 0\.133 of travel at 8\/s in a 16\.7ms frame\) with=camera @ T → snap \(0\.62m off its trajectory\) phase=play build=v1/);
  const osc = { type: 'jitter', at: 'T', track: 'camera', kind: 'oscillation', frames: 41, durationMs: 683, amplitude: 0.3,
    classification: [{ guess: 'oscillation', confidence: 'high', evidence: '41 reversals' }] };
  assert.match(wakeLine(osc, 'D'), /↯ jitter camera oscillation ×41 over 683ms, amplitude 0\.3 @ T → oscillation/);
  assert.equal(wakeLine({ ...snap, classification: [{ guess: 'long-frame-catch-up', evidence: 'e' }] }, 'D'), null);
  assert.equal(wakeLine({ ...snap, track: 'camera', classification: [{ guess: 'follows-track', evidence: 'e' }, snap.classification[0]] }, 'D'), null);
  assert.equal(wakeLine({ ...snap, automated: true }, 'D'), null);
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

test('every wake line carries the footprint and how many times this ledger has seen it, history included', () => {
  const dir = scratch();
  // Two of the same cause already on disk (one under the wake bar — still the same issue), one different.
  writeFileSync(join(dir, 'perf.jsonl'), line(hitch(500)) + line(hitch(30)) + line({ ...hitch(200), phase: 'play' }));
  const w = createWatcher([dir], FIXED);
  appendFileSync(join(dir, 'perf.jsonl'), line(hitch(150, 'A')) + line({ ...hitch(160, 'B'), ctx: 'crew=copilot,hull=walker' }));
  const got = w.poll();
  assert.equal(got.length, 2);
  const id = footprintOf(hitch(1)).id;
  assert.match(got[0], new RegExp(`phase=match build=v1 fp=${id} ×3`));      // the third occurrence of this cause
  assert.match(got[1], /ctx=crew=copilot,hull=walker/);
  assert.match(got[1], /fp=[0-9a-f]{8} ×1/);                                   // a different situation is a different issue
  assert.equal(wakeLine(hitch(120), 'D').includes(' ×'), false);              // no counts handed in: no number invented
  assert.match(wakeLine(hitch(120), 'D'), new RegExp(`fp=${id}`));
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
