# sloptimize

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
              budgets.json            YOUR limits (the one human-authored file)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   Claude Code (agent)     debugger overlay (human, OPTIONAL)
   woken on new incidents;  incident list + one-line "what
   reads, fixes, verifies   happened" notes, forwarded to the agent
```

## Quickest start: zero integration (tier 0)

Requires only Node 22+ and a Chromium. No game changes, no build changes:

```bash
node bin/sloptimize.mjs attach --launch http://localhost:3000 --headless
# play / drive the game …then:
node bin/sloptimize.mjs report
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
including the three traps that cost the first deployment real time:
**don't gate activation on hostname** (probe your dev endpoint instead),
**give the recorder its own rAF clock** (a game-loop-fed clock is blind to
boot/launch — exactly the windows you care about), and **frameMs must bound
insideRenderMs**.

Tier 2 (scene census, per-entity attribution, measured bisection) layers on
top where the engine grants scene access — see `docs/SPEC.md` §4.

## Claude Code integration — the whole point

This repo IS a Claude Code plugin. One install:

```bash
claude --plugin-dir /path/to/sloptimize        # dev / local
# or once published: /plugin marketplace add <repo> && /plugin install sloptimize
```

That carries three surfaces into every session:
- **Skill** — the doctrine: read → classify → census → ONE change → verify
  with counters; never claim a perf fix without a measured before/after;
  never quote timing from a software regime.
- **Prompt hook** — silent by default; when a NEW keyframe or budget breach
  exists, up to five lines land in the agent's context on your next prompt.
- **MCP server** — `get_report`, `check_budgets`, `attach_start`,
  `attach_stop` for the live tier.

For instant wakeups (the agent starts fixing ~20s after the stutter, no
prompt needed), arm a session Monitor over `perf.jsonl` — the ~30-line
recipe is in `docs/INTEGRATION.md` §5.

## Budgets: "fast enough" as an exit code

`.sloptimize/budgets.json` (the one file a human reviews):

```json
{ "perf.budget.draw_calls": 400, "perf.budget.frame_ms_p95": 16.7 }
```

```bash
node bin/sloptimize.mjs check     # exit 0 inside · 1 breached · 4 unmeasured
```

That exit code is what lets an agent self-iterate in a loop that terminates.

## CLI

```
sloptimize report        current profile + incidents + census hints
sloptimize check         budgets → exit code (--counters-only for CI)
sloptimize census        per-entity costs + closed-vocabulary hints
sloptimize attach        tier-0: --launch <url> [--headless] [--port N]
sloptimize hook-status   the prompt hook's ≤5-line ambient surface
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
