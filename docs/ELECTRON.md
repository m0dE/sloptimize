# sloptimize in an Electron app

Evaluation (ticket 8f060cdc, 2026-09): what works today unchanged, what an
Electron host has to wire differently, and which Electron-only signals are
worth adding. Short version: **an Electron renderer is a Chromium page, so
every browser-side piece of sloptimize works as-is, and the attach tier
already reaches it over `--remote-debugging-port`.** The only real change is
the sink: a packaged app has no dev server to POST to, so the ledger goes
through IPC to the main process instead. Everything below that is optional
extra signal Electron exposes and a browser does not.

## 1. What works today, verified against the source

| Piece | Electron renderer | Notes |
|---|---|---|
| `createRecorder` / `buildCensus` / `createMotionMonitor` | unchanged | pure JS; only `performance.now()` |
| `createErrorMonitor` | unchanged | `error` / `unhandledrejection` on `globalThis` |
| `createPanel` (Ctrl+F12 debugger) | unchanged | `document`, `localStorage`, `window.confirm` all present; Electron binds nothing to F12 by default |
| `createCloudSink` | unchanged | `fetch` keepalive + `navigator.sendBeacon`; `pagehide`/`visibilitychange` fire on window close / minimize |
| `sloptimize attach --port N` (tier 0) | works | see §2; CDP injection bypasses the page CSP and lands in the main world where the game runs |
| `sloptimize attach --launch <url>` | only with the bare `electron` binary | see §2 |
| `sloptimize/node` (`createServerRuntime`) | main process, expected to work | `node:perf_hooks` and `uncaughtExceptionMonitor` are available in main; the V8 sampler needs `node:inspector`, which Electron supports in main only. Not exercised in this repo's tests. |
| CLI (`report`, `issues`, `check`, `doctor`, `watch`, MCP) | unchanged | files-first; reads `.sloptimize/` wherever the app writes it |

`performance.memory` is Chromium-only and therefore always present in an
Electron renderer, so a host that samples it at 1Hz (SPEC §3) gets
`memorySampled: true` and the GC classification at `medium` confidence
instead of the `low` a Firefox/Safari page is downgraded to.

## 2. Attach (tier 0, zero integration)

Start the app with Chromium's debugging port and attach to it. `--launch` is
not the path here: it spawns `$SLOPTIMIZE_BROWSER` with a URL argument, and a
packaged Electron app does not take a URL as its app path.

```bash
# your app, dev mode
electron . --remote-debugging-port=9222
# or packaged
./dist/MyGame --remote-debugging-port=9222      # packaged apps honour Chromium switches too
# then, in the game repo
npx sloptimize attach --port 9222
```

What attach does on connect (unchanged): finds the first `type: "page"`
target that is not a `devtools://` URL, registers the emit binding, injects
the recorder via `Page.addScriptToEvaluateOnNewDocument`, starts the rolling
profiler, and **reloads the page** so the injection applies. A BrowserWindow
reload re-runs your renderer entry; any state you hold only in the main
process survives, renderer-only state does not. Multi-window apps: attach
takes the first page target, so open the game window first or use one
window while profiling.

If you only want the game under Electron's Chromium (real GPU, no app code),
the default app opens a URL directly, so `--launch` does work with the bare
binary:

```bash
SLOPTIMIZE_BROWSER=$(node -p "require('electron')") npx sloptimize attach --launch http://localhost:3000
```

Regime: attach stamps `profile.json` with `regime: 'software'` only under
`--headless`, otherwise `'unknown'`. An Electron window renders on the real
GPU (unless the app passes `--disable-gpu`), so its timings are comparable
across runs of the same machine and never hit the `check --counters-only`
downgrade.

## 3. Integration (tier 1): the one thing to wire differently

INTEGRATION.md §2 assumes a dev server with `POST /api/sloptimize/ingest`
and `GET /api/sloptimize/ledger`. An Electron app owns a Node process
already, so skip the HTTP hop and write the ledger from main:

```js
// preload.js (contextIsolation on)
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('sloptimizeSink', {
  post: (kind, payload) => ipcRenderer.invoke('sloptimize:ingest', { kind, payload }),
  history: () => ipcRenderer.invoke('sloptimize:ledger'),
});

// main.js — same shapes the dev-server endpoint accepts
import { ipcMain, app } from 'electron';
import { appendFileSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const DIR = process.env.SLOPTIMIZE_DIR ?? join(app.isPackaged ? app.getPath('userData') : process.cwd(), '.sloptimize');
mkdirSync(DIR, { recursive: true });
ipcMain.handle('sloptimize:ingest', (_e, { kind, payload }) => {
  if (kind === 'profile') writeFileSync(join(DIR, 'profile.json'), JSON.stringify(payload, null, 2));
  else if (kind === 'census') writeFileSync(join(DIR, 'census.json'), JSON.stringify(payload, null, 2));
  else if (kind === 'records') for (const r of payload) appendFileSync(join(DIR, 'perf.jsonl'), JSON.stringify(r) + '\n');
});
ipcMain.handle('sloptimize:ledger', () => ({
  perf: readFileSync(join(DIR, 'perf.jsonl'), 'utf8').trim().split('\n').slice(-2000).map((l) => JSON.parse(l)),
  fixes: [],   // or read fixes.jsonl the same way
}));
```

In the renderer the game's existing `post('records', batch)` becomes
`window.sloptimizeSink.post(...)`, and `createPanel({ history: window.sloptimizeSink.history })`
gets its Timeline tab. Everything downstream (`sloptimize report --dir …`,
`watch`, hooks, MCP) is unchanged because the files are the contract.

Two Electron-specific traps for the frame feed:

- **Background throttling.** A hidden/minimized BrowserWindow stops rAF, so
  the next rendered frame's rAF delta is the whole hidden span. Feed
  `paused: true` while `document.visibilityState === 'hidden'` (or set
  `backgroundThrottling: false` on the window if the game must tick hidden).
  The tier-0 injected recorder has no such guard, so a minimize under
  `attach` shows up as one giant hitch; treat it as such.
- **Build id.** `createCloudSink({ build })` and `fix` measurement key on a
  build string. Use `app.getVersion()` plus the git sha you bake at package
  time rather than a dev-server-injected global.

## 4. Electron-only signal worth adding (not built; optional)

These are the "more optimizations Electron allows". Ranked by value against
the limits `doctor` prints today.

1. **GPU-process timing via `contentTracing`.** The stated limit "no
   per-draw GPU timing" is about the browser hiding the GPU process. Electron's
   `contentTracing.startRecording({ included_categories: ['gpu', 'viz', 'cc'] })`
   captures a Chrome trace of raster/compositor/GPU work that DevTools cannot
   see from the page. A ~60-line main-process helper could arm a trace on a
   `usermark`, stop it on the next hitch, and drop `trace.json` beside
   `profile.json` for an agent to read. Highest value, most new code.
2. **Per-process CPU/memory via `app.getAppMetrics()`.** One call returns
   CPU % and memory for every process, including the GPU process. Sampling it
   at 1Hz alongside the recorder's `profile` line answers "is the GPU process
   pegged?" with a number instead of the queue-latency proxy attach uses.
   ~20 lines in the main sink above.
3. **In-app attach without a debug port.** `webContents.debugger.attach('1.3')`
   from main gives the same CDP surface `attach.mjs` uses (`Runtime.addBinding`,
   `Page.addScriptToEvaluateOnNewDocument`, `Profiler.*`). Exporting
   `buildInjectScript()` under a `sloptimize/electron` entry would let an app
   ship the tier-0 recorder and rolling profiler to testers with no external
   process. Medium effort: the record-handling half of `attach.mjs` would
   need splitting from its WebSocket transport.
4. **Real-GPU CI.** Electron runs headed under Xvfb with a real GPU on Linux
   agents that have one, so `sloptimize check` can compare `frame_ms_p95`
   instead of falling to `--counters-only` as the SwiftShader headless path
   must. No code change; a regime stamp of `'hardware'` on attach when
   `SystemInfo.getInfo` reports a non-software GL renderer would make the
   ledger say so.
5. **Cross-origin isolation for free.** Setting COOP/COEP headers on the
   app's protocol enables `performance.measureUserAgentSpecificMemory()` and
   `SharedArrayBuffer`; the former gives a real heap number to the GC
   classifier instead of the deprecated `performance.memory`.

## 5. Verdict

Supported now, no package changes required. Wire the IPC sink (§3) instead
of the dev-server endpoint, feed `paused` on visibility, and attach with
`--port` rather than `--launch`. Items in §4 are new capability, not gaps:
schedule (1) and (2) if the mecharoyale desktop build ships, since they turn
two of `doctor`'s stated limits into measurements.
