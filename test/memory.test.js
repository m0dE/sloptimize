// Long sessions: live GPU objects (the leak a three.js game actually hits — a
// dispose missed on a rebuild) and the JS heap, read as trends.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInjectScript } from '../src/attach.mjs';
import { trendOf, memoryTrends, memoryLines } from '../src/memory.js';
import { createIncidentPipeline } from '../src/incident-pipeline.mjs';
import { compareConditions } from '../src/conditions.js';

test('page: live GL objects are created minus deleted; the heartbeat carries them, and three.js\'s own count when the hook hands over a renderer', () => {
  const emitted = [], intervals = [];
  class WebGL2RenderingContext {}
  const p = WebGL2RenderingContext.prototype;
  for (const n of ['Buffer', 'Texture', 'Program', 'Shader', 'Framebuffer', 'Renderbuffer', 'VertexArray']) {
    p[`create${n}`] = function () { return { kind: n }; };
    p[`delete${n}`] = function () {};
  }
  const ctx = {
    requestAnimationFrame: () => {}, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1; },
    PerformanceObserver: class { observe() {} }, performance: { now: () => 0 }, location: { href: 'x' }, document: { addEventListener() {} },
    __sloptimizeEmit: (j) => emitted.push(JSON.parse(j)), WebGL2RenderingContext, EventTarget, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
    WeakRef, WeakSet, FinalizationRegistry, Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Map, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  const gl = new WebGL2RenderingContext();
  const bufs = [gl.createBuffer(), gl.createBuffer(), gl.createBuffer()];
  gl.createTexture();
  gl.deleteBuffer(bufs[0]);
  gl.deleteBuffer(bufs[0]);   // twice is once
  gl.deleteBuffer({});        // never ours
  const renderer = { isWebGLRenderer: true, info: { memory: { geometries: 12, textures: 3 }, programs: [1, 2] } };
  vm.runInContext('globalThis.__THREE_DEVTOOLS__', ctx).dispatchEvent(Object.assign(new Event('observe'), { detail: renderer }));
  intervals.find((i) => i.ms === 60_000).fn();
  const beat = emitted.find((e) => e.type === 'heartbeat');
  assert.deepEqual(beat.gpuLive, { buffers: 2, textures: 1, programs: 0, shaders: 0, framebuffers: 0, renderbuffers: 0, vertexArrays: 0 });
  assert.deepEqual(beat.three, { geometries: 12, textures: 3, programs: 2 });
});

const beats = (n, f, source = 'live') => [...Array(n)].map((_, i) => ({ type: 'heartbeat', at: new Date(Date.parse('2026-10-02T10:00:00Z') + i * 60_000).toISOString(), ...f(i, source) }));

test('a missed dispose: geometries grow every minute while the heap holds — GROWING, and the line says where to look', () => {
  const recs = beats(30, (i) => ({ gpuLive: { buffers: 1200 + i * 25 + (i % 3), textures: 88 }, three: { geometries: 400 + i * 8 }, heap: { usedMB: 40 + (i % 4) * 3, source: 'live' } }));
  const t = memoryTrends(recs);
  assert.equal(t['gpu.buffers'].verdict, 'growing');
  assert.ok(Math.abs(t['gpu.buffers'].perHour - 1500) < 60, String(t['gpu.buffers'].perHour));
  assert.equal(t['three.geometries'].verdict, 'growing');
  assert.equal(t['gpu.textures'].verdict, 'flat');
  assert.equal(t.heap.verdict, 'flat', 'a live sawtooth is fit to its floor');
  const lines = memoryLines(t).join('\n');
  assert.match(lines, /▲ GPU buffers \(live\): 1200 → 1927 .*GROWING: a dispose missed on a rebuild\?/);
  assert.match(lines, /flat: JS heap 4\d MB · GPU textures 88/);
});

test('trendOf: a slow heap leak under GC noise reads as growing on its floor; a short session says too short; noise is flat', () => {
  const leak = beats(40, (i) => ({ heap: { usedMB: 40 + i * 0.25 + ((i * 7) % 5) * 1.5 } })).map((b) => ({ t: Date.parse(b.at), v: b.heap.usedMB }));
  assert.equal(trendOf(leak, 'heapMB', { floor: true }).verdict, 'growing');
  assert.equal(trendOf(leak.slice(0, 4), 'heapMB').verdict, 'too short');
  const noise = leak.map((p, i) => ({ t: p.t, v: 40 + ((i * 7) % 5) * 1.5 }));
  assert.equal(trendOf(noise, 'heapMB', { floor: true }).verdict, 'flat');
  assert.match(memoryLines(memoryTrends(beats(3, () => ({ heap: { usedMB: 1 } })))).join(''), /a trend needs 5 min/);
});

test('pipeline: every heartbeat carries the heap; --heap-gc collects first; snapshots stream to heap/<session>-<label>.heapsnapshot; soak is a condition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slop-mem-'));
  const calls = [];
  let p;
  const send = async (m) => {
    calls.push(m);
    if (m === 'Runtime.getHeapUsage') return { usedSize: 50 * 1048576, totalSize: 64 * 1048576 };
    if (m === 'HeapProfiler.takeHeapSnapshot') { p.onEvent('HeapProfiler.addHeapSnapshotChunk', { chunk: '{"snapshot":' }); p.onEvent('HeapProfiler.addHeapSnapshotChunk', { chunk: '{}}' }); }
    return {};
  };
  p = createIncidentPipeline({ dir, send, log: () => {}, session: 'S', heap: { gc: true, snapshots: true }, setTimeout: () => null, clearTimeout: () => {} });
  await p.start();
  await p.onRecord({ type: 'heartbeat', at: '2026-10-02T10:00:00Z', tier: 0 });
  await p.stop();
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.find((r) => r.type === 'heartbeat').heap, { usedMB: 50, totalMB: 64, source: 'post-gc' });
  assert.ok(calls.indexOf('HeapProfiler.collectGarbage') < calls.indexOf('Runtime.getHeapUsage'));
  assert.deepEqual(readdirSync(join(dir, 'heap')), ['S-end.heapsnapshot']);
  assert.equal(readFileSync(join(dir, 'heap', 'S-end.heapsnapshot'), 'utf8'), '{"snapshot":{}}');
  assert.equal(lines.find((r) => r.type === 'heap-snapshot').label, 'end');
  assert.deepEqual(p.conditions.soak, { forcedGc: true, heapSnapshots: true });
  assert.equal(compareConditions([p.conditions], [{ instrument: 'attach' }]).mismatches[0].key, 'soak');
});

test('a level load is one step, not a leak: 400 geometries, then 650 and flat, reads flat', () => {
  const step = [...Array(30)].map((_, i) => ({ t: Date.parse('2026-10-02T10:00:00Z') + i * 60_000, v: i < 12 ? 400 : 650 }));
  assert.equal(trendOf(step, 'count').verdict, 'flat');
});
