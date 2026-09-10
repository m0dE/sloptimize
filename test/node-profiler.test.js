import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiler, DEFAULT_WINDOW_MS } from '../src/node/profiler.js';

// A fake inspector session: records every post, answers Profiler.stop with
// whatever samples were "recorded" since the last start, and lets a test hold
// a post open to interleave a take() with a window roll.
function fakeSession() {
  const posted = [];
  let since = [];
  let gate = null;
  const session = {
    connected: 0,
    connect() { this.connected++; },
    post(method, params, cb) {
      posted.push(method);
      const answer = () => {
        if (method === 'Profiler.stop') {
          const samples = since; since = [];
          cb(null, { profile: {
            nodes: [{ id: 1, callFrame: { functionName: 'step', url: 'file:///srv/world.js' } }],
            samples, timeDeltas: samples.map(() => 1000),
          } });
        } else cb(null, {});
      };
      if (gate) gate.then(answer); else queueMicrotask(answer);
    },
  };
  return {
    session, posted,
    sample(n = 1) { for (let i = 0; i < n; i++) since.push(1); },
    /** Hold every post until release() — an inspector channel that is slow. */
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    stops() { return posted.filter((m) => m === 'Profiler.stop').length; },
  };
}

// Injected timers: the window fires when the test says so, never on the clock.
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    setTimeout(fn, ms) { const t = ++id; pending.set(t, { fn, ms }); return t; },
    clearTimeout(t) { pending.delete(t); },
    armed() { return [...pending.values()].map((p) => p.ms); },
    async fire() {
      const [[t, p]] = pending; pending.delete(t); p.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const mk = async (over = {}) => {
  const s = fakeSession(), timers = fakeTimers();
  const profiler = await createProfiler({ session: s.session, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...over });
  return { s, timers, profiler };
};

test('start() connects, enables, sets the interval, starts, and arms the window', async () => {
  const { s, timers, profiler } = await mk();
  await profiler.start();
  assert.equal(s.session.connected, 1);
  assert.deepEqual(s.posted, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
  assert.deepEqual(timers.armed(), [DEFAULT_WINDOW_MS]);
  await profiler.start();                 // idempotent: no second session
  assert.equal(s.posted.length, 3);
});

test('an unread window rolls itself over: the profile never holds more than one window', async () => {
  const { s, timers, profiler } = await mk({ windowMs: 5000 });
  await profiler.start();
  s.sample(40);                           // an idle lobby, nobody asks
  await timers.fire();
  assert.deepEqual(s.posted.slice(3), ['Profiler.stop', 'Profiler.start']);
  assert.deepEqual(timers.armed(), [5000]);   // re-armed for the next window
  s.sample(3);
  const frames = await profiler.take();
  // Only the 3 samples after the roll count: the 40 before it were dropped.
  assert.deepEqual(frames, [{ file: '/srv/world.js', fn: 'step', selfMs: 3 }]);
});

test('take() folds the current window, restarts the sampler, and re-arms the window', async () => {
  const { s, timers, profiler } = await mk({ windowMs: 5000 });
  await profiler.start();
  const before = timers.armed();
  s.sample(7);
  const frames = await profiler.take();
  assert.deepEqual(frames, [{ file: '/srv/world.js', fn: 'step', selfMs: 7 }]);
  assert.deepEqual(s.posted.slice(3), ['Profiler.stop', 'Profiler.start']);
  assert.deepEqual(timers.armed(), before);   // one timer, fresh
  assert.equal(s.stops(), 1);
});

test('a window roll that fires while a take() is mid-flight waits its turn: one stop per start', async () => {
  const { s, timers, profiler } = await mk({ windowMs: 5000 });
  await profiler.start();
  s.sample(2);
  const release = s.hold();
  const taking = profiler.take();         // Profiler.stop posted, answer held
  await timers.fire();                    // the window expires meanwhile
  release();
  await taking;
  await new Promise((r) => setTimeout(r, 0));
  // stop,start (the take) then stop,start (the roll) — never stop,stop.
  const pairs = s.posted.slice(3);
  for (let i = 0; i < pairs.length; i += 2) assert.deepEqual(pairs.slice(i, i + 2), ['Profiler.stop', 'Profiler.start']);
  assert.deepEqual(timers.armed(), [5000]);
});

test('stop() disarms the window and disables the profiler; a late roll or take() is a no-op', async () => {
  const { s, timers, profiler } = await mk();
  await profiler.start();
  await profiler.stop();
  assert.deepEqual(timers.armed(), []);
  assert.deepEqual(s.posted.slice(3), ['Profiler.stop', 'Profiler.disable']);
  assert.deepEqual(await profiler.take(), []);
  assert.equal(s.posted.length, 5);
});

test('take() before start() answers nothing and posts nothing', async () => {
  const { s, profiler } = await mk();
  assert.deepEqual(await profiler.take(), []);
  assert.deepEqual(s.posted, []);
});

test('the real timer is unref\'d so the sampler never keeps the host alive', async () => {
  let unrefd = 0;
  const s = fakeSession();
  const profiler = await createProfiler({
    session: s.session,
    setTimeout: (fn, ms) => ({ unref() { unrefd++; } }),
    clearTimeout() {},
  });
  await profiler.start();
  assert.equal(unrefd, 1);
  await profiler.stop();
});
