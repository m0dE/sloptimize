# Electron support — design (2026-09-09)

Ticket 8f060cdc. Follows the evaluation in `docs/ELECTRON.md`: every
browser-side piece already runs in an Electron renderer; what is missing is
a host-side sink that does not need a dev server, the Electron-only signal
the evaluation ranked, and one false positive in the injected recorder.

## Goals

- A game in an Electron app gets the tier-1 loop (runtime → ledger → CLI,
  hook, MCP, panel) with no HTTP server: `sloptimize/electron` in main,
  `sloptimize/electron/preload` in the preload script.
- Tier-0 attach inside the app, over `webContents.debugger`, no debug port,
  reusing the injected recorder and the incident pipeline unchanged.
- Electron-only measurements that turn two stated limits into numbers:
  per-process CPU/memory via `app.getAppMetrics()`, GPU-side traces via
  `contentTracing`.
- Honest regime: an Electron window is `hardware` unless the GPU is
  disabled; the ledger says which.

## Non-goals

- No dependency on the `electron` package: every Electron object is passed
  in by the host. Tests use fakes; nothing here has been run under a real
  Electron in this repo (stated in the docs).
- No Electron build plugin, no packaged-app auto-update of the ledger dir
  beyond the `app.isPackaged` default.

## Components

### `src/incident-pipeline.mjs` (refactor, behaviour-preserving)

`createIncidentPipeline({ dir, log, send, regime, onNewCluster })` — the
record half of `attach.mjs`: profiler rotation over `send`, clustering
(M-A1 merge rule), `.sloptimize/` writes. Returns `{ onRecord, clusters,
start(), stop() }`. `attach.mjs` keeps only target discovery, the
WebSocket, the binding and injection, and calls the pipeline with its own
`send`. `regime` replaces the inline `opts.headless ? 'software' :
'unknown'`.

### `src/electron/main.js` → export `sloptimize/electron`

- `createElectronSink({ ipcMain, app, dir, metrics, channel })`
  - `dir` default: `<cwd>/.sloptimize` in dev, `<userData>/.sloptimize`
    when `app.isPackaged`.
  - `ipcMain.handle('sloptimize:ingest', (_e, {kind, payload}))` — same
    contract as the dev endpoint: `profile` → profile.json, `census` →
    census.json, `records` → append perf.jsonl. Unknown kind → `{ok:false}`.
  - `ipcMain.handle('sloptimize:ledger')` → `{ records, fixes }` parsed from
    the last ~2 MB of perf.jsonl and all of fixes.jsonl (the panel's
    documented `history()` shape).
  - `metrics: true` (default when `app.getAppMetrics` exists): sample once
    a second; keep the latest per-type CPU %; every 60 s append
    `{type:'electron-metrics', cpu:{gpu, renderer, browser}, memKB:{…}}`;
    stamp `rec.processes = {gpu:{cpu}, renderer:{cpu}}` on each ingested
    `hitch`. Timer unref'd; `close()` clears it and removes handlers.
- `attachInApp({ webContents, app, contentTracing, dir, log, trace })`
  - `webContents.debugger.attach('1.3')`; same CDP sequence as attach.mjs
    via `debugger.sendCommand`; `Runtime.bindingCalled` arrives on the
    debugger `'message'` event; reload after injection.
  - regime: `app.getGPUFeatureStatus().gpu_compositing === 'enabled'` →
    `hardware`, else `software`; `unknown` when unavailable.
  - `trace: true` (needs `contentTracing`): `startRecording({
    included_categories: ['gpu','viz','cc','toplevel'], record_mode:
    'record-continuously' })`; on a NEW cluster, `stopRecording(<dir>/trace-<ts>.json)`
    then restart; the hitch record gets `trace: '<file>'`. Serialised so two
    incidents in flight cannot double-stop.
  - Returns `{ close(), clusters }`.

### `src/electron/preload.js` → export `sloptimize/electron/preload`

`exposeSloptimizeBridge({ contextBridge, ipcRenderer, name = 'sloptimizeSink' })`
exposes `{ post(kind, payload), history() }` in the main world. Pure
delegation; the game's drain calls `window.sloptimizeSink.post`.

### `src/inject-body.js` — visibility guard

On `visibilitychange` to visible, `lastRaf = -1` so the next tick re-seeds
the clock instead of reporting the hidden span as a hitch. Same fix serves
a background browser tab.

### CLI / docs

- `doctor`: no change to regimes (`hardware` already understood); print an
  Electron line when `electron-metrics` records exist.
- `docs/ELECTRON.md` rewritten around the shipped API; README docs list and
  `skills/install/SKILL.md` §2 point at it for Electron hosts.
- package.json `exports` gains `./electron` and `./electron/preload`.

## Testing

node:test, bare Node, fakes only:
- pipeline: regime stamping, cluster merge, NEW-cluster callback, profiler
  rotation via a recorded `send`.
- sink: ingest kinds → files; ledger shape; metrics stamping and the
  per-minute record; packaged dir default; close() removes handlers.
- attachInApp: fake debugger records the CDP sequence; a binding message
  flows to the pipeline; trace start/stop/restart on a new cluster only.
- preload: fake contextBridge captures the exposed API; `post`/`history`
  invoke the right channels.
- inject script under `node:vm` with stubbed rAF/PerformanceObserver/
  document: a 5 s hidden gap emits no hitch after the guard.
