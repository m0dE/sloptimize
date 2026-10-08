# sloptimize

[![npm](https://img.shields.io/npm/v/sloptimize.svg)](https://www.npmjs.com/package/sloptimize)

sloptimize optimizes your game's rendering performance by finding the
bottlenecks and reporting them to Claude Code to fix — all while you just play
the game. No action is required on your end.

**The agent-native profiler for browser games.** Your coding agent cannot
watch a game run — it will never feel a hitch, cannot screenshot 60 times a
second, and cannot verify a "fix" it cannot measure. sloptimize gives the
agent the three verbs it measurably lacks:

- **MEASURE** — an always-on flight recorder detects incidents (CPU spikes,
  fps drops, GPU stalls, and the player's unit or camera SNAPPING off its own
  trajectory) automatically, in the background, and writes them to disk
  before anyone asks. The human just plays.
- **ATTRIBUTE** — every incident arrives classified with evidence
  (`shader-compile: programs +2`, `long-script`, upload storms,
  `snap 17.5m in one frame`), stamped with a **footprint** — the identity of
  its cause and the game's situation (which machine, at the helm or on foot,
  in combat…), never its time — so one cause across builds, sessions and
  players is one issue with a count and a fix history, and — with the attach
  tier — named by **function and file:line** from a rolling sampling profiler.
- **VERIFY** — exact counters (draw calls, triangles, pipelines — deterministic
  on any renderer), perf budgets with exit codes, and honest labels: timing
  numbers carry their regime (`hardware`/`software`) and are never compared
  across them.

The division of labor is the design: **the tool decides what is true; the
agent decides what to try; the human plays.**

Proven in production on a 149k-line WebGPU battle-royale: the pipeline caught
a 205,000-calls/11s GPU upload storm from a player's real session, attributed
it, and verified the fix at >60× reduction — with the player doing nothing
but playing.

## The pipeline

```
game/browser ──► incidents (auto-detected, classified, clustered)
                    │
                    ▼
              .sloptimize/          ◄── the agent's reading room
              profile.json            rolling summary (median/p95/counters/regime)
              perf.jsonl              incident records, append-only, each with its footprint
              clusters.json           one cause = one cluster
              census.json             per-entity cost census (tier 1+)
              fixes.jsonl             the fix ledger: issue → solution, commit, MEASURED before/after
              budgets.json            YOUR limits (the one human-authored file)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   Claude Code (agent)     in-game debugger (human, OPTIONAL)
   woken on new incidents   Session · Issues · Optimizations · Settings —
   (fp=<id> ×N on each);    this tab's incidents + a note box; every cause
   reads, fixes, verifies,  grouped by footprint with ×N, last seen and the
   records each fix         fixes applied; p95/calls/hitches over time
```

Showing the work is part of the loop: after a verified fix the agent runs
`sloptimize fix --title … --issue … --solution … --commit <sha>`, and the
record's before/after are two **measured** windows of the ledger (previous
build vs new build) — not numbers the agent typed. The debugger's Fixes tab
and `sloptimize history` read that ledger back.

## Install

Published on npm as [`sloptimize`](https://www.npmjs.com/package/sloptimize).
Node 22+.

```bash
npm i -D sloptimize          # in your game repo (recommended)
npx sloptimize --version     # confirm: prints the installed version
```

No install at all for a one-off: `npx sloptimize attach --launch http://localhost:3000`.
Working from a git checkout instead? `node /path/to/sloptimize/bin/sloptimize.mjs …`
runs on bare Node.

Zero dependencies, no postinstall, no supply chain — npm is delivery only.

## Quickest start: zero integration (tier 0)

Requires only Node 22+ and a Chromium. No game changes, no build changes:

```bash
npx sloptimize attach --launch http://localhost:3000 --headless
# play / drive the game …then:
npx sloptimize report
```

Attach connects over the Chrome DevTools Protocol, injects a recorder before
any page script (rAF timing, draw/triangle counts via graphics-API wraps,
pipeline creations WITH call stacks, upload bytes, GPU queue latency), and
runs a rolling sampling profiler so a freeze is attributed like:

```
INCIDENT long-script|seededFreezeWork@game.js:512 — 900ms
```

Every attributed cause is its own issue in `sloptimize issues`, keyed by
function name so the same cause on the next build is the same row. Tell attach
which build it is measuring (`--build <id>`) and repeated runs of one build
fold into one build with its runs' range in `sloptimize history`: run-to-run
noise is real (the first field report measured byte-identical bundles 27%
apart in hitch count), and the page beats once a minute so rates are over
the minutes actually recorded. A page with distinct phases can say so with
one optional line, `window.__sloptimizePhase = 'steady'`, and every record
after it — hitches, beats and pipeline creations alike — carries the phase, so
`sloptimize issues --phase steady` reads just that phase. A frame is a hitch
at 2× the rolling median (once 60 frames are in), or at 200 ms whatever the
median — so a load that is slow from its first frame still records its
stalls.

Attach **reloads the page** so the recorder runs before any page script: an
app that was already up boots once more, and the app's own log shows that
boot (terrain generation, save parse, the lot) twice. Only the boot after the
reload is recorded — one `armed` line per session — so sloptimize's load-phase
counts are of one boot; the app's own counters are not. If the page
navigates or reloads itself while attached, every boot is recorded, and
`report` says so (`note: session … armed 2×`): read load-phase hitch counts
and worst frames from such a session as covering all of them.

Tier-0 timings are **rAF intervals with the recorder attached**: vsync-quantized
(a 26 ms frame body presents every 33.3 ms on a 60 Hz display) and paying for
the recorder and the sampler. Compare them with other attached runs only —
never with the app's own frame timer or with an unattached run. `report`
says so under every tier-0 profile, with the display's refresh rate (read
off the rAF cadence) and which vsync steps the median is made of; `compare`
refuses two sides measured by different tiers. Draws are counted at the
WebGL/WebGPU API the way `renderer.info` counts them — instanced and
multi-draw calls included — as a mean over the sample window.

The sampler's cost is bounded so it can never be the hitch it reports:
10 ms sampling, one profile rotation per second at most, and only for
stalls of 80 ms or more (shorter hitches are still recorded, marked
`unattributed`). `--min-hitch-ms N` raises the detection floor itself.
A function is named as a hitch's cause only when its self time is at least
a tenth of the frame: every top frame carries its `share` of the frame, and
a stall whose heaviest JS function explains less (`687.5ms → _aStarLoop
11.2ms` is 1.6%) reads `unattributed (heaviest JS … = 1.6% of the frame;
the chunk's other time: native …ms, gc …ms)` — the rest was GC, native
work or unsampled, and optimising that function would not touch it.
`--min-share 0.05` moves the bar (it is a judgement, not a law — a stall
spread thinly over many functions has no single cause at any bar).

Every sample of the run is also kept, per function and phase, in
`.sloptimize/runs/<session>.json` — which is what two more verbs read:

```bash
# Did the benchmark execute the change at all? (default: git diff of the tree, else the last commit)
npx sloptimize touched [--changed src/a.ts,src/b.ts | --since main] [--map dist/index.js.map]
#   ✔ src/sim/cars.ts      412 samples under stepCars (6.7% of JS), 380 self in the file
#   ✗ src/entities/tram.ts 0 samples — if it ran, it took under 0.05% of JS time (95%)
#   0 samples in 1 of 2 changed code file(s) … — exit 1

# A vs B (a build, a session, or <ISO>..<ISO>), each metric against its OWN run-to-run floor
npx sloptimize compare before-build after-build [--phase steady]
```

A fixed camera cannot see what only a moving one shows. A drive script — the
game's own, run on the recording's timeline — scripts the camera and input,
and its hash keeps runs of different scripts apart:

```bash
npx sloptimize attach --launch http://localhost:5173 --drive bench/orbit.mjs --runs 3 --build $SHA
# bench/orbit.mjs: export default async function drive({ phase, at, eval, key, drag, until }) { … }
```

A long session leaks where frame metrics cannot see: the heartbeat carries
live GPU objects (created − deleted − collected, at the graphics API),
three.js's `renderer.info.memory`, and the JS heap, and `report` reads them
as trends (`▲ GPU buffers (live): 1200 → 1927 (+1500/h …) — GROWING: a
dispose missed on a rebuild?`). `attach --heap-gc` reads the heap post-GC;
`--heap-snapshots` writes a start and an end snapshot for DevTools.

What did the run NEVER call? A coverage run counts every function's calls
exactly — its own run, since coverage slows the page:

```bash
npx sloptimize attach --coverage --launch http://localhost:5173 --duration 60
npx sloptimize coverage                     # loaded-but-idle modules, never-loaded files
#   ◌ src/entities/TrafficLight.ts  14.2 KB  2/9 called — IDLE: loaded and sat (bench content missing?)
#       never called: update:41, setPhase:88, …
npx sloptimize coverage --since main        # every changed FUNCTION, called or not (exit 1 if not)
```

`touched` exits 1 when a changed code file received no samples: a clean
A/B on a scene that never ran the new code path is a rubber stamp, not a
measurement. `compare` reads every metric per run — frame median/p95/body,
draw calls, hitches/h, each host loop section, each hot function's share —
and marks each one `significant` only when every B run lies beyond every A
run and the delta exceeds twice that metric's own run-to-run range; one run
on a side is `unproven`. A frame delta can be noise while one section's
+0.24 ms reproduces to two decimals — a single global threshold would hide
it. When the frame moved ≥10% but the composition (section or function
shares) did not, and the draw calls are equal, `compare` flags it as the
machine, not the code.

Frame time is half a verdict: a game can also report its own throughput,
over its own clock, from the page —

```js
window.__sloptimizeCount('delivered', n);       // what the game did
window.__sloptimizeClock('sim', simMs, 1000);   // how much game time passed
```

— and `report`, `compare` and `check` read it as a rate per game-second.
Per wall second, a build that renders faster covers more game time and
flatters itself; `report` says so when no clock was given (SPEC §3.11).

A one-off phase — a load, a level transition — is timed as a span from the
`__sloptimizePhase` assignments, and two more optional lines make it a
diagnosis instead of a number (SPEC §3.15):

```js
window.__sloptimizeScale('roads', 1469);                  // what the phase worked on
window.__sloptimizeSection('createSidewalks', ms, calls);  // named work, with its call count
```

`report` prints `load 9000 ms · 1469 roads → 6.127 ms/road`, so two different
saves compare per unit, and `compare` says which factor of a section moved:

```
  section createSidewalks   737 -> 23060 ms   x3762 -> x3747
    same call count, 31x ms/call → the work PER CALL changed (look inside it)
```

— against `same ms/call, 32x calls → it is CALLED more (look at its
callers)`, a different bug with a different fix. `check` takes
`perf.budget.load.ms_per.road`, a budget that holds across inputs.

Inside the function a hitch names, attach names the LINE — V8's per-line
ticks, already in the profile it reads: `top update@index.js:84908 312ms
(80% of frame) — :84931 61% · :84944 22%`. Each hitch is attributed from the
samples inside its own frame (the page's clock mapped onto the sampler's),
and a frame of 150 ms or more is never left `unattributed (cooldown)`: a load
of back-to-back long frames is where attribution matters most.

Before any of that, `compare` checks that the two sides were measured under
the same **conditions** — every run records its display refresh rate, GPU,
drawing size, instrument (attached or in-app), run mode, sampler interval
and phase mix (SPEC §3.8). Two sides that differ on any of them are
refused, exit 3, with the difference named — a 60 Hz run against a 144 Hz
run is a delta of displays, not of code. `--allow-mismatch` reads them
anyway under a banner, for when the difference is the question. A run
recorded before conditions existed is listed as unverified, not refused.

Attach also sees a three.js page's scenes, through three's own devtools
hook (`__THREE_DEVTOOLS__`: every `Scene` three constructs announces itself
there, and the recorder defines it before any page script). It uses that
for one thing no counter can: InstancedMesh slots drawn but no longer
written. Every slot below `.count` draws, written or not — a cull that
stopped writing off-screen transforms while `count` stayed at the
high-water mark leaves ghosts at their last positions, invisible to draw
counts, triangles and frame time, and to the graphics API, which uploads
the whole buffer. Every ~2 s the recorder notes, per visible InstancedMesh,
which slots were written (`setMatrixAt`, wrapped on the instance) or changed
(a direct `instanceMatrix.array` write); slots idle ~10 s in a mesh whose
other slots move land as `instance-slots` records — in `report`, `issues`
and `watch`: `◫ bodies: 200 drawn, 105 written/moved in the last window, 95
untouched for 10s`. That is static instances or ghosts; you know which.
When the count drops back to the live set, a clearing record says so.
`--no-slots` turns the watch off and leaves `__THREE_DEVTOOLS__` undefined.

`attach --port N` against a port nothing listens on fails at once with
`nothing is listening on 127.0.0.1:N`; `--wait <s>` keeps trying while
an app starts.
Keep DevTools closed on the target while attach records — a second CDP
client costs the page ~25 ms per frame. Attach exits on its own when the
target goes away.

Limits, stated: Chromium-only; minified bundles attribute to minified names
unless you serve sourcemaps; entity-level attribution needs tier 1+.

## Higher fidelity: the in-page feed (tier 1)

One call per frame from wherever your loop already reads `renderer.info`:

```js
import { createRecorder } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });
// per frame:
rec.frame({ frameMs, insideRenderMs, calls, triangles, programs,
            geometries, textures, spawned, paused });
// optional human channel (bind to a chord, e.g. Ctrl+F11):
rec.usermark({ windowMs: 5000, note, inputsHeld, world });
```

Ship the records to `.sloptimize/` however your stack likes — a vite host
gets a plugin (planned); any other host adds one dev-gated POST endpoint
(~100 lines; see `docs/INTEGRATION.md` for the reference implementation,
including the four traps that cost the first deployment real time:
**don't gate activation on hostname** (probe your dev endpoint instead),
**give the recorder its own rAF clock** (a game-loop-fed clock is blind to
boot/launch — exactly the windows you care about), **frameMs must bound
insideRenderMs**, and **never let the feed die silently** (retry the probe
and the posts on a backoff, buffer while dark, and SHOW the state — the
first deployment lost an hour of real freezes to a server restart that
dropped the ingest with no indication anywhere).

The wire contract the reference runtime keeps, so the files are useful on
their own:
- **every record is self-sufficient** — `build` (which bundle the tab runs)
  and `phase` (menu/boot/launch/match…) ride each ledger line; hitches are
  stamped at mint time, not post time;
- **a heartbeat record lands once a minute while armed**, so a quiet
  `perf.jsonl` means "no session, or the feed is dark" — never just "idle"
  (`sloptimize hook-status` warns when the ledger goes stale);
- **gpu-settle records** report how long a boot/reveal gate actually waited
  on `onSubmittedWorkDone` — the on-hardware verification channel for
  compile-stall fixes;
- **a hitch that overlapped pipeline/shader creates carries `createStacks`**
  — the top 3 deduped `Error().stack` tails from the create wrappers (~2KB
  cap), so a `programs +N` hitch from a machine you cannot profile names its
  own call sites. The positions are minified (`bundle.js:L:C`); keep an
  unreferenced sourcemap at build time and decode locally (the game repo's
  `tools/decode-perf-stack.mjs` is a dependency-free reference decoder).

**Coordinate jitter and the issue catalogue** (tier 1, ~200 lines in the
game): feed the unit's and the camera's positions once per rendered frame
and a snap or oscillation lands as a classified `jitter` record; declare a
few facets of the player's situation and every incident of every kind is
footprinted, counted and linked to its fixes — the debugger's **Issues**
tab, `sloptimize issues`, and `fp=<id> ×N` on every wake line. The whole
recipe, with the three traps that make a naive position detector lie
(rotation, transient shakes, the sim's dt clamp), is
`docs/JITTER-AND-FOOTPRINTS.md`.

```js
import { createMotionMonitor, canonicalContext, footprintOf } from 'sloptimize';
const motion = createMotionMonitor({ unit: 'm', longFrameMs: 50,
  tracks: { unit: { floor: 0.1 }, camera: { floor: 0.1, reach: 'boom', follows: 'unit' } } });
// per rendered frame, after the render:
motion.sample('unit',   pivot.x, pivot.y, pivot.z, now, { held: paused, phase, ctx });
motion.sample('camera', cam.x,   cam.y,   cam.z,   now, { held: paused || lookInput, reach, phase, ctx });
// once a second:  ctx = canonicalContext({ stance: 'helm', hull: 'elong-x', squad: 'duo', combat: 'no' });
// at post:        for (const r of records) { r.ctx ??= ctx; const fp = footprintOf(r); if (fp) r.footprint = fp; }
```

Tier 2 (scene census, per-entity attribution, measured bisection) layers on
top where the engine grants scene access — see `docs/SPEC.md` §4.

## Claude Code integration — the whole point

The npm package IS a Claude Code plugin — skill, prompt hook, and MCP server
ship inside it. After `npm i -D sloptimize`, point Claude at it:

```bash
claude --plugin-dir node_modules/sloptimize
```

Alternatives: `claude --plugin-dir /path/to/sloptimize` from a git checkout,
or via the marketplace:
`/plugin marketplace add m0dE/sloptimize` then `/plugin install sloptimize`.

Then let the agent wire your game: `/sloptimize:install` walks it through
the tier-1 integration (runtime, sink, budgets, hooks) and refuses to call
itself done until the feed is proven live end-to-end.

That carries three surfaces into every session:
- **Skill** — the doctrine: read → classify → census → ONE change → verify
  with counters; never claim a perf fix without a measured before/after;
  never quote timing from a software regime.
- **Prompt hook** — silent by default; when a NEW keyframe or budget breach
  exists, up to five lines land in the agent's context on your next prompt.
- **MCP server** — `get_report`, `check_budgets`, `get_history`,
  `get_issues` (the catalogue by footprint), `record_fix` (with the
  footprints it addresses), `compare_runs` and `check_touched`, and
  `attach_start` / `attach_stop` for the live tier.

For instant wakeups (the agent starts fixing ~20s after the stutter, no
prompt needed), arm `sloptimize watch` as a session Monitor — one line, in
`docs/INTEGRATION.md` §5. Wire it into a `SessionStart` hook and every
session arms it by itself.

## Electron games

An Electron renderer is a Chromium page, so everything above applies. What
Electron adds is a main process that can host the sink itself (no dev
server) and see what a browser hides — per-process CPU and the GPU side:

```js
// main.js
import { app, ipcMain, contentTracing } from 'electron';
import { createElectronSink, attachInApp } from 'sloptimize/electron';
const sink = createElectronSink({ ipcMain, app });        // .sloptimize/ via IPC; hitches carry GPU/renderer CPU
const session = await attachInApp({ webContents: win.webContents, app, contentTracing, trace: true }); // tier 0, no debug port

// preload.js
import { contextBridge, ipcRenderer } from 'electron';
import { exposeSloptimizeBridge } from 'sloptimize/electron/preload';
exposeSloptimizeBridge({ contextBridge, ipcRenderer });   // window.sloptimizeSink.post / .history
```

Then `sloptimize report`, the hook and the MCP server read the same files.
`docs/ELECTRON.md` has the full recipe, and `sloptimize attach --port 9222`
still works against an app started with `--remote-debugging-port=9222`.

## Cloud — [sloptimizejs.com](https://sloptimizejs.com)

Everything above is local: one machine's `.sloptimize/` directory, read by
that machine's shell and that machine's Claude Code session. sloptimize
cloud widens the same catalogue to **every player, every build** — not just
the one in front of you: an issues catalogue across 24h/7d/30d or any range,
a timeline of p95 frame time, draw calls and incidents across all tabs with
build boundaries and fix markers, one page per player session, and every fix
measured against what players saw. Client incidents and server incidents
(`sloptimize/node`) fold into the same footprint identity; uncaught errors
(`createErrorMonitor`) are their own incident kind. The local product stays
the default story — nothing below changes what a project with no cloud key
does.

Getting on it takes three steps:

1. Sign in at [sloptimizejs.com](https://sloptimizejs.com) with GitHub. The
   free plan (5,000 incidents a month, 7 days of raw records, one project)
   needs no card; Pro and Team lift the limits.
2. Create a project and open its settings page: it holds the two keys and the
   same three snippets below, filled in.
3. Paste the snippets. The endpoint is `https://sloptimizejs.com/v1/ingest`
   for both sinks; the CLI and MCP take the base, `SLOPTIMIZE_ENDPOINT=https://sloptimizejs.com`.

```js
// browser: the cloud sink is a TEE beside your existing drain, never instead
// of it — errors ride the same recorder as hitches, so one drain feeds both
import { createRecorder, createErrorMonitor, createCloudSink } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });
createErrorMonitor(rec);
const cloud = createCloudSink({ key: 'pk_live_…', endpoint: 'https://sloptimizejs.com/v1/ingest', build });
// in the ~2s drain you already have (docs/INTEGRATION.md §1):
const batch = rec.drainRecords();
post('records', batch);   // unchanged: .sloptimize/perf.jsonl, still the source of truth
cloud.enqueue(batch);     // the same records, teed to the cloud sink's own queue
```

A player thrown back to the menu mid-game is a page being replaced, and no
incident can say how. `createExitTrail` has the NEXT page report it: killed (no
pagehide, the browser ended the process), your own code by name, or the browser.
See docs/INTEGRATION.md, "How the last page ended".

(The `sources: [rec]` option exists only for a host with no file sink at all:
the sink drains those sources itself, so anything it takes never reaches your
own `drainRecords()`.)

```js
// game server (Node): ticks, event-loop stalls, and uncaught errors
import { createServerRuntime } from 'sloptimize/node';
const server = createServerRuntime({ key: process.env.SLOPTIMIZE_KEY, endpoint: 'https://sloptimizejs.com/v1/ingest', build, tickBudgetMs: 16 });
server.tick(() => stepWorld());   // a tick over budget is a server-hitch, attributed by the V8 sampler
```

The server runtime registers `uncaughtExceptionMonitor` only, so it observes
a crash without ever becoming part of the crash path. One consequence worth
knowing: under `--unhandled-rejections=warn` or `none`, unhandled rejections
are **not** captured — that event sees them only in Node's default `throw`
mode, and listening to `unhandledRejection` instead would suppress the throw
your process relies on.

```bash
# CLI: read the cloud catalogue instead of this machine's ledger
export SLOPTIMIZE_KEY=sk_live_… SLOPTIMIZE_ENDPOINT=https://sloptimizejs.com
npx sloptimize issues --cloud --preset 7d
npx sloptimize fix --title "…" --push   # records locally, then pushes
```

Honesty is the whole pitch: a dropped-locally count rides every batch the
sink sends, so the dashboard's numbers say what they could not see rather
than pretending nothing was lost.

Two kinds of key, and the difference matters. The **publishable** key is
public and write-only (it can post incidents, never read anyone else's), so
shipping it in a client bundle is the intended use, not a leak — that is the
key in the browser snippet above. The **secret** key is the one the server
runtime, the CLI (`SLOPTIMIZE_KEY`) and the MCP server use: it reads your
whole catalogue (`/v1/issues`) and writes fixes (`/v1/fixes`). A secret key
never goes in a client bundle.

## Budgets: "fast enough" as an exit code

`.sloptimize/budgets.json` (the one file a human reviews):

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

```bash
npx sloptimize check              # exit 0 inside · 1 breached · 3 other conditions · 4 unmeasured
```

Budgets can name a phase and are then judged over a whole run — a build's
runs, the median of them — which is what a gate after every build runs:

```json
{ "perf.budget.load.worst_ms": 500,
  "perf.budget.steady.p95_ms": 40,
  "perf.budget.*.frames_over_100ms_per_min": 2 }
```

```bash
npx sloptimize attach --launch http://localhost:5173 --build $SHA --runs 3 --duration 60
npx sloptimize check --build $SHA --min-runs 3     # 0 pass · 1 breach · 5 cannot judge (too few runs, unmeasured)
npx sloptimize compare $BASE $SHA --fail-on-regression   # 1 regressed · 5 fewer than 3 runs a side · 3 the machine changed
```

Hitch budgets count frames over a FIXED bar (`frames_over_<N>ms_per_min`):
detection is relative to the rolling median, so a uniformly slower build
reports fewer hitches, and a relative hitch budget alone is refused. Too few
runs is exit 5, never a pass (SPEC §7.1).

A budget met at 144 Hz says nothing about 60 Hz. Say what the numbers were
set for, and `check` refuses (exit 3) a measurement taken under anything
else:

```json
{ "perf.budget.frame_ms_p95": 16.7, "perf.conditions": { "refreshHz": 60, "regime": "hardware" } }
```

That exit code is what lets an agent self-iterate in a loop that terminates.

## CLI

```
sloptimize report        current profile + incidents + census hints
sloptimize check         budgets → exit code (--counters-only for CI)
sloptimize census        per-entity costs + closed-vocabulary hints
sloptimize history       the timeline: p95 / draw calls / hitches per time
                         bucket and per build, plus the fix ledger
sloptimize compare A B   A/B by run: each metric vs its own noise floor
                         (significant / within noise / unproven), host-load flag;
                         refused (exit 3) across conditions — --allow-mismatch
sloptimize touched       did the run execute the changed files? (exit 1 if not)
sloptimize fix           record a verified fix (title, issue, solution,
                         commit) with MEASURED before/after windows
sloptimize attach        tier-0: --launch <url> [--headless] [--port N] [--wait <s>] [--min-hitch-ms N] [--build <id>]
                         [--min-share 0.1] [--no-slots]
sloptimize hook-status   the prompt hook's ≤5-line ambient surface
sloptimize issues        the catalogue: every incident grouped by FOOTPRINT
                         (cause + situation, never time) — how often, how
                         recently, which fixes were applied; --fp <id> for one
sloptimize watch         the push channel: one stdout line per usermark /
                         ≥100ms hitch / gpu cap-hit / coordinate jitter /
                         feed dark, each with fp=<id> ×N; never exits
sloptimize doctor        what is wired, what is degraded, stated limits
```

`--phase play[,sample]` scopes `report`, `issues`, `history` and `fix` to
the records stamped with those phases (tier 1: `rec.frame({ phase })`;
tier 0: `window.__sloptimizePhase = 'play'`). A session with a load phase
and a play phase is two workloads in one ledger; read together, the bigger
one wins on volume alone. Records with no phase answer only to `--phase ?`.
A filter that matches nothing exits 4 and names the phases the ledger does
carry (with `--json`: the usual empty output, the reason on stderr).

## What it will tell you it cannot do

Printed by `doctor`, kept in the spec, never silently degraded: no per-draw
GPU timing; bisection ranks rather than sums; workload repro, not trajectory
repro; timing from software renderers flagged and never compared; V8
inlining can split an incident cluster across an optimization boundary;
**correctness bugs are out of scope** — a profiler cannot find a logic bug,
and the doctrine routes "it looks/behaves wrong" reports away before anyone
burns a loop on them.

## Docs

- `docs/USAGE.md` — day-to-day use once wired: the operator's verbs, new-session pickup, multi-session semantics, monitoring options
- `docs/SPEC.md` — the founding specification (recorder, census, bench, anti-gaming posture)
- `docs/SPEC-attach.md` — v2: the incident pipeline, tier-0 attach, measured exit criteria
- `docs/INTEGRATION.md` — wiring a real game + Claude Code session, with the reference deployment's traps
- `docs/ELECTRON.md` — Electron games: the IPC sink (`sloptimize/electron`), in-app attach with GPU traces, per-process CPU on every hitch
- `docs/DESIGN-mecharoyale-v0.md` — the first field deployment's decision record

## Status

M0–M2 (recorder, census, budgets/CLI) and M-A0–A2 (attach, incident
identity, plugin packaging) shipped with measured exit criteria. Bench +
correctness gate (SPEC §6, M3) and paused-world bisection (M4) are next.

## Relationship to slopjs

A sibling on the same platform: slopjs is a pointing device for a
human-in-the-loop authoring session; sloptimize is a measurement loop that
works with nobody watching. Tier 2 consumes `@slopjs/inspector` primitives
(stable IDs, the coherent pause, snapshots) where present.

## License

MIT
