# sloptimize v2 — the incident pipeline (supersedes the first attach draft)

Status: draft for approval. Amends SPEC.md. Rewritten after the operator
corrected the frame twice, and both corrections are load-bearing:

1. *"Your job is to report data to Claude Code so it can proceed with
   optimization — remember which gaps you're filling."*
2. *"It logs incidents automatically in the background; the debugger is
   optional and shows the list; all of it is fed to Claude Code."*

---

## 0. Mission, restated as the contract

The agent cannot watch, cannot localize, cannot verify. sloptimize is the
agent's senses and ruler — nothing more. Every feature below must resolve
to one of the three gaps, or it is scope creep:

| gap | what fills it |
|---|---|
| MEASURE — the agent will never feel a hitch | incidents recorded automatically, before anyone asks |
| ATTRIBUTE — "it stutters" is not a work item | every incident carries its classification, evidence, and (by tier) stacks/entities |
| VERIFY — an unmeasured fix is a hypothesis | exact counters, before/after windows, budgets with exit codes |

The tool decides what is true; the agent decides what to try; the human
plays. Any design that asks the human to operate instruments, or asks the
agent to trust prose, violates the contract.

## 1. First principles: the incident

An **incident** is a frame (or run of frames) where time went somewhere
the frame needed. There are only four somewheres, each with the one
instrument that names it:

| where | field example | naming instrument | tier |
|---|---|---|---|
| main-thread JS | warm sweep, 165–305ms | sampling JS profile over the window → function names | 0 |
| GPU process | 8.4s page-load freeze (no rAF, no long task, no counter) | queue latency + creation ledger with call stacks | 0 |
| scene structure | uninstanced 200-mesh group | census / measured bisection → entity names | 1–2 |
| game logic | launch playing under the battleground | NOT an incident — a correctness bug; out of scope, said out loud | — |

Corollary: **detection is threshold math; attribution is per-somewhere.**
A pipeline that detects everything but attributes nothing (our first
field build: `long-script`, 14ms inside render, full stop) makes the
agent guess — the exact failure this product exists to end.

## 2. The pipeline

```
detect (always on) → classify+attribute → deliver ┬→ agent   (push: wake with evidence; pull: files/CLI)
                                                   └→ human   (OPTIONAL debugger: the incident list + one-line annotation)
→ agent changes ONE thing → verify (counters/bench) → ledger
```

- **Detect**: relative + absolute thresholds (2× median, 1.5× budget),
  rate-limited with loud drop counts. No keypress anywhere in this stage.
- **Deliver to the agent** is the primary edge. Push: incident → agent
  wakeup with the classification attached (MCP notification when
  packaged; a session Monitor until then). Pull: `.sloptimize/` files +
  CLI with exit codes — works headless, in CI, and after the fact.
- **Deliver to the human** is a MIRROR, not a transport: opening the
  debugger shows what already shipped (list: when, how long, why;
  manual keyframes starred) and offers one text line — semantics only a
  human has. The mirror must never claim more than the pipe did: rows
  read "sent", meaning *landed in the sink*; whether an agent session is
  currently consuming the sink is not the page's claim to make.
- **Verify** closes the loop: counters compare exactly on any renderer;
  timing only within its regime; verdicts land in the append-only ledger
  so a reverted strategy is never retried.

## 3. Tiers of sensing (progressive precision, none required to start)

- **Tier 0 — attach** (`sloptimize attach [--launch <url>]`): CDP;
  injected recorder; rAF timing; graphics-API wraps (draws, triangles,
  pipeline creations WITH `Error().stack`, uploads, queue latency);
  rolling sampling profiler (~1–3% dev overhead) so every `long-script`
  incident carries `topFrames`. Zero game code. Chromium-only, dev-only.
- **Tier 1 — in-page feed**: the game hands engine-true numbers
  (`rec.frame(...)` at its stats site — one line) and ships the recorder
  ambient with every dev session, no attach needed. Exact
  insideRenderMs, spawn deltas, engine tags.
- **Tier 2 — engine/slopjs**: census, entity attribution, measured
  bisection, snapshot repro of a keyframe's workload.

Every number carries its tier and regime; a tier-0 approximation never
poses as a tier-1 measurement.

## 4. Critical review (of this spec, including against its own drafts)

**Fixed since draft 1:**
- Draw-call counting was the wrong headline; the rolling profiler is the
  prize — it attributes the class of freeze (`long-script`,
  unexplained) that the field deployment recorded a dozen times and
  could never name.
- The human's role was over-weighted (Ctrl+F11 as a pillar). Corrected:
  auto-first; the debugger is an optional mirror + annotation channel.
- "Sent to Claude Code" is now specified as *sink-landed*, because the
  UI must not assert a live consumer it cannot see.

**Standing weaknesses, stated:**
- **Operator's everyday browser**: attach needs a debug port; ambient
  always-on coverage of the human's normal play is tier 1's job, which
  costs one line of game code. Zero-code AND ambient-for-the-human is
  not achievable simultaneously; the spec stops pretending otherwise.
- **Correctness bugs** (most of what the field ticket actually fixed)
  are invisible to every tier. The doctrine must route "it looks/behaves
  wrong" reports away from the profiler before anyone burns a loop on it.
- **Incident flooding / identity**: a recurring root cause fires
  incidents forever. Rate limits bound volume but not repetition;
  clustering (same classification + same top frame ⇒ same incident id,
  count incremented) is REQUIRED in v2 so the agent investigates a cause
  once, not per occurrence. New in this draft; unimplemented.
- **Profiler observer effect**: 1–3% steady overhead plus GC from stack
  sampling. Bounded and labeled (`profiled: true` on the window) so a
  profiled p95 is never compared against an unprofiled one.
- **Attribution ceiling at tier 0**: draw calls cannot be attributed to
  entities from the API (in three, every draw shares one internal call
  site). Entity work items require tier ≥1. The table in §1 is honest
  about which somewhere needs which tier.
- **Trust**: an injected recorder and a writable sink are spoofable by
  anything local. Unchanged posture from SPEC §9 — price and expose,
  don't pretend to prevent.

**Will it resolve the issues this ticket actually dealt with?**

| issue | verdict |
|---|---|
| random unattributed freezes | YES — this spec's center of mass; profile stacks name the function |
| 8.4s page-load freeze | YES (diagnosis) — queue latency + creation stacks discriminate; the fix follows what they name |
| descent-entry compile stutters | YES — creation stacks replace the bespoke attribution probe |
| warm-sweep stalls | YES — stacks ≥ hand tags |
| launch logic bugs | NO — out of scope by principle, forever |

## 4.1 Dogfood verdict (tier 0 against the real game, zero integration)

`sloptimize attach --launch http://127.0.0.1:4477/?play&launch --headless`
against mecharoyale (1.4MB minified bundle, WebGL2 fallback on the QA
box): 35 hitches recorded, every one attributed and clustered — the
software rasterizer's real costs by name (`bufferSubData` ×7,
`getUniformBlockIndex` ×6), three.js internals (`_setupBindings`,
`update`), and one game function. Two limits surfaced and kept:

- **Minified names**: the game frame arrived as `O_e@game.min.js` — the
  pipeline works, but human-readable attribution in bundled games needs
  sourcemaps served with the dev build. Doctrine: turn sourcemaps on in
  dev, or accept minified names as cluster keys (they are stable per
  build, so clustering still holds).
- **API coverage follows the backend**: `gpu-create` records require
  WebGPU; on a WebGL2-fallback page the WebGL draw wraps carry the
  counters and creation stacks are absent (honestly, not silently).

## 5. Milestones

- **M-A0 attach MVP** — **SHIPPED, exit criterion measured**: on the
  zero-integration fixture the seeded freeze is attributed
  `seededFreezeWork@seeded-freeze.html:5` from the written record alone
  (test/attach-e2e.mjs; unit tier in test/attach.test.js).
- **M-A1 incident identity** — **SHIPPED with a measured limit**: repeats
  merge into an existing cause when its identifying frame appears in the
  new hitch's top-3 (fixture: 3 occurrences → 2 clusters). The measured
  limit, recorded rather than papered over: V8 INLINING can erase the
  leaf frame between occurrences (freeze #1 named the function, #2
  arrived as its caller), so a cause can still split across an
  optimization boundary. Deopt-aware matching is deferred until a real
  case demands it.
- **M-A2 plugin packaging** — **SHIPPED (structure + live tier)**: the
  repo IS the plugin (`.claude-plugin/plugin.json` at root, so `bin/` and
  `src/` travel with any install), carrying the doctrine skill, the
  silent-by-default UserPromptSubmit hook via `${CLAUDE_PLUGIN_ROOT}`,
  and a dependency-free stdio MCP server (`get_report`, `check_budgets`,
  `attach_start`, `attach_stop`) protocol-smoked over real JSON-RPC.
  Install: `claude --plugin-dir <path-to-sloptimize>` in dev; marketplace
  add once published. The exit criterion's PUSH half (agent woken by
  incident with zero project files) still rides the session Monitor —
  server-initiated MCP wakeups are not yet a documented host contract,
  recorded here as the remaining gap rather than claimed.*
