// The page's half of runs and phases (ticket 20cd5dc2, issue 5): tier 0 needs
// zero integration, but a page that wants its spawn flood read apart from its
// steady state can say which is which — one global, three calls, stamped on
// every hitch and profile line from then on (tier 1 stamps `phase` per frame
// the same way).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildInjectScript } from '../src/attach.mjs';

function page() {
  const rafs = [];
  const emitted = [];
  const ctx = {
    requestAnimationFrame: (cb) => rafs.push(cb),
    PerformanceObserver: class { observe() {} },
    performance: { now: () => 0 },
    location: { href: 'app://index.html' },
    document: { addEventListener() {} },
    __sloptimizeEmit: (json) => emitted.push(JSON.parse(json)),
    Error, JSON, Math, Float64Array, Date, String, WeakSet, Object,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(buildInjectScript(), ctx);
  let ts = 0;
  const frame = (dt) => { ts += dt; const cb = rafs.pop(); rafs.length = 0; cb(ts); };
  const warm = () => { for (let i = 0; i < 80; i++) frame(16); };
  return { api: ctx.__sloptimizeAttach, frame, warm, emitted, last: (type) => emitted.filter((e) => e.type === type).pop() };
}

test('phase, context and build are stamped on the hitches and profile lines after the call', () => {
  const p = page();
  assert.equal(typeof p.api.phase, 'function');
  p.warm();
  p.frame(400);
  const before = p.last('hitch');
  assert.equal(before.phase, undefined);
  assert.equal(before.build, undefined);
  p.api.phase('spawn');
  p.api.context({ units: 'many', map: 'harbor' });
  p.api.build('index-CNbvoNb_');
  p.frame(400);
  const h = p.last('hitch');
  assert.equal(h.phase, 'spawn');
  assert.deepEqual({ ...h.ctx }, { units: 'many', map: 'harbor' });
  assert.equal(h.build, 'index-CNbvoNb_');
  for (let i = 0; i < 120; i++) p.frame(16);
  const prof = p.last('profile');
  assert.equal(prof.phase, 'spawn');
  assert.equal(prof.build, 'index-CNbvoNb_');
  p.api.phase('steady');
  p.frame(400);
  assert.equal(p.last('hitch').phase, 'steady');
});

test('clearing and scrubbing: an empty phase clears it; a separator cannot break a footprint key', () => {
  const p = page();
  p.warm();
  p.api.phase('a|b');
  p.frame(400);
  assert.equal(p.last('hitch').phase, 'a_b');
  p.api.phase('');
  p.api.context(null);
  p.frame(400);
  assert.equal(p.last('hitch').phase, undefined);
  assert.equal(p.last('hitch').ctx, undefined);
  p.api.phase('x'.repeat(200));
  p.frame(400);
  assert.equal(p.last('hitch').phase.length, 40);
});
