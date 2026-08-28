# Integrating sloptimize into a game (and its Claude Code session)

What the mecharoyale deployment wired, generalized. Five pieces; each is
small, and the first three are enough to be useful. This doc is the ONE-TIME
wiring; for how to use the result day to day (the operator's verbs, how new
and concurrent Claude Code sessions pick up the feed), see USAGE.md.

## 1. The in-page runtime (the game feeds the recorder)

```js
import { createRecorder, buildCensus } from 'sloptimize';
const rec = createRecorder({ budgetFrameMs: 16.7 });
```

Once per frame, from wherever your loop already reads `renderer.info`,
hand the recorder numbers you already have (≤0.2ms, zero allocations):

```js
rec.frame({
  frameMs,                    // rAF-to-rAF delta (must bound insideRenderMs)
  insideRenderMs,             // wall time inside renderer.render
  calls, triangles,           // renderer.info.render.*  (WebGPU: drawCalls)
  programs,                   // program/pipeline count (WebGPU: pipeline cache size)
  geometries, textures,       // renderer.info.memory.*
  spawned,                    // entities added this frame (0 if unknown)
  paused: false,
});
```

Hitches are detected, classified with evidence, and rate-limited
automatically. Bind a chord for the manual channel — capture FIRST, then
optionally ask the human for one line (see mecharoyale's
`dev/sloptimize-runtime.ts` for a complete reference including the note
overlay, held-input tracking, WebGPU regime detection, and the
GPU-process wrappers):

```js
if (ctrlF11) { const mark = rec.usermark({ windowMs: 5000, note, world }); }
```

## 2. The sink (files on disk)

- **Vite host**: the plugin (planned surface) lands payloads in `.sloptimize/`.
- **Any other host** (esbuild, custom server): add one dev-only endpoint —
  `POST /api/sloptimize/ingest` `{kind: 'profile'|'records'|'census', payload}`
  → writes `.sloptimize/profile.json`, appends `perf.jsonl`, writes
  `census.json`. Gate it to your dev flag and 404 identically to unknown
  routes otherwise (mecharoyale: `server/admin/sloptimize-ingest.ts`, ~100
  lines + tests).
- **Activation**: don't gate the client on `location.hostname` — a dev
  preview proxy looks like production. Probe the ingest endpoint at boot;
  a 204 arms everything, anything else stays dark — and RETRY the probe on
  a backoff (5s/30s/2min, then every 5min): an ingest that comes back
  mid-session must re-light the instrument without a hard refresh.
- **Transport state, never silent**: once armed, a refused or failed post
  flips the feed DARK — buffer outgoing posts (bounded, count drops), retry
  on the same backoff, and SHOW the state (the reference runtime renders it
  on its PERF chip and in the debugger header, with the reason). The first
  deployment's "first 404 disables posting for the session" contract lost an
  hour of real freezes to a server restart that dropped the ingest.
- **Self-sufficient records**: stamp `build` (the tab's bundle identity) and
  `phase` (menu/boot/launch/match…) on every ledger line. The recorder
  accepts `phase` per `frame()` sample and stamps hitches at mint time;
  backfill the rest at post time. A record read in isolation weeks later
  should not depend on the arm-probe that happened to precede it.
- **Heartbeat**: post a tiny `{type:'heartbeat', medianFrameMs, p95Ms}`
  ledger line once a minute while armed (directly — never through the
  recorder, so it costs none of the incident budget). It makes a quiet file
  MEAN dark-or-closed instead of idle; `sloptimize hook-status` warns once
  when the ledger goes stale (>45min).
- **GPU-settle verdicts**: if your boot holds its reveal on
  `queue.onSubmittedWorkDone()` (it should — pipeline compiles bill the
  first submit that uses them, invisibly to every CPU-side recorder), post
  `{type:'gpu-settle', tag, ms, settled}` when the wait was real (>50ms or
  capped). That record is the on-hardware proof the freeze moved behind the
  cover.
- **createStacks** (optional, on hitch records): capture `new Error().stack`
  in your createRenderPipeline/createComputePipeline/createShaderModule
  wrappers into a small ring (creates are rare — never do this per draw or
  per write), and attach the top ~3 deduped tails to any hitch whose frame
  window overlaps them, byte-capped (~2KB). Ship an UNREFERENCED external
  sourcemap from the same build so the minified positions decode to source
  file:line on the dev side without ever serving the map to players.

Flush cadence: post `profile` every ~2s, drain records with it.
Gitignore `.sloptimize/*` except `budgets.json`.

## 3. The CLI (the agent's shell surface)

`sloptimize report|check|census|doctor --dir <game>/.sloptimize` — no
setup beyond the files existing. Declare budgets in
`.sloptimize/budgets.json`:

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

`check` exits 0/1/4 — the termination condition for an agent loop.

## 4. The Claude Code session (pull: ambient on every prompt)

`.claude/settings.json` in the game repo:

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [ {
  "type": "command",
  "command": "node <path-to>/sloptimize/bin/sloptimize.mjs hook-status --dir .sloptimize 2>/dev/null || true",
  "timeout": 10 } ] } ] } }
```

Silent unless a NEW keyframe or a budget-breach edge exists; at most 5
lines. Copy the doctrine skill into `.claude/skills/sloptimize/` so any
future session inherits the playbook (report → classify → census → ONE
change → verify with counters; never claim a fix without a before/after).

## 5. The push channel (auto mode: the agent is woken, nobody types)

`sloptimize watch` is the watcher (SPEC §8.1.1): a byte cursor over each
`--dir`'s `perf.jsonl`, polled every 20s, printing ONE line per record an
agent should act on — every usermark, every auto hitch ≥100ms
(`--min-hitch-ms`), a gpu-settle that hit its cap, any gpu-stall, and the
feed going quiet / coming back. Heartbeats, arm-probes and small hitches
stay silent. It starts at EOF (history is `report`'s job) and never exits.

Arm it as a Claude Code Monitor — stdout lines become wake events:

```
Monitor({ command: 'node <path-to>/sloptimize/bin/sloptimize.mjs watch --dir .sloptimize',
          description: 'sloptimize perf incidents', persistent: true })
```

To make every session arm it WITHOUT anyone asking, add a `SessionStart`
hook that prints the instruction into the agent's context (mecharoyale's
`.claude/settings.json` is the reference; it skips ticket-runner jobs so a
session working an unrelated task is not pulled off it, unless
`SLOPTIMIZE_WATCH=1` says otherwise). The operator then just plays:
auto-detected hitches and Ctrl+F12 notes wake the agent with the
classification attached, and it starts the §8.2 playbook unprompted.

## Porting cost, measured once

mecharoyale (149k-line client, esbuild, WebGPU, no vite): runtime file
~250 lines, server endpoint ~100 + tests, build-resolution plugin ~15,
one `rec.frame(...)` call at the existing stats site, settings + skill
copies. One session end to end, including the mistakes this doc exists
to save you from (hostname gating, arming inside an on-demand function,
frameMs not bounding insideRenderMs).
