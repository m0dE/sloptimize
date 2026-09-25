// The injected tier-0 recorder's counters under node:vm, against a fake
// WebGL2 context: every draw entry point three.js uses is counted the way
// renderer.info counts it, a hitch's counts are its frame's (not a delta),
// the profile is a window mean, the page beats once a minute, and a page
// may stamp its phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildInjectScript } from '../src/attach.mjs';

const TRIANGLES = 4, LINES = 1, TRIANGLE_STRIP = 5;

function page() {
  const rafs = [], emitted = [], intervals = [];
  const calls = [];
  class WebGL2RenderingContext {}
  const proto = WebGL2RenderingContext.prototype;
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements', 'linkProgram']) {
    proto[name] = function (...a) { calls.push([name, ...a]); return name; };
  }
  class MultiDraw {}
  for (const name of ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL']) {
    MultiDraw.prototype[name] = function (...a) { calls.push([name, ...a]); };
  }
  class Other { foo() { return 1; } }
  proto.getExtension = (name) => (name === 'WEBGL_multi_draw' ? new MultiDraw() : name === 'OES_whatever' ? new Other() : null);
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    PerformanceObserver: class { observe() {} },
    performance: { now: () => 0 },
    location: { href: 'app://index.html' },
    document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    WebGL2RenderingContext,
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  const gl = new WebGL2RenderingContext();
  let ts = 0;
  const frame = (dt, draw = () => {}) => { draw(gl); ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  return { ctx, gl, frame, emitted, calls, intervals, of: (type) => emitted.filter((e) => e.type === type) };
}

test('instanced, range and multi-draw calls are counted like renderer.info: calls per API call, triangles × instances', () => {
  const p = page();
  for (let i = 0; i < 70; i++) p.frame(16);
  p.frame(300, (gl) => {   // a hitch frame: its record carries what it drew
    gl.drawArrays(TRIANGLES, 0, 30);                       // 1 call, 10 tris
    gl.drawElements(TRIANGLES, 36, 5123, 0);               // 1 call, 12 tris
    gl.drawElementsInstanced(TRIANGLES, 36, 5123, 0, 100); // 1 call, 1200 tris — the InstancedMesh the old hook missed
    gl.drawArraysInstanced(TRIANGLES, 0, 3, 50);           // 1 call, 50 tris
    gl.drawRangeElements(TRIANGLES, 0, 10, 6, 5123, 0);    // 1 call, 2 tris
    gl.drawArrays(LINES, 0, 100);                          // 1 call, 0 tris: lines are not triangles
    gl.drawArrays(TRIANGLE_STRIP, 0, 10);                  // 1 call, 8 tris
    const md = gl.getExtension('WEBGL_multi_draw');
    md.multiDrawElementsWEBGL(TRIANGLES, [3, 6, 9], 0, 5123, [0, 0, 0], 0, 3);          // 1 call, 6 tris
    md.multiDrawArraysInstancedWEBGL(TRIANGLES, [0, 0], 0, [3, 6], 0, [10, 2], 0, 2); // 1 call, 14 tris
  });
  assert.deepEqual(p.of('hitch')[0].render, { calls: 9, triangles: 1302 });
  // The draws still reach the context, with their own arguments and return value.
  assert.equal(p.calls.filter(([n]) => n.startsWith('draw') || n.startsWith('multi')).length, 9);
  assert.deepEqual(p.calls.find(([n]) => n === 'drawElementsInstanced'), ['drawElementsInstanced', TRIANGLES, 36, 5123, 0, 100]);
  assert.equal(p.gl.drawArrays(TRIANGLES, 0, 3), 'drawArrays');
  // An unrelated extension is handed back untouched; a second multi-draw object is not double-counted.
  assert.equal(p.gl.getExtension('OES_whatever').foo(), 1);
  p.frame(16);
  p.frame(300, (gl) => gl.getExtension('WEBGL_multi_draw').multiDrawArraysWEBGL(TRIANGLES, [0], 0, [3], 0, 1));
  assert.deepEqual(p.of('hitch')[1].render, { calls: 1, triangles: 1 });
});

test('a hitch carries its frame\'s counts as `render`, and `delta` only for what is a change', () => {
  const p = page();
  for (let i = 0; i < 70; i++) p.frame(16, (gl) => gl.drawArrays(TRIANGLES, 0, 3));
  p.frame(300, (gl) => { gl.drawArrays(TRIANGLES, 0, 3); gl.linkProgram({}); });
  const h = p.of('hitch')[0];
  assert.deepEqual(h.render, { calls: 1, triangles: 1 });
  assert.deepEqual(h.delta, { programs: 1 });               // no textures: 0 / geometries: 0 that were never measured
  assert.equal(h.classification[0].guess, 'shader-compile'); // a WebGL link is a compile, like a WebGPU pipeline
  const create = p.of('gpu-create')[0];
  assert.equal(create.fn, 'linkProgram');
  assert.equal(typeof create.stack, 'string');
});

test('the profile reports the MEAN frame of its window, with a p95, not one frame', () => {
  const p = page();
  p.frame(16);
  for (let i = 0; i < 120; i++) p.frame(16, (gl) => { for (let k = 0; k < (i % 2 ? 3 : 1); k++) gl.drawArrays(TRIANGLES, 0, 6); });
  const prof = p.of('profile')[0];
  assert.equal(prof.render.calls, 2);        // alternating 1 and 3 draws: the mean, not the last frame's 3
  assert.equal(prof.render.triangles, 4);
  assert.equal(prof.render.frames, 120);
  assert.equal(prof.frame.p95Ms, 16);
  assert.equal(prof.tier, 0);
});

test('the page beats once a minute with its frame and counters; a page that drew nothing still beats', () => {
  const p = page();
  assert.equal(p.intervals.length, 1);
  assert.equal(p.intervals[0].ms, 60_000);
  p.frame(16);
  for (let i = 0; i < 10; i++) p.frame(20, (gl) => gl.drawArrays(TRIANGLES, 0, 9));
  p.intervals[0].fn();
  const [b] = p.of('heartbeat');
  assert.equal(b.medianFrameMs, 20);
  assert.equal(b.calls, 1);
  assert.equal(b.triangles, 3);
  assert.equal(b.frames, 10);
  assert.equal(b.tier, 0);
  p.intervals[0].fn();   // hidden: no frames since the last beat
  const idle = p.of('heartbeat')[1];
  assert.equal(idle.frames, undefined);
  assert.equal(idle.calls, undefined);
});

test('window.__sloptimizePhase stamps hitches, profiles and beats; unset, there is no phase field', () => {
  const p = page();
  for (let i = 0; i < 70; i++) p.frame(16);
  p.frame(300);
  assert.equal('phase' in p.of('hitch')[0], false);
  p.ctx.__sloptimizePhase = 'steady state';
  p.frame(16);
  p.frame(300);
  assert.equal(p.of('hitch')[1].phase, 'steady_state');   // key separators scrubbed
  p.intervals[0].fn();
  assert.equal(p.of('heartbeat')[0].phase, 'steady_state');
});
