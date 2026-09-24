// The injected tier-0 recorder's graphics-API counters (ticket 20cd5dc2):
// attach read 79 calls / 2.3M triangles where the app's renderer.info read
// 306 / 4.48M — the wraps saw drawElements/drawArrays only, and three.js
// draws every InstancedMesh through drawElementsInstanced. Pinned here: every
// draw entry point three (r160) reaches is counted, triangles follow the
// primitive mode and the instance count, WebGL program links are creations,
// and `delta` means what it means at tier 1 (this frame minus the last).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildInjectScript } from '../src/attach.mjs';

const TRIANGLES = 4, TRIANGLE_STRIP = 5, LINES = 1, POINTS = 0;

function page() {
  const rafs = [];
  const emitted = [];
  const native = [];      // every call that reached the "driver"
  const ext = {
    ANGLE_instanced_arrays: new (class ANGLEInstancedArrays {
      drawArraysInstancedANGLE(...a) { native.push(['drawArraysInstancedANGLE', ...a]); }
      drawElementsInstancedANGLE(...a) { native.push(['drawElementsInstancedANGLE', ...a]); }
    })(),
    WEBGL_multi_draw: new (class WebGLMultiDraw {
      multiDrawArraysWEBGL(...a) { native.push(['multiDrawArraysWEBGL', ...a]); }
      multiDrawElementsWEBGL(...a) { native.push(['multiDrawElementsWEBGL', ...a]); }
      multiDrawArraysInstancedWEBGL(...a) { native.push(['multiDrawArraysInstancedWEBGL', ...a]); }
      multiDrawElementsInstancedWEBGL(...a) { native.push(['multiDrawElementsInstancedWEBGL', ...a]); }
    })(),
  };
  class WebGL2RenderingContext {
    drawElements(...a) { native.push(['drawElements', ...a]); }
    drawArrays(...a) { native.push(['drawArrays', ...a]); }
    drawElementsInstanced(...a) { native.push(['drawElementsInstanced', ...a]); }
    drawArraysInstanced(...a) { native.push(['drawArraysInstanced', ...a]); }
    drawRangeElements(...a) { native.push(['drawRangeElements', ...a]); }
    linkProgram(p) { native.push(['linkProgram', p]); }
    getExtension(name) { return ext[name] ?? null; }
  }
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    PerformanceObserver: class { observe() {} },
    performance: { now: () => 0 },
    location: { href: 'app://index.html' },
    document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    WebGL2RenderingContext,
    Error, JSON, Math, Float64Array, Date, String, WeakSet, Object,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0;
  const frame = (dt) => { ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  return { gl: new WebGL2RenderingContext(), ctx, frame, emitted, native, hitches: () => emitted.filter((e) => e.type === 'hitch') };
}

/** Warm the median past the 60-frame guard with `draw()` issued every frame,
 *  then one 400 ms frame with `hitchDraw()` issued inside it. */
function hitchWith(p, draw, hitchDraw = draw) {
  for (let i = 0; i < 80; i++) { draw(p.gl); p.frame(16); }
  hitchDraw(p.gl);
  p.frame(400);
  const hs = p.hitches();
  assert.equal(hs.length, 1);
  return hs[0];
}

test('instanced, range and plain draws are all counted; instances multiply triangles', () => {
  const p = page();
  const h = hitchWith(p, (gl) => {
    gl.drawElements(TRIANGLES, 36, 0x1403, 0);                 // a Mesh: 12 triangles
    gl.drawElementsInstanced(TRIANGLES, 36, 0x1403, 0, 100);   // an InstancedMesh of 100: 1200
    gl.drawArraysInstanced(TRIANGLES, 0, 6, 10);               // 20
    gl.drawRangeElements(TRIANGLES, 0, 3, 3, 0x1403, 0);       // 1
    gl.drawArrays(TRIANGLES, 0, 3);                            // 1
  });
  assert.deepEqual(h.render, { calls: 5, triangles: 1234 });
  // The wraps pass every call through, arguments intact.
  assert.deepEqual(p.native.find((c) => c[0] === 'drawElementsInstanced'), ['drawElementsInstanced', TRIANGLES, 36, 0x1403, 0, 100]);
});

test('triangles follow the primitive mode: lines and points draw none, strips n-2', () => {
  const p = page();
  const h = hitchWith(p, (gl) => {
    gl.drawArrays(LINES, 0, 300);
    gl.drawArrays(POINTS, 0, 999);
    gl.drawArrays(TRIANGLE_STRIP, 0, 10);                       // 8
    gl.drawElementsInstanced(LINES, 60, 0x1403, 0, 50);
  });
  assert.deepEqual(h.render, { calls: 4, triangles: 8 });
});

test('the WebGL1 instancing extension and multi-draw are counted (one call per multi-draw, as renderer.info does)', () => {
  const p = page();
  const h = hitchWith(p, (gl) => {
    gl.getExtension('ANGLE_instanced_arrays').drawElementsInstancedANGLE(TRIANGLES, 6, 0x1403, 0, 7);   // 14
    gl.getExtension('ANGLE_instanced_arrays').drawArraysInstancedANGLE(TRIANGLES, 0, 3, 2);            // 2
    const md = gl.getExtension('WEBGL_multi_draw');
    md.multiDrawElementsWEBGL(TRIANGLES, new Int32Array([0, 3, 6, 9]), 1, 0x1403, new Int32Array(4), 1, 3);   // 1+2+3 = 6
    md.multiDrawArraysWEBGL(TRIANGLES, [0, 0], 0, [3, 6], 0, 2);                                            // 3
    md.multiDrawElementsInstancedWEBGL(TRIANGLES, [3, 6], 0, 0x1403, [0, 0], 0, [10, 1], 0, 2);            // 10+2
    md.multiDrawArraysInstancedWEBGL(TRIANGLES, [0], 0, [3], 0, [4], 0, 1);                                // 4
  });
  assert.deepEqual(h.render, { calls: 6, triangles: 41 });
  // Patched once, however often the page asks for the extension.
  assert.equal(p.gl.getExtension('WEBGL_multi_draw'), p.gl.getExtension('WEBGL_multi_draw'));
  assert.equal(p.native.filter((c) => c[0] === 'multiDrawArraysWEBGL').length, 81);
  assert.equal(p.gl.getExtension('OES_nope'), null);
});

test('delta is this frame minus the last, as at tier 1; render is the frame itself', () => {
  const p = page();
  let hitchFrame = false;
  const h = hitchWith(p, (gl) => { for (let i = 0; i < 10; i++) gl.drawArrays(TRIANGLES, 0, 3); },
    (gl) => { hitchFrame = true; for (let i = 0; i < 25; i++) gl.drawArrays(TRIANGLES, 0, 3); });
  assert.ok(hitchFrame);
  assert.deepEqual(h.render, { calls: 25, triangles: 25 });
  assert.equal(h.delta.calls, 15);
  assert.equal(h.delta.triangles, 15);
  assert.equal(h.delta.programs, 0);
  assert.equal(h.delta.textures, undefined);     // tier 0 cannot see textures: absent, never a measured 0
});

test('a WebGL program link is a creation: counted into the hitch, ledgered with its stack, and it can read as shader-compile', () => {
  const p = page();
  const h = hitchWith(p, () => {}, (gl) => { gl.linkProgram({}); gl.linkProgram({}); });
  assert.equal(h.delta.programs, 2);
  assert.equal(h.classification[0].guess, 'shader-compile');
  const creates = p.emitted.filter((e) => e.type === 'gpu-create');
  assert.equal(creates.length, 2);
  assert.equal(creates[0].fn, 'linkProgram');
  assert.equal(typeof creates[0].stack, 'string');
  assert.equal(p.native.filter((c) => c[0] === 'linkProgram').length, 2);
});

test('the profile line carries p95 and fps, and the counters as the median frame of the window', () => {
  const p = page();
  let i = 0;
  for (; i < 240; i++) {
    const n = i % 4 === 0 ? 40 : 10;           // a one-in-four spike must not become the number
    for (let k = 0; k < n; k++) p.gl.drawArrays(TRIANGLES, 0, 3);
    p.frame(i % 10 === 0 ? 30 : 16);
  }
  const prof = p.emitted.filter((e) => e.type === 'profile').pop();
  assert.equal(prof.tier, 0);
  assert.equal(prof.frame.medianMs, 16);
  assert.equal(prof.frame.p95Ms, 30);
  assert.equal(prof.frame.fps, 63);
  assert.deepEqual(prof.render, { calls: 10, triangles: 10 });
});
