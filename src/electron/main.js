// ============================================================
// sloptimize/electron — the main-process side of an Electron game
// ============================================================
// Two things a browser cannot give the renderer, both hosted here:
//   1. createElectronSink — the ledger sink over IPC. A packaged app has no
//      dev server to POST to, so the main process IS the ingest endpoint:
//      same {kind, payload} contract, same .sloptimize/ files, plus the
//      per-process CPU/memory Electron exposes through app.getAppMetrics()
//      (the GPU process is a number here, not a queue-latency guess).
//   2. attachInApp — tier-0 attach over webContents.debugger: the injected
//      recorder and the rolling profiler with no --remote-debugging-port,
//      and (opt-in) a Chrome trace of the GPU/compositor side around every
//      NEW incident via contentTracing.
// No import of 'electron' anywhere: the host passes ipcMain/app/webContents
// in, so this file runs (and is tested) on bare Node with fakes.
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { buildInjectScript } from '../attach.mjs';
import { createIncidentPipeline } from '../incident-pipeline.mjs';

const LEDGER_TAIL_BYTES = 2 * 1024 * 1024;

/** `<cwd>/.sloptimize` while developing; `<userData>/.sloptimize` once packaged. */
export function defaultDir(app, cwd = process.cwd()) {
  if (app?.isPackaged && typeof app.getPath === 'function') return join(app.getPath('userData'), '.sloptimize');
  return join(cwd, '.sloptimize');
}

/** Last ~2 MB of perf.jsonl (first partial line dropped) + all of fixes.jsonl, parsed. */
export function readLedger(dir, { maxBytes = LEDGER_TAIL_BYTES } = {}) {
  const parse = (txt) => txt.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  let perf = '';
  const perfPath = join(dir, 'perf.jsonl');
  if (existsSync(perfPath)) {
    const fd = openSync(perfPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      perf = buf.toString('utf8');
      if (start > 0) perf = perf.slice(perf.indexOf('\n') + 1);
    } finally { closeSync(fd); }
  }
  const fixesPath = join(dir, 'fixes.jsonl');
  const fixes = existsSync(fixesPath) ? parse(readFileSync(fixesPath, 'utf8')) : [];
  return { records: parse(perf), fixes };
}

/** 'hardware' | 'software' | 'unknown' from what the app knows about its GPU. */
export function regimeOf(app) {
  try {
    if (app?.commandLine?.hasSwitch?.('disable-gpu')) return 'software';
    const st = app?.getGPUFeatureStatus?.();
    if (!st || typeof st !== 'object') return 'unknown';
    const comp = st.gpu_compositing ?? st.webgl ?? st.webgl2;
    if (!comp) return 'unknown';
    return String(comp).startsWith('enabled') ? 'hardware' : 'software';
  } catch { return 'unknown'; }
}

/** Fold app.getAppMetrics() into one line: CPU % and working set (KB) per process kind. */
export function foldMetrics(list) {
  const cpu = { browser: 0, gpu: 0, renderer: 0, other: 0 };
  const memKB = { browser: 0, gpu: 0, renderer: 0, other: 0 };
  for (const p of list ?? []) {
    const k = p.type === 'Browser' ? 'browser' : p.type === 'GPU' ? 'gpu' : p.type === 'Tab' ? 'renderer' : 'other';
    cpu[k] += p.cpu?.percentCPUUsage ?? 0;
    memKB[k] += p.memory?.workingSetSize ?? 0;
  }
  for (const k of Object.keys(cpu)) { cpu[k] = +cpu[k].toFixed(1); memKB[k] = Math.round(memKB[k]); }
  return { cpu, memKB };
}

/**
 * The IPC sink. In the renderer (through sloptimize/electron/preload):
 *   window.sloptimizeSink.post('records', batch)  → perf.jsonl
 *   window.sloptimizeSink.post('profile', p)      → profile.json
 *   window.sloptimizeSink.post('census', c)       → census.json
 *   window.sloptimizeSink.history()               → { records, fixes }
 */
export function createElectronSink(opts = {}) {
  const { ipcMain, app } = opts;
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new Error('createElectronSink: ipcMain is required');
  const dir = opts.dir ?? defaultDir(app);
  const channel = opts.channel ?? 'sloptimize';
  const setI = opts.setInterval ?? setInterval, clearI = opts.clearInterval ?? clearInterval;
  const metricsOn = opts.metrics ?? typeof app?.getAppMetrics === 'function';
  const everyN = opts.metricsEveryN ?? 60;
  mkdirSync(dir, { recursive: true });

  const stats = { ingested: 0, rejected: 0, metricsSamples: 0, metricsErrors: 0 };
  let latest = null;   // last folded metrics sample
  let sinceWrite = 0;

  function sampleMetrics() {
    try {
      latest = foldMetrics(app.getAppMetrics());
      stats.metricsSamples++;
      if (++sinceWrite >= everyN) {
        sinceWrite = 0;
        appendFileSync(join(dir, 'perf.jsonl'), JSON.stringify({ type: 'electron-metrics', at: new Date().toISOString(), ...latest }) + '\n');
      }
    } catch { stats.metricsErrors++; }
  }

  function ingest(kind, payload) {
    if (kind === 'profile') { writeFileSync(join(dir, 'profile.json'), JSON.stringify(payload, null, 2)); stats.ingested++; return { ok: true }; }
    if (kind === 'census') { writeFileSync(join(dir, 'census.json'), JSON.stringify(payload, null, 2)); stats.ingested++; return { ok: true }; }
    if (kind === 'records') {
      const list = Array.isArray(payload) ? payload : [];
      let out = '';
      for (const r of list) {
        if (!r || typeof r !== 'object') continue;
        // The Electron-only enrichment: which process was busy when the
        // frame stalled. Latest 1 Hz sample — coarse, but a pegged GPU
        // process reads as a number instead of a guess.
        if (r.type === 'hitch' && latest) r.processes = { gpu: { cpu: latest.cpu.gpu }, renderer: { cpu: latest.cpu.renderer } };
        out += JSON.stringify(r) + '\n';
      }
      if (out) appendFileSync(join(dir, 'perf.jsonl'), out);
      stats.ingested += list.length;
      return { ok: true, count: list.length };
    }
    stats.rejected++;
    return { ok: false, error: `unknown kind ${String(kind)}` };
  }

  const onIngest = (_e, msg) => { try { return ingest(msg?.kind, msg?.payload); } catch (e) { stats.rejected++; return { ok: false, error: String(e?.message ?? e) }; } };
  const onLedger = () => { try { return readLedger(dir); } catch { return { records: [], fixes: [] }; } };
  ipcMain.handle(`${channel}:ingest`, onIngest);
  ipcMain.handle(`${channel}:ledger`, onLedger);

  const timer = metricsOn ? setI(sampleMetrics, 1000) : null;
  timer?.unref?.();

  return {
    dir, ingest,
    ledger: () => onLedger(),
    metrics: () => latest,
    stats: () => ({ ...stats }),
    close() {
      if (timer) clearI(timer);
      ipcMain.removeHandler?.(`${channel}:ingest`);
      ipcMain.removeHandler?.(`${channel}:ledger`);
    },
  };
}

/** contentTracing in ring-buffer mode; a NEW incident cuts the ring to a file. */
function createTracer(contentTracing, dir, log) {
  const config = { included_categories: ['gpu', 'viz', 'cc', 'toplevel'], record_mode: 'record-continuously' };
  let chain = Promise.resolve();
  let running = false;
  const run = (fn) => { chain = chain.then(fn, fn); return chain; };
  return {
    start: () => run(async () => { await contentTracing.startRecording(config); running = true; }),
    async cut(rec) {
      return run(async () => {
        if (!running) return null;
        const file = join(dir, `trace-${String(rec.at ?? Date.now()).replace(/[:.]/g, '-')}.json`);
        running = false;
        const path = await contentTracing.stopRecording(file);
        await contentTracing.startRecording(config);
        running = true;
        log(`trace ${path ?? file}`);
        return path ?? file;
      });
    },
    stop: () => run(async () => { if (!running) return; running = false; try { await contentTracing.stopRecording(join(dir, 'trace-last.json')); } catch { /* fine */ } }),
  };
}

/**
 * Tier-0 attach from inside the app.
 * @param {object} opts
 * @param {object} opts.webContents   the game window's webContents
 * @param {object} [opts.app]         for the regime (getGPUFeatureStatus)
 * @param {object} [opts.contentTracing]  with `trace: true`: GPU-side traces per new incident
 * @param {string} [opts.dir]
 * @param {boolean} [opts.trace]
 * @param {(...a:any[])=>void} [opts.log]
 */
export async function attachInApp(opts = {}) {
  const { webContents, app, contentTracing } = opts;
  const dbg = webContents?.debugger;
  if (!dbg || typeof dbg.attach !== 'function') throw new Error('attachInApp: webContents.debugger is required');
  const dir = opts.dir ?? defaultDir(app);
  const log = opts.log ?? ((...a) => console.log('[attach]', ...a));
  const regime = regimeOf(app);
  const tracer = opts.trace && contentTracing ? createTracer(contentTracing, dir, log) : null;
  if (opts.trace && !contentTracing) log('trace requested but contentTracing not provided — skipping GPU traces');

  const send = (method, params = {}) => dbg.sendCommand(method, params);
  const pipeline = createIncidentPipeline({
    dir, log, send, regime,
    onNewCluster: tracer ? async (rec) => { const f = await tracer.cut(rec); if (f) rec.trace = f; } : undefined,
  });

  let detached = false;
  const onMessage = (_event, method, params) => {
    if (method === 'Runtime.bindingCalled' && params?.name === '__sloptimizeEmit') {
      try { void pipeline.onRecord(JSON.parse(params.payload)); } catch { /* one bad record */ }
    }
  };
  const onDetach = () => { detached = true; };
  dbg.attach('1.3');
  dbg.on('message', onMessage);
  dbg.on('detach', onDetach);

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Runtime.addBinding', { name: '__sloptimizeEmit' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectScript() });
  await pipeline.start();
  if (tracer) await tracer.start();
  // Injection applies to navigations: reload once so the page we attached
  // to runs the recorder from its first script.
  await send('Page.reload', { ignoreCache: false });
  log(`attached in-app (${regime}) — recorder injected; profiler rolling${tracer ? '; GPU tracing' : ''}`);

  return {
    clusters: pipeline.clusters,
    regime,
    async close() {
      if (tracer) await tracer.stop();
      if (!detached) { await pipeline.stop(); }
      const off = dbg.off ?? dbg.removeListener;
      if (off) { off.call(dbg, 'message', onMessage); off.call(dbg, 'detach', onDetach); }
      try { if (!detached) dbg.detach(); } catch { /* already gone */ }
    },
  };
}
