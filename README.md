# sloptimize

[![npm](https://img.shields.io/npm/v/sloptimize.svg)](https://www.npmjs.com/package/sloptimize)

Your browser game stutters. sloptimize records every stutter while you play,
works out what caused it, and hands it to Claude Code to fix — with numbers,
so a fix is measured, never claimed.

## Start in 15 seconds

```bash
npm i -D sloptimize
claude --plugin-dir node_modules/sloptimize
```

Inside Claude Code:

```
/sloptimize:install
```

The agent wires your game — one call per frame in your render loop, one
dev-only endpoint that writes `.sloptimize/`, your budgets, its own hooks —
and refuses to call itself done until a test incident shows up in
`npx sloptimize report`. Then you just play.

No game changes at all? Attach to a running page instead:

```bash
npx sloptimize attach --launch http://localhost:3000
# play, then:
npx sloptimize report
```

Node 22+. Zero dependencies, no postinstall.

## What you get

- **Every incident, on disk, classified.** Hitches, freezes, GPU stalls,
  shader compiles, and the player's unit or camera snapping off its own
  path — each with the evidence (`shader-compile: programs +2`,
  `long-script`, `snap 17.5m in one frame`) in `.sloptimize/perf.jsonl`.
- **One cause = one issue.** Incidents are grouped by *footprint* — what
  caused it and where in the game it happened, never when — so the same
  stutter across builds and sessions is one entry with a count and its fix
  history (`fp=a3f92c1d ×7`).
- **A budget with an exit code.** `npx sloptimize check` exits 0 inside
  your limits, 1 over them. That is what lets an agent loop until it is done.
- **An agent that wakes itself.** About 20 s after a stutter, Claude Code
  is woken with the classified incident, fixes it, verifies with exact
  counters, and records the fix with a measured before/after.

## Wiring it by hand

If you would rather not let the agent do it:

```js
import { createRecorder } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });

// once per frame, where you already read renderer.info:
rec.frame({ frameMs, insideRenderMs, calls, triangles, programs, geometries, textures, spawned, paused });

// every ~2s, POST rec.drainRecords() to a dev-only endpoint that appends .sloptimize/perf.jsonl
```

Budgets live in `.sloptimize/budgets.json`:

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

The full recipe — the ingest endpoint, the jitter detector, footprints, the
Claude Code hooks, and the traps that cost the first deployment real time —
is `docs/INTEGRATION.md`.

## Cloud: every player, not just your machine

The local setup above is free and is the default. It sees one machine: the
one running the game with `.sloptimize/` beside it — your own sessions.

**sloptimize cloud** ships the same records from every player's browser and
from your game server into one catalogue, so the issues are the ones your
users actually hit, in every build, not the ones you happened to reproduce.
Same footprints, same CLI, same agent:

```bash
export SLOPTIMIZE_KEY=<secret key>  SLOPTIMIZE_ENDPOINT=<endpoint>
npx sloptimize issues --cloud --preset 7d     # every player, last 7 days
npx sloptimize fix --title "…" --push          # record a fix locally, then to the cloud
```

Wiring is one tee beside the local sink, never instead of it:

```js
import { createRecorder, createErrorMonitor, createCloudSink } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });
createErrorMonitor(rec);                                   // uncaught errors ride the same recorder
const cloud = createCloudSink({ key: '<publishable key>', endpoint: '<endpoint>', build });
// in your existing ~2s drain:
const batch = rec.drainRecords();
post('records', batch);      // local ledger, still the source of truth
cloud.enqueue(batch);        // the same records, to the cloud
```

```js
// game server (Node): tick overruns, event-loop stalls, uncaught errors
import { createServerRuntime } from 'sloptimize/node';
const server = createServerRuntime({ key: '<secret key>', endpoint: '<endpoint>', build });
```

Two keys: the **publishable** key is write-only and meant to ship in the
client bundle; the **secret** key reads your catalogue and belongs on the
server, in the CLI, and in Claude Code — never in a bundle. Every batch
carries a dropped-locally count, so the dashboard says what it could not
see instead of pretending nothing was lost.

The cloud is paid and invite-only; your project's settings page hands you
the endpoint and both keys.

## CLI

```
sloptimize report      current profile, incidents, census hints
sloptimize check       budgets → exit code
sloptimize issues      every incident grouped by footprint (--cloud for every player)
sloptimize history     p95 / draw calls / hitches per build, plus the fix ledger
sloptimize fix         record a verified fix with a MEASURED before/after
sloptimize watch       one line per incident, for the agent's Monitor
sloptimize attach      zero-integration: --launch <url> [--headless]
sloptimize census      per-entity meshes / triangles / materials
sloptimize doctor      what is wired, what is degraded, stated limits
```

## Limits, stated

No per-draw GPU timing. Timing from software renderers is flagged and never
compared with hardware. `long-script` names the frame, not the function,
unless the attach tier's sampler is running. Correctness bugs are out of
scope — a profiler cannot find a logic bug.

## Docs

- `docs/INTEGRATION.md` — wiring a real game and its Claude Code session
- `docs/USAGE.md` — day-to-day use once wired
- `docs/JITTER-AND-FOOTPRINTS.md` — the jitter detector and the issue catalogue
- `docs/SPEC.md`, `docs/SPEC-attach.md` — the specifications

## License

MIT
