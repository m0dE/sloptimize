import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRecord, lineOf, createTicker } from '../src/ticker.js';
import { createRecorder } from '../src/recorder.js';
import { classifyHitch } from '../src/classify.js';

test('a hitch line is the classifier\'s own verdict, in the record\'s units', () => {
  const rec = { type: 'hitch', frameMs: 142.3, classification: [{ guess: 'long-render', confidence: 'high', evidence: 'inside-render 120.0ms of a 142.3ms frame' }] };
  assert.equal(lineOf(rec), '▲ hitch 142ms · long-render — inside-render 120.0ms of a 142.3ms frame');
  assert.equal(describeRecord(rec).tone, 'bad');
  assert.equal(describeRecord({ type: 'hitch', frameMs: 48.2, classification: [] }).tone, 'warn');
});

test('a jump says which track moved how far; an oscillation its swing', () => {
  assert.equal(lineOf({ type: 'jitter', kind: 'snap', track: 'camera', units: 0.62, classification: [{ guess: 'snap', evidence: 'no tick between' }] }),
    '↯ camera jumps 0.62 · snap — no tick between');
  assert.equal(lineOf({ type: 'jitter', kind: 'oscillation', track: 'unit', frames: 5, amplitude: 0.3, classification: [] }),
    '↯ unit oscillates ×5 ±0.3');
});

test('bookkeeping records are not incidents; a host-defined record shows its type', () => {
  for (const type of ['profile', 'heartbeat', 'arm-probe', 'armed', 'warm', 'answer']) assert.equal(describeRecord({ type }), null, type);
  assert.equal(describeRecord(null), null);
  assert.equal(lineOf({ type: 'error', name: 'TypeError', message: 'x is not a function' }), '✕ TypeError · x is not a function');
  assert.equal(lineOf({ type: 'gpu-stall', queueDoneMs: 412 }), '◆ gpu stall 412ms');
  assert.equal(lineOf({ type: 'gpu-settle', tag: 'boot', ms: 3000, settled: true }), null);
  assert.equal(lineOf({ type: 'gpu-settle', tag: 'boot', ms: 3000, settled: false }), '◆ gpu boot not settled after 3000ms');
  assert.equal(lineOf({ type: 'mesh-build', ms: 88.5 }), '• mesh-build 88.5ms');
});

test('the recorder\'s real hitch record makes a line with the real classification', () => {
  let t = 0;
  const rec = createRecorder({ budgetFrameMs: 16.7, now: () => t });
  for (let i = 0; i < 120; i++) { t += 16.7; rec.frame({ frameMs: 16.7, insideRenderMs: 4, calls: 200, triangles: 1e5, programs: 10, textures: 20, geometries: 30 }); }
  t += 160;
  rec.frame({ frameMs: 160, insideRenderMs: 140, calls: 200, triangles: 1e5, programs: 10, textures: 20, geometries: 30 });
  t += 1100;
  const out = rec.drainRecords();
  const hitch = out.find((r) => r.type === 'hitch');
  assert.ok(hitch, 'a hitch was minted');
  if (!hitch.classification?.length) hitch.classification = classifyHitch(hitch);
  const line = lineOf(hitch);
  assert.match(line, /^▲ hitch 160ms · long-render — inside-render 140\.0ms/);
});

function fakeDocument() {
  const mk = (tag) => {
    const node = {
      tag, children: [], style: {}, dataset: {}, textContent: '', parent: null,
      setAttribute(k, v) { node[k] = v; },
      appendChild(c) { c.parent = node; node.children.push(c); return c; },
      append(...cs) { for (const c of cs) node.appendChild(c); },
      remove() { if (node.parent) { node.parent.children = node.parent.children.filter((c) => c !== node); node.parent = null; } },
    };
    return node;
  };
  const body = mk('body');
  return { body, createElement: mk };
}

test('the ticker shows at most `max` lines, drops each after its ttl, and ignores quiet records', () => {
  const doc = fakeDocument();
  const timers = [];
  const ticker = createTicker({ document: doc, ttlMs: 5000, max: 2,
    setTimeout: (fn, t) => { const h = { fn, t }; timers.push(h); return h; }, clearTimeout: (h) => { h.fired = true; } });
  assert.equal(ticker.push([{ type: 'profile' }, { type: 'heartbeat' }]), 0);
  assert.equal(doc.body.children.length, 0, 'nothing mounts for nothing');
  assert.equal(ticker.push([{ type: 'hitch', frameMs: 40, classification: [] }, { type: 'error', name: 'E', message: 'm' }, { type: 'gpu-stall', queueDoneMs: 300 }]), 3);
  const root = doc.body.children[0];
  assert.equal(root['data-sloptimize'], 'ticker');
  assert.equal(root.children.length, 2, 'the oldest left early to make room');
  assert.equal(root.children[0].children[1].textContent, 'E');
  assert.equal(root.children[1].children[1].textContent, 'gpu stall 300ms');
  timers.filter((h) => !h.fired).forEach((h) => h.fn());
  assert.equal(root.children.length, 0, 'every line leaves at its ttl');
  ticker.dispose();
  assert.equal(doc.body.children.length, 0);
});

test('without a document the ticker is inert', () => {
  const ticker = createTicker({ document: null });
  assert.equal(ticker.push([{ type: 'hitch', frameMs: 40 }]), 0);
  assert.equal(ticker.size(), 0);
});
