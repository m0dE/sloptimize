// The injected tier-0 recorder under node:vm: a hidden window's rAF gap must
// not be a hitch once visibilitychange has re-seeded the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildInjectScript } from '../src/attach.mjs';

function page() {
  const rafs = [];
  const emitted = [];
  const docListeners = {};
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    PerformanceObserver: class { observe() {} },
    performance: { now: () => 0 },
    location: { href: 'app://index.html' },
    document: { visibilityState: 'visible', addEventListener: (ev, fn) => { (docListeners[ev] ??= []).push(fn); } },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    Error, JSON, Math, Float64Array, Date, String,
  };
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0;
  const frame = (dt) => { ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  const visibility = (state) => { ctx.document.visibilityState = state; for (const f of docListeners.visibilitychange ?? []) f(); };
  return { frame, visibility, emitted, hitches: () => emitted.filter((e) => e.type === 'hitch') };
}

test('a 5 s gap with no visibility event is a hitch (the detector still works)', () => {
  const p = page();
  for (let i = 0; i < 80; i++) p.frame(16);
  p.frame(5000);
  assert.equal(p.hitches().length, 1);
  assert.equal(p.hitches()[0].frameMs, 5000);
});

test('the same gap across hidden→visible is not a hitch', () => {
  const p = page();
  for (let i = 0; i < 80; i++) p.frame(16);
  p.visibility('hidden');
  p.visibility('visible');
  p.frame(5000);   // first rAF after restore
  p.frame(16);
  assert.equal(p.hitches().length, 0);
  p.frame(400);    // a real stall afterwards is still caught
  assert.equal(p.hitches().length, 1);
});
