// The page's half of a run's conditions, from the real injected bundle under
// node:vm: the refresh rate read off rAF intervals, the GPU off the game's
// own context, the device — emitted when it is first known, and again only on a change.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildInjectScript } from '../src/attach.mjs';

function page() {
  const rafs = [], emitted = [];
  class WebGL2RenderingContext {}
  const proto = WebGL2RenderingContext.prototype;
  proto.linkProgram = function () {};
  proto.RENDERER = 0x1f01;
  proto.getExtension = (name) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null);
  proto.getParameter = (p) => (p === 0x9246 ? 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)' : 'WebKit WebGL');
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    setInterval: () => 1,
    PerformanceObserver: class { observe() {} },
    performance: { now: () => 0 },
    location: { href: 'app://index.html' },
    document: { addEventListener() {} },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0', hardwareConcurrency: 16 },
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, screen: { width: 2560, height: 1440 },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    WebGL2RenderingContext,
    Error, JSON, Math, Float64Array, Date, String, Number, Array, Set, Map, Object,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0;
  const frame = (dt) => { ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  return { ctx, gl: new WebGL2RenderingContext(), frame, of: (type) => emitted.filter((e) => e.type === type) };
}

test('a 60 Hz page reports 60 Hz, the game context\'s GPU and its device — and again only when something changes', () => {
  const p = page();
  p.gl.linkProgram({});   // the game compiles: its context is now known
  for (let i = 0; i < 360; i++) p.frame(1000 / 60 + ((i % 3) - 1) * 0.2);
  // Twice: the first window's estimate, provisional; the second confirms it.
  const c = p.of('conditions');
  assert.deepEqual(c.map((x) => [x.display.refreshHz, x.display.confirmed]), [[60, false], [60, true]]);
  assert.equal(c[0].display.from, 'raf-cadence');
  assert.equal(c[0].gpu, 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11)');
  assert.equal(c[0].device.platform, 'Windows');
  assert.equal(c[0].device.vw, 1600);
  // The window is resized: the run's block must say the new size.
  p.ctx.innerWidth = 1280;
  for (let i = 0; i < 120; i++) p.frame(1000 / 60);
  assert.equal(p.of('conditions').length, 3);
  assert.equal(p.of('conditions')[2].device.vw, 1280);
});

test('the field case: a ~45 ms game on 60 Hz still reads 60, and a page with no GL context reports no GPU', () => {
  const p = page();
  const steps = [3, 2, 3, 3, 4];
  for (let i = 0; i < 360; i++) p.frame(steps[i % steps.length] * 1000 / 60);
  const c = p.of('conditions').at(-1);
  assert.equal(c.display.refreshHz, 60);
  assert.equal(c.gpu, undefined);
});
