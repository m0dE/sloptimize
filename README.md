# sloptimize

sloptimize optimizes your game's rendering performance by finding the
bottlenecks and reporting them to Claude Code to fix — all while you just play
the game. No action is required on your end.

**The agent-native profiler for browser games.** Your coding agent cannot
watch a game run — it will never feel a hitch, cannot screenshot 60 times a
second, and cannot verify a "fix" it cannot measure. sloptimize gives the
agent the three verbs it measurably lacks:

- **MEASURE** — an always-on flight recorder detects incidents (CPU spikes,
  fps drops, GPU stalls) automatically, in the background, and writes them to
  disk before anyone asks. The human just plays.
- **ATTRIBUTE** — every incident arrives classified with evidence
  (`shader-compile: programs +2`, `long-script`, upload storms), clustered so
  one cause is investigated once, and — with the attach tier — named by
  **function and file:line** from a rolling sampling profiler.
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
              perf.jsonl              incident records, append-only
              clusters.json           one cause = one cluster
              census.json             per-entity cost census (tier 1+)
              fixes.jsonl             the fix ledger: issue → solution, commit, MEASURED before/after
              budgets.json            YOUR limits (the one human-authored file)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   Claude Code (agent)     in-game debugger (human, OPTIONAL)
   woken on new incidents;  Session · Timeline · Fixes — this tab's
   reads, fixes, verifies,  incidents + a note box; p95/draw calls/
   records each fix         hitches over time; every fix's before/after
```

Showing the work is part of the loop: after a verified fix the agent runs
`sloptimize fix --title … --issue … --solution … --commit <sha>`, and the
record's before/after are two **measured** windows of the ledger (previous
build vs new build) — not numbers the agent typed. The debugger's Fixes tab
and `sloptimize history` read that ledger back.

## Install

```bash
npm i -D sloptimize        # in your game repo
# or one-off: npx sloptimize attach --launch http://localhost:3000
# or from a checkout: node sloptimize/bin/sloptimize.mjs … (bare Node, no install)
```

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

Tier 2 (scene census, per-entity attribution, measured bisection) layers on
top where the engine grants scene access — see `docs/SPEC.md` §4.

## Claude Code integration — the whole point

This repo IS a Claude Code plugin. One install:

```bash
claude --plugin-dir node_modules/sloptimize    # after npm i -D sloptimize
claude --plugin-dir /path/to/sloptimize        # from a checkout
# or via marketplace: /plugin marketplace add m0dE/sloptimize && /plugin install sloptimize
```

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
  `record_fix`, and `attach_start` / `attach_stop` for the live tier.

For instant wakeups (the agent starts fixing ~20s after the stutter, no
prompt needed), arm `sloptimize watch` as a session Monitor — one line, in
`docs/INTEGRATION.md` §5. Wire it into a `SessionStart` hook and every
session arms it by itself.

## Budgets: "fast enough" as an exit code

`.sloptimize/budgets.json` (the one file a human reviews):

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

```bash
npx sloptimize check              # exit 0 inside · 1 breached · 4 unmeasured
```

That exit code is what lets an agent self-iterate in a loop that terminates.

## CLI

```
sloptimize report        current profile + incidents + census hints
sloptimize check         budgets → exit code (--counters-only for CI)
sloptimize census        per-entity costs + closed-vocabulary hints
sloptimize history       the timeline: p95 / draw calls / hitches per time
                         bucket and per build, plus the fix ledger
sloptimize fix           record a verified fix (title, issue, solution,
                         commit) with MEASURED before/after windows
sloptimize attach        tier-0: --launch <url> [--headless] [--port N]
sloptimize hook-status   the prompt hook's ≤5-line ambient surface
sloptimize issues        the catalogue: every incident grouped by FOOTPRINT
                         (cause + situation, never time) — how often, how
                         recently, which fixes were applied; --fp <id> for one
sloptimize watch         the push channel: one stdout line per usermark /
                         ≥100ms hitch / gpu cap-hit / coordinate jitter /
                         feed dark, each with fp=<id> ×N; never exits
sloptimize doctor        what is wired, what is degraded, stated limits
```

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
