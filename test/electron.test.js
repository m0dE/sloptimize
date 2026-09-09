// sloptimize/electron on bare Node: fakes for ipcMain/app/webContents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElectronSink, attachInApp, defaultDir, readLedger, regimeOf, foldMetrics } from '../src/electron/main.js';
import { exposeSloptimizeBridge } from '../src/electron/preload.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'slop-electron-'));

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    invoke: (ch, msg) => handlers.get(ch)({}, msg),
  };
}
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setInterval: (fn, ms) => { const t = { fn, ms, cleared: false, unref() { t.unrefd = true; } }; timers.push(t); return t; },
    clearInterval: (t) => { t.cleared = true; },
    tick: () => { for (const t of timers) if (!t.cleared) t.fn(); },
  };
}

test('defaultDir: cwd while developing, userData once packaged', () => {
  assert.equal(defaultDir({ isPackaged: false }, '/game'), join('/game', '.sloptimize'));
  assert.equal(defaultDir({ isPackaged: true, getPath: (k) => `/home/u/.config/${k}` }, '/game'), '/home/u/.config/userData/.sloptimize');
  assert.equal(defaultDir(undefined, '/game'), join('/game', '.sloptimize'));
});

test('regimeOf: GPU compositing enabled = hardware; disabled or --disable-gpu = software; else unknown', () => {
  assert.equal(regimeOf({ getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }) }), 'hardware');
  assert.equal(regimeOf({ getGPUFeatureStatus: () => ({ gpu_compositing: 'disabled_software' }) }), 'software');
  assert.equal(regimeOf({ commandLine: { hasSwitch: (s) => s === 'disable-gpu' }, getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }) }), 'software');
  assert.equal(regimeOf({}), 'unknown');
  assert.equal(regimeOf({ getGPUFeatureStatus: () => { throw new Error('too early'); } }), 'unknown');
});

test('foldMetrics sums per process kind', () => {
  const m = foldMetrics([
    { type: 'Browser', cpu: { percentCPUUsage: 3.25 }, memory: { workingSetSize: 1000 } },
    { type: 'GPU', cpu: { percentCPUUsage: 80 }, memory: { workingSetSize: 5000 } },
    { type: 'Tab', cpu: { percentCPUUsage: 20 }, memory: { workingSetSize: 2000 } },
    { type: 'Tab', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 500 } },
    { type: 'Utility', cpu: {}, memory: {} },
  ]);
  assert.deepEqual(m.cpu, { browser: 3.3, gpu: 80, renderer: 25, other: 0 });
  assert.deepEqual(m.memKB, { browser: 1000, gpu: 5000, renderer: 2500, other: 0 });
});

test('sink: ingest kinds land in the same files the dev endpoint wrote; unknown kind is refused', async () => {
  const dir = tmp(); const ipc = fakeIpc();
  const sink = createElectronSink({ ipcMain: ipc, dir, metrics: false });
  assert.deepEqual(await ipc.invoke('sloptimize:ingest', { kind: 'profile', payload: { frame: { p95Ms: 20 } } }), { ok: true });
  assert.deepEqual(await ipc.invoke('sloptimize:ingest', { kind: 'census', payload: { totals: { meshes: 1 } } }), { ok: true });
  assert.deepEqual(await ipc.invoke('sloptimize:ingest', { kind: 'records', payload: [{ type: 'hitch', frameMs: 90 }, { type: 'usermark', label: 'x' }] }), { ok: true, count: 2 });
  assert.equal((await ipc.invoke('sloptimize:ingest', { kind: 'bogus', payload: 1 })).ok, false);
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).frame.p95Ms, 20);
  assert.equal(JSON.parse(readFileSync(join(dir, 'census.json'), 'utf8')).totals.meshes, 1);
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(sink.stats().ingested, 4);
  assert.equal(sink.stats().rejected, 1);
});

test('sink: ledger read-back is the panel history shape', async () => {
  const dir = tmp(); const ipc = fakeIpc();
  createElectronSink({ ipcMain: ipc, dir, metrics: false });
  await ipc.invoke('sloptimize:ingest', { kind: 'records', payload: [{ type: 'hitch', at: 'a' }] });
  writeFileSync(join(dir, 'fixes.jsonl'), JSON.stringify({ id: 'f1', title: 'less draws' }) + '\n');
  const l = await ipc.invoke('sloptimize:ledger');
  assert.deepEqual(l, { records: [{ type: 'hitch', at: 'a' }], fixes: [{ id: 'f1', title: 'less draws' }] });
});

test('readLedger tails the last N bytes and drops the partial first line', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'perf.jsonl'), ['{"n":1}', '{"n":2}', '{"n":3}'].join('\n') + '\n');
  const { records } = readLedger(dir, { maxBytes: 12 });   // cuts into the second line
  assert.deepEqual(records, [{ n: 3 }]);
  assert.deepEqual(readLedger(tmp()), { records: [], fixes: [] });
});

test('sink: metrics sample every second, write one line per N samples, and stamp hitches with process CPU', async () => {
  const dir = tmp(); const ipc = fakeIpc(); const t = fakeTimers();
  const app = { getAppMetrics: () => [{ type: 'GPU', cpu: { percentCPUUsage: 70 } }, { type: 'Tab', cpu: { percentCPUUsage: 10 } }] };
  const sink = createElectronSink({ ipcMain: ipc, app, dir, metricsEveryN: 2, ...t });
  assert.equal(t.timers.length, 1);
  assert.equal(t.timers[0].ms, 1000);
  assert.ok(t.timers[0].unrefd, 'timer must not keep the app alive');
  t.tick();
  await ipc.invoke('sloptimize:ingest', { kind: 'records', payload: [{ type: 'hitch', frameMs: 90 }, { type: 'profile' }] });
  t.tick();
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0].processes, { gpu: { cpu: 70 }, renderer: { cpu: 10 } });
  assert.equal(lines[1].processes, undefined);
  assert.equal(lines[2].type, 'electron-metrics');
  assert.equal(lines[2].cpu.gpu, 70);
  assert.equal(sink.stats().metricsSamples, 2);
  sink.close();
  assert.ok(t.timers[0].cleared);
  assert.equal(ipc.handlers.size, 0);
});

test('sink: a throwing getAppMetrics is counted, never thrown; no app = no metrics', () => {
  const dir = tmp(); const ipc = fakeIpc(); const t = fakeTimers();
  const sink = createElectronSink({ ipcMain: ipc, app: { getAppMetrics: () => { throw new Error('nope'); } }, dir, ...t });
  t.tick();
  assert.equal(sink.stats().metricsErrors, 1);
  const t2 = fakeTimers();
  createElectronSink({ ipcMain: fakeIpc(), dir, ...t2 });
  assert.equal(t2.timers.length, 0);
});

test('preload: exposes post/history on the bridge, routed to the sink channels', async () => {
  const exposed = {};
  const calls = [];
  const api = exposeSloptimizeBridge({
    contextBridge: { exposeInMainWorld: (n, a) => { exposed[n] = a; } },
    ipcRenderer: { invoke: async (ch, msg) => { calls.push([ch, msg]); return { ok: true }; } },
  });
  assert.equal(exposed.sloptimizeSink, api);
  await api.post('records', [1]);
  await api.history();
  assert.deepEqual(calls, [['sloptimize:ingest', { kind: 'records', payload: [1] }], ['sloptimize:ledger', undefined]]);
  // no contextBridge (contextIsolation off): assigned onto the target
  const target = {};
  exposeSloptimizeBridge({ ipcRenderer: { invoke: async () => {} }, target, name: 'perf' });
  assert.equal(typeof target.perf.post, 'function');
  assert.throws(() => exposeSloptimizeBridge({}), /ipcRenderer/);
});

// ── attachInApp over a fake webContents.debugger ──
function fakeWebContents({ gpuStatus = { gpu_compositing: 'enabled' } } = {}) {
  const listeners = {};
  const commands = [];
  let attached = false;
  const dbg = {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    on: (ev, fn) => { (listeners[ev] ??= []).push(fn); },
    off: (ev, fn) => { listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn); },
    sendCommand: async (method, params) => {
      commands.push(method);
      if (method === 'Profiler.stop') return { profile: { nodes: [{ id: 1, callFrame: { functionName: 'simStep', url: 'app://game.js', lineNumber: 4 } }], samples: [1], timeDeltas: [3000] } };
      return {};
    },
    emit: (ev, ...a) => { for (const f of listeners[ev] ?? []) f(...a); },
  };
  const app = { getGPUFeatureStatus: () => gpuStatus };
  return { webContents: { debugger: dbg }, app, commands, dbg, listeners };
}
function fakeTracing() {
  const events = [];
  return {
    events,
    startRecording: async (cfg) => { events.push(['start', cfg.record_mode]); },
    stopRecording: async (path) => { events.push(['stop', path]); return path; },
  };
}
const binding = (rec) => ['Runtime.bindingCalled', { name: '__sloptimizeEmit', payload: JSON.stringify(rec) }];

test('attachInApp: the CDP sequence over webContents.debugger, regime from the GPU status, records flow to the ledger', async () => {
  const dir = tmp(); const f = fakeWebContents();
  const logs = [];
  const s = await attachInApp({ ...f, dir, log: (l) => logs.push(l) });
  assert.equal(s.regime, 'hardware');
  assert.deepEqual(f.commands, ['Runtime.enable', 'Page.enable', 'Runtime.addBinding', 'Page.addScriptToEvaluateOnNewDocument',
    'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Page.reload']);
  f.dbg.emit('message', {}, ...binding({ type: 'armed', url: 'app://index.html' }));
  f.dbg.emit('message', {}, ...binding({ type: 'profile', frame: { medianMs: 16.6 } }));
  f.dbg.emit('message', {}, ...binding({ type: 'hitch', at: '2026-09-09T10:00:00Z', frameMs: 210, classification: [{ guess: 'long-script' }] }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).regime, 'hardware');
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const hitch = lines.find((l) => l.type === 'hitch');
  assert.equal(hitch.cluster.key, 'long-script|simStep@game.js:5');
  assert.equal(s.clusters.size, 1);
  assert.ok(logs.some((l) => l.startsWith('INCIDENT')));
  await s.close();
  assert.ok(!f.dbg.isAttached());
  assert.equal(f.listeners.message.length, 0);
});

test('attachInApp: trace ring runs from attach; a NEW cause cuts it to a file the record names; repeats do not', async () => {
  const dir = tmp(); const f = fakeWebContents(); const tracing = fakeTracing();
  const s = await attachInApp({ ...f, contentTracing: tracing, trace: true, dir, log: () => {} });
  assert.deepEqual(tracing.events, [['start', 'record-continuously']]);
  const h = (at) => binding({ type: 'hitch', at, frameMs: 210, classification: [{ guess: 'long-script' }] });
  f.dbg.emit('message', {}, ...h('2026-09-09T10:00:00.000Z'));
  f.dbg.emit('message', {}, ...h('2026-09-09T10:00:03.000Z'));
  await new Promise((r) => setTimeout(r, 10));
  const lines = readFileSync(join(dir, 'perf.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].trace, join(dir, 'trace-2026-09-09T10-00-00-000Z.json'));
  assert.equal(lines[1].trace, undefined);
  assert.deepEqual(tracing.events.map((e) => e[0]), ['start', 'stop', 'start']);
  await s.close();
  assert.equal(tracing.events.at(-1)[0], 'stop');
});

test('attachInApp: trace without contentTracing degrades to no traces, said once', async () => {
  const f = fakeWebContents({ gpuStatus: null }); const logs = [];
  const s = await attachInApp({ ...f, trace: true, dir: tmp(), log: (l) => logs.push(l) });
  assert.equal(s.regime, 'unknown');
  assert.ok(logs.some((l) => l.includes('contentTracing not provided')));
  await s.close();
});

test('attachInApp: after the page detached, close() does not talk to the debugger', async () => {
  const f = fakeWebContents();
  const s = await attachInApp({ ...f, dir: tmp(), log: () => {} });
  const before = f.commands.length;
  f.dbg.emit('detach', {}, 'target closed');
  await s.close();
  assert.equal(f.commands.length, before);
  assert.rejects(attachInApp({ webContents: {} }), /webContents\.debugger/);
});
