# sloptimize in an Electron game

An Electron renderer is a Chromium page: the in-page runtime, the Ctrl+F12
debugger, the error monitor, the cloud sink and the tier-0 attach all run
unchanged. What Electron changes is *where the ledger is written* (there is
no dev server in a packaged app) and *what can be measured* (a main
process sees every Chromium process and the GPU side). `sloptimize/electron`
covers both. Nothing here imports `electron`: the host passes `app`,
`ipcMain`, `webContents` and `contentTracing` in, and the package's tests
run the same code on bare Node with fakes — it has not been exercised under
a real Electron in this repo, so the first integration should verify the
round-trip (§5) before trusting it.

## 1. Which tier

| Want | Use |
|---|---|
| Look at a stutter once, no app changes | §2 attach from the CLI (`--port`) |
| Ship the recorder to testers, no debug port, GPU traces | §3 `attachInApp` |
| The always-on loop: keyframes, budgets, hook, panel, fixes | §4 IPC sink + preload bridge (+ the game's tier-1 runtime from `docs/INTEGRATION.md` §1) |

They combine: a tier-1 app can also run `attachInApp` for the profiler.

## 2. Attach from the CLI (tier 0, zero integration)

```bash
electron . --remote-debugging-port=9222        # dev
./dist/MyGame --remote-debugging-port=9222     # packaged apps honour Chromium switches too
npx sloptimize attach --port 9222              # in the game repo
```

`--launch` is not the path for an app: it spawns `$SLOPTIMIZE_BROWSER` with
a URL argument. It does work with the bare `electron` binary, whose default
app opens a URL, if all you want is the game under Electron's Chromium:

```bash
SLOPTIMIZE_BROWSER=$(node -p "require('electron')") npx sloptimize attach --launch http://localhost:3000
```

Attach takes the first `page` target that is not a `devtools://` URL and
reloads it so the injection applies — open the game window first in a
multi-window app. `profile.json` says `regime: 'unknown'` on this path;
§3 knows the GPU status and says `hardware`.

## 3. Attach from inside the app

```js
// main.js
import { app, BrowserWindow, contentTracing } from 'electron';
import { attachInApp } from 'sloptimize/electron';

const win = new BrowserWindow({ /* … */ });
await win.loadFile('index.html');
if (process.env.SLOPTIMIZE) {
  const session = await attachInApp({
    webContents: win.webContents,
    app,                     // regime from app.getGPUFeatureStatus()
    contentTracing,          // optional — enables trace: true
    trace: true,             // GPU/compositor trace around every NEW incident
    dir: '.sloptimize',      // default: cwd/.sloptimize, or userData/.sloptimize when packaged
  });
  app.on('before-quit', () => session.close());
}
```

What it does, in order: `webContents.debugger.attach('1.3')`, register the
emit binding, inject the recorder (`Page.addScriptToEvaluateOnNewDocument`,
same script the CLI attach injects), start the rolling sampling profiler,
reload the page. From then on every hitch is attributed by the profiler's
top self-time frames, clustered by cause (one INCIDENT line per new cause),
and appended to `perf.jsonl`; `profile.json` carries
`regime: 'hardware'` unless the GPU is disabled.

**Traces.** With `trace: true` and `contentTracing` passed, a Chrome trace
of the `gpu`, `viz`, `cc` and `toplevel` categories runs in ring-buffer
mode from attach. A NEW incident cluster cuts the ring to
`.sloptimize/trace-<at>.json` and the hitch record names it in `trace`;
repeats of a known cause do not cut (the ring keeps running). Open the file
in `chrome://tracing` or Perfetto: it is the GPU-process and compositor
timeline a page-side profiler cannot see, around the frame that stalled.
Continuous tracing has a cost; leave it off for players, on for a dev or
tester build.

`session.close()` stops the profiler and the trace and detaches. If the
page detaches first (window closed), `close()` skips the debugger calls.

## 4. The always-on loop: IPC sink + preload bridge

Replaces `docs/INTEGRATION.md` §2 (the dev-server ingest endpoint). The
renderer-side runtime from INTEGRATION §1 is unchanged; only its `post` and
the panel's `history` change.

```js
// main.js
import { app, ipcMain } from 'electron';
import { createElectronSink } from 'sloptimize/electron';
const sink = createElectronSink({ ipcMain, app });   // handles sloptimize:ingest / sloptimize:ledger
app.on('before-quit', () => sink.close());

// preload.js
import { contextBridge, ipcRenderer } from 'electron';
import { exposeSloptimizeBridge } from 'sloptimize/electron/preload';
exposeSloptimizeBridge({ contextBridge, ipcRenderer });   // → window.sloptimizeSink

// renderer: the game's dev runtime (INTEGRATION §1), two lines differ
const armed = !!window.sloptimizeSink;                    // arm on the bridge's presence, not hostname
window.sloptimizeSink.post('records', [...rec.drainRecords(), ...motion.drainRecords()]);
createPanel({ history: () => window.sloptimizeSink.history(), /* … */ });
```

`post(kind, payload)` takes exactly what the dev endpoint took —
`profile` → `profile.json`, `census` → `census.json`, `records` → append
`perf.jsonl` — so a game that already has the HTTP sink swaps one call.
`history()` returns `{ records, fixes }` (the last ~2 MB of `perf.jsonl`
plus `fixes.jsonl`, parsed), which is the shape `createPanel`'s `history`
option accepts. The directory defaults to `<cwd>/.sloptimize` in dev and
`<userData>/.sloptimize` when packaged; pass `dir` to pin it, and point the
CLI, hook and MCP server at it with `--dir` when it is not the repo's.

**Process metrics.** When `app` is passed, the sink samples
`app.getAppMetrics()` once a second and

- stamps every ingested `hitch` with `processes: { gpu: { cpu }, renderer: { cpu } }`
  — the latest 1 Hz sample, so "the GPU process was at 95%" is on the
  record next to the frame time;
- appends one `{ type: 'electron-metrics', cpu: {browser,gpu,renderer,other}, memKB: {…} }`
  line a minute, which `sloptimize doctor` reports as the Electron sink
  being active.

`metrics: false` turns it off. The timer is unref'd; `close()` clears it and
removes both IPC handlers.

Two renderer-side traps specific to a desktop window:

- **Background throttling.** A hidden or minimized BrowserWindow stops
  rAF, so the next frame's delta is the whole hidden span. Feed
  `paused: true` while `document.visibilityState === 'hidden'` (and for the
  first frame after restore). The injected tier-0 recorder re-seeds its
  clock on `visibilitychange` itself.
- **Build id.** `createCloudSink({ build })` and `fix` measurement key on a
  build string; use `app.getVersion()` plus a sha baked at package time,
  not a dev-server global.

## 5. Verify the round-trip

1. Start the app with the sink (and `attachInApp` if used).
2. Press Ctrl+F12 in the game, type a note, Enter.
3. `npx sloptimize report --dir <the sink's dir>` shows the keyframe;
   `npx sloptimize doctor --dir …` shows `regime: hardware` and, after a
   minute, the `electron:` line with process CPU.
4. Minimize the window for ten seconds and restore: no hitch appears for
   the gap.

## 6. Server runtime in the main process

`createServerRuntime` from `sloptimize/node` (cloud, SPEC §8.3) runs in the
main process unchanged for tick overruns, event-loop stalls and uncaught
errors; its V8 sampler needs `node:inspector`, which Electron provides in
main only. Not exercised in this repo.

## 7. Not built

- A Vite-style plugin for Electron builds. The sink is ~5 lines to wire.
- Cross-origin isolation for `performance.measureUserAgentSpecificMemory()`:
  set COOP/COEP on the app protocol if a real heap number matters more than
  the deprecated `performance.memory` the GC classifier uses today.
