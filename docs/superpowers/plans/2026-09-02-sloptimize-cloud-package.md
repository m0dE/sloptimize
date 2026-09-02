# sloptimize 0.4.0 — cloud sink, error capture, Node runtime (package plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `sloptimize` npm package so a game can ship its incident records to sloptimize cloud from the browser and from its Node game server, capture errors on both sides, and read the hosted catalogue from the CLI and MCP.

**Architecture:** Three new modules beside the existing recorder: `errors.js` (browser error → record), `cloud-sink.js` (batch + POST with backoff), and `node/index.js` (server tick/stall/error runtime with a V8 sampling profiler). Footprint identity for the new record kinds is added to `footprint.js` so the cloud service, which imports this package, recomputes the same ids. The CLI and MCP gain a `--cloud` read path. Everything stays dependency-free.

**Tech Stack:** Plain ES modules, `node --test`, `fetch`, `navigator.sendBeacon`, `node:inspector`, `node:perf_hooks`.

**Spec:** `/app/data/home/sloptimize-cloud/docs/superpowers/specs/2026-09-02-sloptimize-cloud-design.md` §5, §8, §11. Read it before starting.

## Global Constraints

- Zero runtime dependencies. No new entries in `dependencies`.
- `FOOTPRINT_VERSION` does not change; existing footprint ids must stay identical (the existing `test/footprint.test.js` pins this).
- The recorder's steady path stays allocation-free; new work happens only when an incident is minted.
- Nothing installed by this package may change the host's error semantics: no `preventDefault` on error events, no `uncaughtException` listener (only `uncaughtExceptionMonitor`), no `unhandledRejection` listener.
- All network work is wrapped so it can never throw into the host; failures land in `stats().lastError`.
- Test files live in `test/`, named `<module>.test.js`, using `node:test` and `node:assert/strict`, like the existing ones.
- Commit after each task. Run the whole suite (`npm test`) before every commit.

---

### Task P1: Footprint identity for `error`, `server-hitch`, `server-stall`

**Files:**
- Modify: `src/footprint.js` (`baseKey`, `describeBase`)
- Test: `test/footprint-cloud.test.js`

**Interfaces:**
- Produces: exported `normalizeErrorMessage(msg): string`, `topFrameSite(stack): string` (stack is an array of frame strings or a multi-line string), and new `baseKey` cases:
  - `error|<source>|<name>|<normalized message>|<site>`
  - `server-hitch|<phase>|<site of frames[0]>` where `rec.frames[0] = { file, fn, selfMs }` → site `${file}#${fn}`; when `rec.frames` is empty or `rec.attribution === 'off'`, site is `unattributed`.
  - `server-stall|<phase>|<site>` same rule.
  - `describeBase` glyphs/labels: error `✖` `error · <name> · <message cut to 60>`, server-hitch `▣` `server tick over budget · <site>`, server-stall `▦` `event-loop stall · <site>`; phase is parts[1] for server kinds, `''` for error.

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { footprintOf, footprintKey, describeFootprint, normalizeErrorMessage, topFrameSite } from '../src/footprint.js';

test('error messages normalize numbers, hex ids, quoted strings, whitespace, and length', () => {
  assert.equal(normalizeErrorMessage('Cannot read properties of undefined (reading \'mesh_1f2a\')'), 'Cannot read properties of undefined (reading "…")');
  assert.equal(normalizeErrorMessage('Timeout after 1500ms for request 0xdeadbeef'), 'Timeout after #ms for request #');
  assert.equal(normalizeErrorMessage('  a   b\n c '), 'a b c');
  assert.equal(normalizeErrorMessage('x'.repeat(200)).length, 120);
});

test('the top frame site drops origin, query, hash, line and column', () => {
  assert.equal(topFrameSite(['at render (https://game.example/assets/main.js?v=3:120:45)']), '/assets/main.js#render');
  assert.equal(topFrameSite('TypeError: x\n    at https://game.example/a.js:1:2'), '/a.js#anonymous');
  assert.equal(topFrameSite(['at step (/srv/game/dist/world.js:10:5)']), '/srv/game/dist/world.js#step');
  assert.equal(topFrameSite([]), 'unknown');
});

test('error footprints: same cause across builds and ids, different across sites', () => {
  const e = (over = {}) => ({ type: 'error', at: '2026-09-02T00:00:00Z', source: 'client', name: 'TypeError', message: 'Cannot read properties of undefined (reading \'x_12\')', stack: ['at render (https://g/a.js:1:1)'], ...over });
  assert.equal(footprintOf(e()).id, footprintOf(e({ at: '2026-09-03T00:00:00Z', message: 'Cannot read properties of undefined (reading \'x_99\')', stack: ['at render (https://g/a.js?v=9:200:7)'] })).id);
  assert.notEqual(footprintOf(e()).id, footprintOf(e({ stack: ['at update (https://g/a.js:1:1)'] })).id);
  assert.notEqual(footprintOf(e()).id, footprintOf(e({ source: 'server' })).id);
  assert.equal(footprintKey(e({ ctx: { stance: 'helm' } })), 'error|client|TypeError|Cannot read properties of undefined (reading "…")|/a.js#render|ctx:stance=helm');
  assert.deepEqual(describeFootprint(footprintKey(e())), { glyph: '✖', label: 'error · TypeError · Cannot read properties of undefined (reading "…")', phase: '', ctx: '' });
});

test('server-hitch and server-stall footprints name the phase and top self-time frame', () => {
  const h = { type: 'server-hitch', at: '2026-09-02T00:00:00Z', phase: 'match', tickMs: 40, budgetMs: 16, frames: [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }] };
  assert.equal(footprintKey(h), 'server-hitch|match|/srv/world.js#step');
  assert.equal(footprintKey({ ...h, frames: [], attribution: 'off' }), 'server-hitch|match|unattributed');
  assert.equal(footprintKey({ type: 'server-stall', at: '2026-09-02T00:00:00Z', phase: 'lobby', p99Ms: 80, frames: [{ file: '/srv/db.js', fn: 'query', selfMs: 60 }] }), 'server-stall|lobby|/srv/db.js#query');
  assert.deepEqual(describeFootprint(footprintKey(h)), { glyph: '▣', label: 'server tick over budget · /srv/world.js#step', phase: 'match', ctx: '' });
});
```

- [ ] **Step 2: Run** — `node --test test/footprint-cloud.test.js` FAILS (no exports).

- [ ] **Step 3: Implement in `src/footprint.js`**

```js
export function normalizeErrorMessage(msg) {
  return String(msg ?? '')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '"…"')
    .replace(/0x[0-9a-f]{6,}/gi, '#')
    .replace(/\b[0-9a-f]{6,}\b/gi, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** `<path>#<function>` of the top stack frame, without origin, query, hash, line or column. */
export function topFrameSite(stack) {
  const lines = Array.isArray(stack) ? stack : String(stack ?? '').split('\n');
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line.startsWith('at ')) continue;
    // "at fn (loc)" | "at loc"
    const m = /^at (?:(.+?) \()?(.+?)\)?$/.exec(line);
    if (!m) continue;
    const fn = m[1] && !/^(async |new )/.test(m[1]) ? m[1] : (m[1] ? m[1].replace(/^(async |new )+/, '') : 'anonymous');
    let loc = m[2];
    loc = loc.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '');
    try { const u = new URL(loc); loc = u.pathname; } catch { /* not a URL: a path */ }
    loc = loc.replace(/[?#].*$/, '');
    return `${loc}#${fn || 'anonymous'}`;
  }
  return 'unknown';
}

function serverSite(rec) {
  const f = Array.isArray(rec.frames) ? rec.frames[0] : undefined;
  if (rec.attribution === 'off' || !f) return 'unattributed';
  return `${f.file ?? '?'}#${f.fn ?? 'anonymous'}`;
}
```

Add to `baseKey`'s switch:

```js
    case 'error':
      return `error|${rec.source ?? 'client'}|${rec.name ?? 'Error'}|${normalizeErrorMessage(rec.message)}|${topFrameSite(rec.stack)}`;
    case 'server-hitch':
      return `server-hitch|${phase}|${serverSite(rec)}`;
    case 'server-stall':
      return `server-stall|${phase}|${serverSite(rec)}`;
```

Add to `describeBase`:

```js
    case 'error': return { glyph: '✖', label: `error · ${parts[2] ?? '?'} · ${(parts[3] ?? '').slice(0, 60)}`, phase: '' };
    case 'server-hitch': return { glyph: '▣', label: `server tick over budget · ${parts[2] ?? '?'}`, phase: parts[1] ?? '?' };
    case 'server-stall': return { glyph: '▦', label: `event-loop stall · ${parts[2] ?? '?'}`, phase: parts[1] ?? '?' };
```

Also add `worstOf` cases in `src/history.js`: `error` → undefined; `server-hitch` → `{ value: r.tickMs, unit: 'ms' }`; `server-stall` → `{ value: r.p99Ms, unit: 'ms' }`.

Note `describeBase` splits on `|`; a normalized message may itself contain `|`. Replace `|` with `¦` inside `normalizeErrorMessage` (add `.replace(/\|/g, '¦')`) and add an assertion for it in the first test.

- [ ] **Step 4: Run `npm test`** — all PASS including the existing footprint pins.

- [ ] **Step 5: Commit** — `git commit -am "Footprints for error, server-hitch, server-stall (SPEC cloud §5)"`

---

### Task P2: `recorder.emit()` and `createErrorMonitor`

**Files:**
- Modify: `src/recorder.js` (add `emit`), `src/index.js` (export)
- Create: `src/errors.js`, `test/errors.test.js`

**Interfaces:**
- Produces:
  - `recorder.emit(rec)`: appends an externally built incident record subject to `MAX_RECORDS_PER_SESSION`; stamps `at` if missing, `phase`/`ctx` from the last frame sample if absent. Returns `true` when queued, `false` when dropped (counted in `droppedSinceLast`).
  - `createErrorMonitor(recorder, opts = { target: globalThis, dedupeMs: 10000, maxFrames: 10, now })` → `{ dispose(), stats() }`. Listens for `error` and `unhandledrejection` on `opts.target`. Builds `{ type: 'error', at, source: 'client', name, message, stack: string[] }` and calls `recorder.emit`. Dedupe by footprint id within `dedupeMs`. Never calls `preventDefault`. `stats()` → `{ seen, emitted, deduped }`.

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/recorder.js';
import { createErrorMonitor } from '../src/errors.js';

function fakeTarget() {
  const listeners = {};
  return {
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    fire(type, ev) { for (const fn of listeners[type] ?? []) fn(ev); },
    count(type) { return (listeners[type] ?? []).length; },
  };
}
const err = (msg, stack) => Object.assign(new TypeError(msg), { stack: `TypeError: ${msg}\n    ${stack}` });

test('window errors become error records with a trimmed stack, deduped per footprint', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  const target = fakeTarget();
  let t = 0;
  const mon = createErrorMonitor(rec, { target, now: () => t });
  let prevented = false;
  target.fire('error', { error: err('boom 1', 'at render (https://g/a.js:1:1)'), message: 'boom 1', preventDefault: () => { prevented = true; } });
  target.fire('error', { error: err('boom 2', 'at render (https://g/a.js:9:9)'), message: 'boom 2', preventDefault() {} });
  t = 20000;
  target.fire('error', { error: err('boom 3', 'at render (https://g/a.js:9:9)'), message: 'boom 3', preventDefault() {} });
  const out = rec.drainRecords();
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'error');
  assert.equal(out[0].source, 'client');
  assert.equal(out[0].name, 'TypeError');
  assert.deepEqual(out[0].stack, ['at render (https://g/a.js:1:1)']);
  assert.equal(prevented, false);
  assert.deepEqual(mon.stats(), { seen: 3, emitted: 2, deduped: 1 });
  mon.dispose();
  assert.equal(target.count('error'), 0);
});

test('unhandled rejections with a non-Error reason still record', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  const target = fakeTarget();
  createErrorMonitor(rec, { target, now: () => 0 });
  target.fire('unhandledrejection', { reason: 'nope' });
  const [r] = rec.drainRecords();
  assert.equal(r.name, 'UnhandledRejection');
  assert.equal(r.message, 'nope');
  assert.deepEqual(r.stack, []);
});

test('recorder.emit stamps at, respects the session cap, and reports drops', () => {
  const rec = createRecorder({ budgetFrameMs: 16.7 });
  assert.equal(rec.emit({ type: 'error', name: 'E', message: 'm', stack: [] }), true);
  const [r] = rec.drainRecords();
  assert.match(r.at, /^\d{4}-/);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement**

In `src/recorder.js`, inside the returned object (beside `usermark`):

```js
    /** Append an externally built incident (errors, host-detected events). Same session cap as hitches. */
    emit(rec) {
      if (!rec || typeof rec !== 'object') return false;
      if (sessionRecords >= MAX_RECORDS_PER_SESSION) { droppedSinceLast++; return false; }
      sessionRecords++;
      if (!rec.at) rec.at = new Date().toISOString();
      if (rec.phase === undefined && lastPhase) rec.phase = lastPhase;
      if (rec.ctx === undefined && lastCtx) rec.ctx = lastCtx;
      if (droppedSinceLast > 0) { rec.droppedSinceLast = droppedSinceLast; droppedSinceLast = 0; }
      records.push(rec);
      return true;
    },
```

Where `lastPhase`/`lastCtx` are two `let`s updated in the frame sampler where `s.phase`/`s.ctx` are read (`if (s.phase) lastPhase = s.phase; if (s.ctx) lastCtx = s.ctx;` — one assignment each, no allocation).

`src/errors.js`:

```js
// ============================================================
// errors.js — the browser's errors as incidents (SPEC cloud §8.1)
// ============================================================
// An uncaught error is a bottleneck of a different kind: the frame it killed
// never rendered. It is recorded with the same identity model as a hitch —
// the footprint names the cause (class, normalized message, top frame),
// never the occurrence — so a thousand players hitting one bug is one row.
// The monitor NEVER preventDefault()s: the console and the host's own
// handlers see exactly what they saw before.
import { footprintOf } from './footprint.js';

export function createErrorMonitor(recorder, opts = {}) {
  const target = opts.target ?? globalThis;
  const dedupeMs = opts.dedupeMs ?? 10000;
  const maxFrames = opts.maxFrames ?? 10;
  const now = opts.now ?? (() => Date.now());
  const lastByFp = new Map();
  const stats = { seen: 0, emitted: 0, deduped: 0 };

  function frames(stack) {
    return String(stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, maxFrames);
  }
  function toRecord(name, message, stack) {
    return { type: 'error', at: new Date().toISOString(), source: 'client', name, message: String(message ?? ''), stack: frames(stack) };
  }
  function handle(rec) {
    stats.seen++;
    const fp = footprintOf(rec);
    const t = now();
    const last = fp ? lastByFp.get(fp.id) : undefined;
    if (last !== undefined && t - last < dedupeMs) { stats.deduped++; return; }
    if (fp) lastByFp.set(fp.id, t);
    if (recorder.emit(rec)) stats.emitted++;
  }
  const onError = (ev) => {
    try {
      const e = ev?.error;
      handle(e instanceof Error ? toRecord(e.name || 'Error', e.message, e.stack) : toRecord('Error', ev?.message ?? String(e ?? ''), ''));
    } catch { /* never throw into the host */ }
  };
  const onRejection = (ev) => {
    try {
      const r = ev?.reason;
      handle(r instanceof Error ? toRecord(r.name || 'Error', r.message, r.stack) : toRecord('UnhandledRejection', typeof r === 'string' ? r : JSON.stringify(r ?? null), ''));
    } catch { /* never throw into the host */ }
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return {
    dispose() { target.removeEventListener('error', onError); target.removeEventListener('unhandledrejection', onRejection); },
    stats() { return { ...stats }; },
  };
}
```

Export from `src/index.js`: `export { createErrorMonitor } from './errors.js';`

- [ ] **Step 4: Run `npm test`; commit** — `git commit -am "Error monitor: window errors and rejections as deduped incident records; recorder.emit"`

---

### Task P3: `createCloudSink`

**Files:**
- Create: `src/cloud-sink.js`, `test/cloud-sink.test.js`
- Modify: `src/index.js` (export), `package.json` (`exports["./cloud"]`, `["./errors"]`)

**Interfaces:**
- Produces: `createCloudSink({ key, endpoint, build, sources, flushMs = 5000, maxBatch = 100, maxQueue = 500, fetch, sendBeacon, target = globalThis, setInterval, clearInterval, now })` → `{ flush(): Promise<void>, stats(), dispose() }`. `stats()` → `{ queued, sent, droppedLocally, backoffUntil, lastError, lastStatus }`. Throws synchronously only when `key` or `endpoint` is missing (a misconfiguration, not a runtime failure).

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudSink } from '../src/cloud-sink.js';

function harness({ statuses = [] } = {}) {
  const calls = [];
  let t = 0;
  const timers = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers, keepalive: init.keepalive });
    const status = statuses.shift() ?? 202;
    return { ok: status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' && status === 429 ? '30' : null) }, json: async () => ({ accepted: 1, dropped: [] }) };
  };
  const beacons = [];
  const listeners = {};
  const target = { addEventListener: (k, f) => (listeners[k] ??= []).push(f), removeEventListener: (k, f) => { listeners[k] = (listeners[k] ?? []).filter((x) => x !== f); }, fire: (k, ev) => (listeners[k] ?? []).forEach((f) => f(ev)) };
  const source = { pending: [], drainRecords() { const r = this.pending; this.pending = []; return r; } };
  return {
    calls, beacons, target, source, now: () => t, tick: (ms) => { t += ms; },
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {}, runTimers: () => timers.forEach((x) => x.fn()),
    fetch, sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; },
  };
}
const mk = (h, over = {}) => createCloudSink({ key: 'pk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'b1', sources: [h.source], fetch: h.fetch, sendBeacon: h.sendBeacon, target: h.target, setInterval: h.setInterval, clearInterval: h.clearInterval, now: h.now, ...over });

test('drains sources on the timer and posts a batch with the key and build', async () => {
  const h = harness();
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  h.runTimers();
  await sink.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].headers.authorization, 'Bearer pk_live_x');
  assert.equal(h.calls[0].body.build, 'b1');
  assert.equal(h.calls[0].body.records.length, 1);
  assert.equal(sink.stats().sent, 1);
});

test('429 and 5xx back off 5s/30s/2m then every 5m; success resets', async () => {
  const h = harness({ statuses: [500, 500, 500, 500, 202] });
  const sink = mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();                          // 500 → backoff 5s
  assert.equal(sink.stats().backoffUntil, 5000);
  await sink.flush(); assert.equal(h.calls.length, 1);   // still backing off
  h.tick(5000); await sink.flush();            // 500 → 30s
  assert.equal(sink.stats().backoffUntil, 35000);
  h.tick(30000); await sink.flush();           // 500 → 2m
  assert.equal(sink.stats().backoffUntil, 155000);
  h.tick(120000); await sink.flush();          // 500 → 5m
  assert.equal(sink.stats().backoffUntil, 455000);
  h.tick(300000); await sink.flush();          // 202
  assert.equal(sink.stats().backoffUntil, 0);
  assert.equal(sink.stats().queued, 0);
});

test('queue cap drops oldest and reports droppedLocally on the next success', async () => {
  const h = harness({ statuses: [500, 202] });
  const sink = mk(h, { maxQueue: 3 });
  for (let i = 0; i < 5; i++) h.source.pending.push({ type: 'hitch', at: String(i) });
  await sink.flush();                          // fails; queue trimmed to 3 (2 dropped)
  assert.equal(sink.stats().droppedLocally, 2);
  h.tick(5000); await sink.flush();
  assert.equal(h.calls[1].body.droppedLocally, 2);
  assert.deepEqual(h.calls[1].body.records.map((r) => r.at), ['2', '3', '4']);
  assert.equal(sink.stats().droppedLocally, 0);
});

test('pagehide flushes via sendBeacon with the key in the query', () => {
  const h = harness();
  mk(h);
  h.source.pending.push({ type: 'hitch', at: 'x' });
  h.target.fire('pagehide', {});
  assert.equal(h.beacons.length, 1);
  assert.equal(h.beacons[0].url, 'https://c.example/v1/ingest?key=pk_live_x');
});

test('fetch throwing never escapes; it lands in stats().lastError', async () => {
  const h = harness();
  const sink = mk(h, { fetch: async () => { throw new Error('offline'); } });
  h.source.pending.push({ type: 'hitch', at: 'x' });
  await sink.flush();
  assert.equal(sink.stats().lastError, 'offline');
  assert.equal(sink.stats().queued, 1);
});

test('missing key or endpoint is a configuration error', () => {
  assert.throws(() => createCloudSink({ endpoint: 'x', sources: [] }), /key/);
  assert.throws(() => createCloudSink({ key: 'x', sources: [] }), /endpoint/);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `src/cloud-sink.js`**

```js
// ============================================================
// cloud-sink.js — ship records to sloptimize cloud (SPEC cloud §8.2)
// ============================================================
// Runs BESIDE the file sink, never instead of it. Drains every source on a
// timer, posts batches with the publishable key, backs off on 429/5xx, caps
// its queue, and tells the service how many it had to drop locally so the
// dashboard's "dropped" column is honest. Never throws into the host.
const BACKOFF_MS = [5000, 30000, 120000, 300000];

export function createCloudSink(opts = {}) {
  if (!opts.key) throw new Error('createCloudSink: key is required');
  if (!opts.endpoint) throw new Error('createCloudSink: endpoint is required');
  const { key, endpoint, build } = opts;
  const sources = opts.sources ?? [];
  const flushMs = opts.flushMs ?? 5000, maxBatch = opts.maxBatch ?? 100, maxQueue = opts.maxQueue ?? 500;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const beacon = opts.sendBeacon ?? (typeof navigator !== 'undefined' && navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null);
  const target = opts.target ?? globalThis;
  const setI = opts.setInterval ?? globalThis.setInterval, clearI = opts.clearInterval ?? globalThis.clearInterval;
  const now = opts.now ?? (() => Date.now());

  let queue = [];
  let droppedLocally = 0;
  let failures = 0, backoffUntil = 0, inflight = false;
  const stats = { sent: 0, lastError: null, lastStatus: null };

  function drain() {
    for (const s of sources) {
      let r; try { r = s.drainRecords(); } catch { continue; }
      if (r && r.length) queue.push(...r);
    }
    if (queue.length > maxQueue) { droppedLocally += queue.length - maxQueue; queue = queue.slice(queue.length - maxQueue); }
  }
  function body(records) {
    const b = { records };
    if (build) b.build = build;
    if (droppedLocally) b.droppedLocally = droppedLocally;
    return b;
  }
  async function flush() {
    drain();
    if (inflight || queue.length === 0 || now() < backoffUntil) return;
    inflight = true;
    const batch = queue.slice(0, maxBatch);
    const sentDropped = droppedLocally;
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body(batch)),
      });
      stats.lastStatus = res.status;
      if (res.ok) {
        queue = queue.slice(batch.length);
        droppedLocally -= sentDropped;
        failures = 0; backoffUntil = 0; stats.sent += batch.length; stats.lastError = null;
      } else if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers?.get?.('retry-after'));
        const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
        backoffUntil = now() + (Number.isFinite(ra) && ra > 0 ? Math.max(ra * 1000, wait) : wait);
        failures++;
        stats.lastError = `HTTP ${res.status}`;
      } else {
        // 4xx other than 429: the batch is unacceptable; drop it rather than retry forever.
        queue = queue.slice(batch.length);
        droppedLocally += batch.length;
        stats.lastError = `HTTP ${res.status}`;
      }
    } catch (e) {
      stats.lastError = e?.message ?? String(e);
      const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      backoffUntil = now() + wait; failures++;
    } finally { inflight = false; }
  }
  function onHide() {
    try {
      drain();
      if (queue.length === 0 || !beacon) return;
      const batch = queue.slice(0, maxBatch);
      const ok = beacon(`${endpoint}?key=${encodeURIComponent(key)}`, new Blob([JSON.stringify(body(batch))], { type: 'application/json' }));
      if (ok) { queue = queue.slice(batch.length); droppedLocally = 0; stats.sent += batch.length; }
    } catch { /* never throw into the host */ }
  }
  const timer = setI(() => { flush(); }, flushMs);
  target.addEventListener?.('pagehide', onHide);
  const onVis = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onHide(); };
  target.addEventListener?.('visibilitychange', onVis);
  return {
    flush,
    stats() { return { queued: queue.length, sent: stats.sent, droppedLocally, backoffUntil, lastError: stats.lastError, lastStatus: stats.lastStatus }; },
    dispose() { clearI(timer); target.removeEventListener?.('pagehide', onHide); target.removeEventListener?.('visibilitychange', onVis); },
  };
}
```

Note on the backoff test: `backoffUntil` after the fourth failure is `now + 300000` where `now` is 155000, i.e. 455000. The test's expectations follow that arithmetic.

`Blob` exists in Node ≥ 18 globally, so the test needs no polyfill.

`package.json`: add `"./cloud": "./src/cloud-sink.js"`, `"./errors": "./src/errors.js"` to `exports`; export `createCloudSink` from `src/index.js`.

- [ ] **Step 4: Run `npm test`; commit** — `git commit -am "Cloud sink: batched POST with key, backoff, queue cap, droppedLocally, sendBeacon on pagehide"`

---

### Task P4: `sloptimize/node` — server runtime

**Files:**
- Create: `src/node/profiler.js`, `src/node/index.js`, `test/node-runtime.test.js`
- Modify: `package.json` (`exports["./node"]`)

**Interfaces:**
- Produces:
  - `src/node/profiler.js`: `createProfiler({ session, intervalUs = 1000 })` → `{ start(), async take(): Frame[], stop() }`. `session` defaults to `new (await import('node:inspector')).Session()`; injectable for tests. `take()` posts `Profiler.stop`, folds the CPU profile into self-time per `(url, functionName)` excluding frames whose `url` contains `/sloptimize/src/node/` or is empty with `(program)|(garbage collector)|(idle)`, returns the top 5 as `{ file, fn, selfMs }` (file is `url` with `file://` stripped), then posts `Profiler.start` again. Exported pure helper `foldProfile(profile, excludeUrl): Frame[]` (input: the `Profiler.stop` result's `.profile` with `nodes`, `samples`, `timeDeltas`).
  - `src/node/index.js`: `createServerRuntime(opts)` → `{ tick(fn), beginTick(), endTick(token), mark(label, meta), flush(), stats(), close() }`.
    `opts`: `{ key, endpoint, build, tickBudgetMs = 16, stallMs = 50, phase = () => undefined, context = () => undefined, profile = true, fetch, now, monitor, profiler, process: proc = process, flushMs = 5000 }`.
    Records: `server-hitch { type, at, phase, ctx, tickMs, budgetMs, frames, attribution: 'profiler'|'off' }`, `server-stall { type, at, phase, ctx, p50Ms, p99Ms, maxMs, frames, attribution }`, `error { type, at, source: 'server', name, message, stack: string[], phase, ctx }`.
    Rate limits: hitch at most 1/s, stall at most 1/5s. Transport reuses `createCloudSink` with a single internal source and the Node `fetch`; `sendBeacon` is null; `beforeExit` → `flush()` with a 2 s timeout.

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldProfile } from '../src/node/profiler.js';
import { createServerRuntime } from '../src/node/index.js';

test('foldProfile ranks self time per (url, function), excludes runtime and VM frames, strips file://', () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' } },
      { id: 2, callFrame: { functionName: 'step', url: 'file:///srv/world.js' } },
      { id: 3, callFrame: { functionName: 'query', url: 'file:///srv/db.js' } },
      { id: 4, callFrame: { functionName: 'take', url: 'file:///x/node_modules/sloptimize/src/node/profiler.js' } },
      { id: 5, callFrame: { functionName: '(garbage collector)', url: '' } },
    ],
    samples: [2, 2, 3, 4, 5, 2],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000],
  };
  assert.deepEqual(foldProfile(profile, '/sloptimize/src/node/'), [
    { file: '/srv/world.js', fn: 'step', selfMs: 3 },
    { file: '/srv/db.js', fn: 'query', selfMs: 1 },
  ]);
});

function harness() {
  let t = 0;
  const posted = [];
  const fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 202, headers: { get: () => null }, json: async () => ({}) }; };
  const monitor = { percentiles: new Map([[50, 1e6], [99, 1e6]]), max: 1e6, reset() {}, enable() {}, disable() {} };
  const profiler = { started: 0, start() { this.started++; }, async take() { return [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]; }, stop() {} };
  const handlers = {};
  const proc = { on: (k, f) => { handlers[k] = f; }, off: () => {}, emit: (k, ...a) => handlers[k]?.(...a) };
  const timers = [];
  return { posted, fetch, monitor, profiler, proc, now: () => t, tick: (ms) => { t += ms; }, timers,
    setInterval: (fn, ms) => { timers.push(fn); return { unref() {} }; }, clearInterval() {} };
}
const mk = (h, over = {}) => createServerRuntime({ key: 'sk_live_x', endpoint: 'https://c.example/v1/ingest', build: 'srv1', tickBudgetMs: 16, stallMs: 50,
  phase: () => 'match', context: () => ({ mode: 'ranked' }), fetch: h.fetch, now: h.now, monitor: h.monitor, profiler: h.profiler, process: h.proc,
  setInterval: h.setInterval, clearInterval: h.clearInterval, ...over });

test('a tick over budget records server-hitch with frames, phase, ctx; under budget records nothing; 1/s limit', async () => {
  const h = harness();
  const rt = mk(h);
  rt.tick(() => h.tick(40));
  rt.tick(() => h.tick(5));
  rt.tick(() => h.tick(40));            // within 1s of the first → dropped
  await rt.flush();
  assert.equal(h.posted.length, 1);
  const [r] = h.posted[0].records;
  assert.equal(r.type, 'server-hitch');
  assert.equal(r.tickMs, 40); assert.equal(r.budgetMs, 16);
  assert.equal(r.phase, 'match'); assert.equal(r.ctx, 'mode=ranked');
  assert.deepEqual(r.frames, [{ file: '/srv/world.js', fn: 'step', selfMs: 30 }]);
  assert.equal(r.attribution, 'profiler');
  assert.equal(h.posted[0].build, 'srv1');
  assert.equal(rt.stats().hitches, 1);
  assert.equal(rt.stats().droppedByRate, 1);
});

test('beginTick/endTick pair works like tick; profile:false yields attribution off', async () => {
  const h = harness();
  const rt = mk(h, { profile: false });
  const tok = rt.beginTick(); h.tick(30); rt.endTick(tok);
  await rt.flush();
  const [r] = h.posted[0].records;
  assert.equal(r.attribution, 'off');
  assert.deepEqual(r.frames, []);
});

test('event-loop delay p99 over stallMs records server-stall once per 5s', async () => {
  const h = harness();
  const rt = mk(h);
  h.monitor.percentiles = new Map([[50, 5e6], [99, 80e6]]); h.monitor.max = 90e6;
  h.timers[0]();                          // the 1s sampler
  h.timers[0]();                          // still inside 5s → suppressed
  await rt.flush();
  const stalls = h.posted[0].records.filter((r) => r.type === 'server-stall');
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].p99Ms, 80); assert.equal(stalls[0].maxMs, 90); assert.equal(stalls[0].p50Ms, 5);
});

test('uncaughtExceptionMonitor produces a server error record and nothing else is registered', async () => {
  const h = harness();
  const registered = [];
  h.proc.on = (k, f) => { registered.push(k); h.proc[`_${k}`] = f; };
  const rt = mk(h);
  assert.deepEqual(registered.filter((k) => k !== 'beforeExit'), ['uncaughtExceptionMonitor']);
  h.proc._uncaughtExceptionMonitor(Object.assign(new RangeError('bad'), { stack: 'RangeError: bad\n    at step (/srv/world.js:1:1)' }), 'uncaughtException');
  await rt.flush();
  const [r] = h.posted[0].records;
  assert.equal(r.type, 'error'); assert.equal(r.source, 'server'); assert.equal(r.name, 'RangeError');
  assert.deepEqual(r.stack, ['at step (/srv/world.js:1:1)']);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `src/node/profiler.js`**

```js
// The V8 sampling profiler over the inspector protocol: started once, read
// on demand. take() returns the top self-time frames since the last take and
// restarts the sampler — the same "rolling window" attach.mjs uses in the
// browser, here for the game server's own event loop.
export function foldProfile(profile, excludeUrl) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfUs = new Map();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const n = byId.get(samples[i]); if (!n) continue;
    const { functionName, url } = n.callFrame;
    if (!url && /^\((root|program|garbage collector|idle)\)$/.test(functionName)) continue;
    if (excludeUrl && url.includes(excludeUrl)) continue;
    const key = `${url} ${functionName}`;
    selfUs.set(key, (selfUs.get(key) ?? 0) + (deltas[i] ?? 0));
  }
  return [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, us]) => {
    const [url, fn] = k.split(' ');
    return { file: url.replace(/^file:\/\//, ''), fn: fn || 'anonymous', selfMs: Math.round(us / 1000) };
  });
}

export async function createProfiler(opts = {}) {
  const session = opts.session ?? new (await import('node:inspector')).Session();
  const post = (m, p) => new Promise((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  let running = false;
  return {
    async start() {
      if (running) return;
      session.connect?.();
      await post('Profiler.enable');
      await post('Profiler.setSamplingInterval', { interval: opts.intervalUs ?? 1000 });
      await post('Profiler.start');
      running = true;
    },
    async take() {
      if (!running) return [];
      const { profile } = await post('Profiler.stop');
      await post('Profiler.start');
      return foldProfile(profile, '/sloptimize/src/node/');
    },
    async stop() { if (!running) return; running = false; try { await post('Profiler.stop'); await post('Profiler.disable'); } catch { /* already gone */ } },
  };
}
```

- [ ] **Step 4: Implement `src/node/index.js`**

```js
// ============================================================
// sloptimize/node — the game server's recorder (SPEC cloud §8.3)
// ============================================================
// Three signals, one ledger: a tick the host timed that overran its budget
// (server-hitch), an event-loop stall the runtime saw on its own
// (server-stall), and an uncaught error (error, source: server). Each is
// attributed by the V8 sampler's top self-time frames, and shipped with the
// same cloud sink the browser uses. Nothing here changes how the process
// dies: only uncaughtExceptionMonitor is registered.
import { createCloudSink } from '../cloud-sink.js';
import { canonicalContext } from '../footprint.js';

export function createServerRuntime(opts = {}) {
  if (!opts.key) throw new Error('createServerRuntime: key is required');
  if (!opts.endpoint) throw new Error('createServerRuntime: endpoint is required');
  const tickBudgetMs = opts.tickBudgetMs ?? 16, stallMs = opts.stallMs ?? 50;
  const phaseFn = opts.phase ?? (() => undefined), ctxFn = opts.context ?? (() => undefined);
  const now = opts.now ?? (() => Date.now());
  const proc = opts.process ?? process;
  const setI = opts.setInterval ?? setInterval, clearI = opts.clearInterval ?? clearInterval;
  const profileOn = opts.profile !== false;

  const pending = [];
  const source = { drainRecords() { return pending.splice(0, pending.length); } };
  const sink = createCloudSink({ key: opts.key, endpoint: opts.endpoint, build: opts.build, sources: [source], flushMs: opts.flushMs ?? 5000,
    fetch: opts.fetch, sendBeacon: null, target: { addEventListener() {}, removeEventListener() {} }, setInterval: setI, clearInterval: clearI, now });

  const stats = { hitches: 0, stalls: 0, errors: 0, droppedByRate: 0 };
  let lastHitchAt = -Infinity, lastStallAt = -Infinity;

  let profiler = opts.profiler ?? null;
  let profilerReady = profileOn && profiler ? Promise.resolve(profiler.start()) : null;
  if (profileOn && !profiler) {
    profilerReady = import('./profiler.js').then(async (m) => { profiler = await m.createProfiler(); await profiler.start(); }).catch((e) => { stats.profilerError = e?.message; profiler = null; });
  }
  async function frames() {
    if (!profileOn || !profiler) return { frames: [], attribution: 'off' };
    try { await profilerReady; return { frames: await profiler.take(), attribution: 'profiler' }; } catch { return { frames: [], attribution: 'off' }; }
  }
  function stamp(rec) {
    const p = phaseFn(); if (p) rec.phase = p;
    const c = ctxFn(); if (c) rec.ctx = typeof c === 'string' ? c : canonicalContext(c);
    rec.at = new Date().toISOString();
    return rec;
  }
  function pushAsync(rec, withFrames) {
    if (!withFrames) { pending.push(rec); return; }
    frames().then((f) => { rec.frames = f.frames; rec.attribution = f.attribution; pending.push(rec); });
  }

  function endTick(startMs) {
    const tickMs = now() - startMs;
    if (tickMs <= tickBudgetMs) return;
    const t = now();
    if (t - lastHitchAt < 1000) { stats.droppedByRate++; return; }
    lastHitchAt = t; stats.hitches++;
    const rec = stamp({ type: 'server-hitch', tickMs: +tickMs.toFixed(2), budgetMs: tickBudgetMs, frames: [], attribution: 'off' });
    pushAsync(rec, profileOn);
  }

  // Event-loop delay: sampled every second, an incident when p99 crosses stallMs.
  let monitor = opts.monitor ?? null;
  if (!monitor) { try { const { monitorEventLoopDelay } = await import('node:perf_hooks'); monitor = monitorEventLoopDelay({ resolution: 20 }); } catch { monitor = null; } }
  monitor?.enable?.();
  const sampler = setI(() => {
    if (!monitor) return;
    const p99 = monitor.percentiles.get(99) / 1e6, p50 = monitor.percentiles.get(50) / 1e6, max = monitor.max / 1e6;
    monitor.reset();
    if (!(p99 > stallMs)) return;
    const t = now();
    if (t - lastStallAt < 5000) { stats.droppedByRate++; return; }
    lastStallAt = t; stats.stalls++;
    pushAsync(stamp({ type: 'server-stall', p50Ms: +p50.toFixed(1), p99Ms: +p99.toFixed(1), maxMs: +max.toFixed(1), frames: [], attribution: 'off' }), profileOn);
  }, 1000);
  sampler?.unref?.();

  const onUncaught = (err) => {
    try {
      stats.errors++;
      const e = err instanceof Error ? err : new Error(String(err));
      const stack = String(e.stack ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('at ')).slice(0, 10);
      pending.push(stamp({ type: 'error', source: 'server', name: e.name || 'Error', message: e.message, stack }));
    } catch { /* never throw from a monitor */ }
  };
  proc.on('uncaughtExceptionMonitor', onUncaught);
  const onBeforeExit = () => { Promise.race([sink.flush(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {}); };
  proc.on('beforeExit', onBeforeExit);

  return {
    tick(fn) { const s = now(); try { return fn(); } finally { endTick(s); } },
    beginTick() { return now(); },
    endTick,
    mark(label, meta = {}) { pending.push(stamp({ type: 'usermark', label, ...meta })); },
    async flush() { await new Promise((r) => setTimeout(r, 0)); await sink.flush(); },
    stats() { return { ...stats, sink: sink.stats() }; },
    async close() { clearI(sampler); monitor?.disable?.(); proc.off?.('uncaughtExceptionMonitor', onUncaught); proc.off?.('beforeExit', onBeforeExit); await profiler?.stop?.(); await sink.flush(); sink.dispose(); },
  };
}
```

`createServerRuntime` uses top-level `await import` inside a non-async function for the monitor: make the function `export async function createServerRuntime` **is wrong** for the tests, which call it synchronously. Instead: import `monitorEventLoopDelay` statically at the top of the file (`import { monitorEventLoopDelay } from 'node:perf_hooks';`) and use `opts.monitor ?? monitorEventLoopDelay({ resolution: 20 })`. The file is Node-only, so a static import is fine.

The `flush()` awaits a macrotask so that `pushAsync`'s frame promise has resolved; with a fake profiler that resolves immediately, one `setTimeout(0)` suffices. Document that in a comment.

`package.json` `exports`: `"./node": "./src/node/index.js"`.

- [ ] **Step 5: Run `npm test`; commit** — `git commit -am "sloptimize/node: server tick overruns, event-loop stalls, uncaught errors with V8 sampler attribution"`

---

### Task P5: CLI `--cloud`, `fix --push`, MCP, doctor, docs, 0.4.0

**Files:**
- Create: `src/cloud-client.js`, `test/cloud-client.test.js`
- Modify: `bin/sloptimize.mjs` (issues, fix, doctor), `mcp/server.mjs` (get_issues), `README.md`, `docs/INTEGRATION.md`, `docs/USAGE.md`, `docs/SPEC.md` (§3.7 cloud paragraph → pointer to the cloud spec), `package.json` (version 0.4.0), `.claude-plugin/plugin.json` (version)

**Interfaces:**
- Produces: `src/cloud-client.js`: `cloudConfig(env, args)` → `{ key, endpoint } | null` reading `--key`/`--endpoint` then `SLOPTIMIZE_KEY`/`SLOPTIMIZE_ENDPOINT`; `fetchIssues(cfg, { from, to, preset, source, kind }, fetchImpl)` → rows in the shape `sloptimize issues` renders (map `firstSeen`→`first`, `lastSeen`→`last`, compute `lastAgoMs`, `type`←`kind`, `fixes` becomes `[]` of length n is not needed: render count); `pushFix(cfg, fix, fetchImpl)`.
- CLI: `sloptimize issues --cloud [--preset 24h|7d|30d] [--from --to --source --kind --json]` exits 2 with a message naming the missing env when unconfigured. `sloptimize fix --push` records locally as today and then POSTs; on failure prints `push failed: <reason>` and exits 0 (the local ledger is the source of truth). `sloptimize doctor` prints `cloud: configured (<endpoint>)` or `cloud: not configured (SLOPTIMIZE_KEY, SLOPTIMIZE_ENDPOINT)`.
- MCP: `get_issues` gains `cloud: boolean`, `preset`, `source`, `kind`; when `cloud` is true and env is set, returns the cloud rows with `source: 'cloud'`; when unset, returns `{ error: 'cloud not configured: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT' }`.

- [ ] **Step 1: Failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudConfig, fetchIssues, pushFix } from '../src/cloud-client.js';

test('cloudConfig prefers flags over env and returns null when incomplete', () => {
  assert.deepEqual(cloudConfig({ SLOPTIMIZE_KEY: 'sk', SLOPTIMIZE_ENDPOINT: 'https://c/' }, []), { key: 'sk', endpoint: 'https://c' });
  assert.deepEqual(cloudConfig({ SLOPTIMIZE_KEY: 'sk', SLOPTIMIZE_ENDPOINT: 'https://c' }, ['--key', 'k2']), { key: 'k2', endpoint: 'https://c' });
  assert.equal(cloudConfig({ SLOPTIMIZE_KEY: 'sk' }, []), null);
});

test('fetchIssues maps cloud rows to the local issues shape', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => [{ id: 'abc', key: 'hitch|play|x', glyph: '⚡', label: 'hitch · x', kind: 'hitch', phase: 'play', source: 'client', ctx: '', count: 3, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-02T00:00:00.000Z', builds: ['b1'], fixes: 1, daily: [], exact: true }] }; };
  const rows = await fetchIssues({ key: 'sk', endpoint: 'https://c' }, { preset: '7d', kind: 'hitch' }, fetchImpl, () => Date.parse('2026-09-02T01:00:00Z'));
  assert.equal(calls[0].url, 'https://c/v1/issues?preset=7d&kind=hitch');
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk');
  assert.equal(rows[0].type, 'hitch'); assert.equal(rows[0].first, '2026-09-01T00:00:00.000Z'); assert.equal(rows[0].lastAgoMs, 3600e3); assert.equal(rows[0].fixCount, 1);
});

test('pushFix posts the fix and surfaces HTTP errors as a rejected promise', async () => {
  const ok = await pushFix({ key: 'sk', endpoint: 'https://c' }, { id: 'f', title: 't' }, async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) }));
  assert.deepEqual(ok, { id: 1 });
  await assert.rejects(() => pushFix({ key: 'sk', endpoint: 'https://c' }, { id: 'f' }, async () => ({ ok: false, status: 401, json: async () => ({ error: 'unknown or revoked key' }) })), /401/);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `src/cloud-client.js`**

```js
// Read side of sloptimize cloud for the CLI and MCP: the catalogue over every
// player, not just this machine's ledger. Configuration is explicit — a key
// and an endpoint — and a missing one is said, never guessed.
export function cloudConfig(env = process.env, args = []) {
  const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const key = flag('--key') ?? env.SLOPTIMIZE_KEY;
  const endpoint = (flag('--endpoint') ?? env.SLOPTIMIZE_ENDPOINT ?? '').replace(/\/+$/, '');
  return key && endpoint ? { key, endpoint } : null;
}

export async function fetchIssues(cfg, q = {}, fetchImpl = globalThis.fetch, now = Date.now) {
  const u = new URL(`${cfg.endpoint}/v1/issues`);
  for (const k of ['preset', 'from', 'to', 'source', 'kind']) if (q[k]) u.searchParams.set(k, q[k]);
  const res = await fetchImpl(u.toString(), { headers: { authorization: `Bearer ${cfg.key}` } });
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.json().catch(() => ({}))).error ?? 'request failed'}`);
  const rows = await res.json();
  const t = now();
  return rows.map((r) => ({ id: r.id, key: r.key, type: r.kind, glyph: r.glyph, label: r.label, phase: r.phase, ctx: r.ctx, source: r.source,
    count: r.count, first: r.firstSeen, last: r.lastSeen, lastAgoMs: Math.max(0, t - Date.parse(r.lastSeen)), builds: r.builds ?? [], fixCount: r.fixes ?? 0, fixes: [], daily: r.daily ?? [], exact: r.exact }));
}

export async function pushFix(cfg, fix, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${cfg.endpoint}/v1/fixes`, { method: 'POST', headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' }, body: JSON.stringify(fix) });
  if (!res.ok) throw new Error(`cloud ${res.status}: ${(await res.json().catch(() => ({}))).error ?? 'request failed'}`);
  return res.json();
}
```

- [ ] **Step 4: Wire the CLI**

In `bin/sloptimize.mjs`, at the top of the `issues` block, before reading the local ledger:

```js
  if (args.includes('--cloud')) {
    const { cloudConfig, fetchIssues } = await import('../src/cloud-client.js');
    const cfg = cloudConfig(process.env, args);
    if (!cfg) { console.error('sloptimize issues --cloud: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT (or --key/--endpoint)'); process.exit(2); }
    let rows;
    try { rows = await fetchIssues(cfg, { preset: get('--preset'), from: get('--from'), to: get('--to'), source: get('--source'), kind: get('--kind') }); }
    catch (e) { console.error(`sloptimize issues --cloud: ${e.message}`); process.exit(4); }
    if (json) { out(rows); process.exit(0); }
    if (rows.length === 0) { console.log('no incidents in this range on the cloud catalogue'); process.exit(4); }
    console.log(`cloud ${cfg.endpoint} · ${get('--preset') ?? (get('--from') ? 'custom' : '24h')} · ${rows.length} footprints`);
    for (const i of rows) console.log(`${i.glyph} fp=${i.id} ×${String(i.count).padEnd(5)} ${i.label.padEnd(44)} [${i.phase}] ${i.source}  last ${agoText(i.lastAgoMs).padEnd(8)} first ${i.first.slice(0, 16)}  builds ${i.builds.length}${i.fixCount ? `  fixes ${i.fixCount}` : ''}`);
    process.exit(0);
  }
```

(`get` and `agoText` are already defined in that block; move the `get` definition above the new branch.)

In the `fix` block after `appendFileSync(...)`:

```js
    if (args.includes('--push')) {
      const { cloudConfig, pushFix } = await import('../src/cloud-client.js');
      const cfg = cloudConfig(process.env, args);
      if (!cfg) console.error('push skipped: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT');
      else { try { await pushFix(cfg, fix); console.log('pushed to cloud'); } catch (e) { console.error(`push failed: ${e.message}`); } }
    }
```

In `doctor`, add a line: `const cfg = (await import('../src/cloud-client.js')).cloudConfig(process.env, args); console.log(cfg ? \`  cloud: configured (${cfg.endpoint})\` : '  cloud: not configured (SLOPTIMIZE_KEY, SLOPTIMIZE_ENDPOINT)');`. Also add `--cloud`, `--preset`, `--push` to the usage string.

MCP `get_issues` in `mcp/server.mjs`:

```js
  if (name === 'get_issues') {
    if (args.cloud === true) {
      const { cloudConfig, fetchIssues } = await import('../src/cloud-client.js');
      const cfg = cloudConfig(process.env, []);
      if (!cfg) return { error: 'cloud not configured: set SLOPTIMIZE_KEY and SLOPTIMIZE_ENDPOINT' };
      try {
        const rows = await fetchIssues(cfg, { preset: args.preset, from: args.from, to: args.to, source: args.source, kind: args.kind });
        return { source: 'cloud', endpoint: cfg.endpoint, footprints: rows.length, occurrences: rows.reduce((n, i) => n + i.count, 0), issues: args.fp ? rows.filter((i) => i.id === args.fp) : rows.slice(0, args.limit ?? 50) };
      } catch (e) { return { error: e.message }; }
    }
    // ...existing local path unchanged
```

Update the tool's `inputSchema` to add `cloud` (boolean), `preset`, `source`, `kind` (strings) with one-line descriptions.

- [ ] **Step 5: Docs and version**

- README: new section "## Cloud (paid, invite-only)" after the Claude Code section: what it adds (every player, every build, 24h/any range, server + client, errors), the three snippets from the settings page (browser sink + error monitor, `sloptimize/node`, CLI `--cloud`), and one paragraph on honesty (dropped counts are shown; the key is public and write-only). Keep the local product as the default story.
- INTEGRATION.md: a "Cloud sink" subsection showing the tee: `const batch = [...rec.drainRecords(), ...motion.drainRecords()]; post('records', batch); cloud.enqueue(batch)` — **this needs an `enqueue(records)` method on the sink**: add it to `createCloudSink` (`enqueue(records) { queue.push(...records); trim; }`) with a one-line test in `test/cloud-sink.test.js`. Then a "Game server" subsection with `createServerRuntime` and the tick wrapper.
- USAGE.md: `sloptimize issues --cloud`, `--preset`, `sloptimize fix --push`, env vars.
- SPEC.md §3.7: replace the "Cloud path" paragraph's last sentence with a pointer: "The service is specified in the sloptimize-cloud repo (`docs/superpowers/specs/2026-09-02-sloptimize-cloud-design.md`)."
- `package.json` and `.claude-plugin/plugin.json` version → `0.4.0`.

- [ ] **Step 6: Run `npm test`; verify a fresh consumer resolves the new subpaths**

```bash
npm test && npm pack --pack-destination /tmp >/dev/null && cd $(mktemp -d) && npm init -y >/dev/null && npm i /tmp/sloptimize-0.4.0.tgz >/dev/null && node -e "import('sloptimize/node').then(m=>console.log(Object.keys(m)))" && node -e "import('sloptimize/cloud').then(m=>console.log(Object.keys(m)))"
```

Expected: `[ 'createServerRuntime' ]` and `[ 'createCloudSink' ]`.

- [ ] **Step 7: Commit** — `git commit -am "0.4.0: issues --cloud, fix --push, MCP cloud read, doctor line, docs"`

---

## Self-review

- **Spec §5** → P1 (three kinds, normalization, site rule, glyphs). **§8.1** → P2. **§8.2** → P3 (+ `enqueue` for the tee, added in P5's docs step with its test). **§8.3** → P4 (tick, stall, monitor-only error hook, profiler with `profile:false`, beforeExit flush). **§8.4** → P5. **§8.5** → P3/P4/P5 exports and docs. **§11 package tests** → each task's test file.
- **Types.** `Frame = { file, fn, selfMs }` is the same in `profiler.js`, the runtime records, and `serverSite()` in `footprint.js`. `stats().droppedByRate` is the name used in both the runtime and its test. Cloud rows use `firstSeen/lastSeen/fixes:number` on the wire and `first/last/fixCount` after `fetchIssues` maps them.
- **Ordering.** P1 must ship (as 0.4.0) before the service's Task 3 tests can pass, because the service imports `footprintOf` for `error` records.
