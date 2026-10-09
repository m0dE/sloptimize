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
- **Attribute honestly**: a function names a hitch's cause only when its
  self time is ≥10% of the frame (`ATTRIBUTE_MIN_SHARE`); below that the
  record keeps its `topFrames` (each with `share`) and `sampled` (the
  chunk's JS / GC / native / idle ms) but reads `unattributed: 'low-share'`
  and clusters on the verdict alone. (Field report: a 687.5 ms frame
  printed `top _aStarLoop 11.2ms` — 1.6% — and nearly sent an agent to
  optimise A*.)
- **Attribute from the frame's own samples**: a hitch carries `frameSpan`
  (its interval on the page's `performance.now()` clock). Once per document
  the pipeline maps that clock onto the sampler's — a `performance.now()`
  read batched on either side of a `Profiler.stop`, kept when the two reads
  fall within 20 ms — keeps the last 4 chunks, and cuts each hitch out of
  them by sample time: `profileWindow: 'frame'`, `frameSampledMs`, and
  shares that are the frame's own. A stop cannot cut a frame where it ends
  (it waits for the page's current task: a stop sent 300 ms into a 2 s task
  is answered at 2 s), so with long frames back to back the chunk a hitch
  rotates holds the NEXT frame too and reading chunks makes every
  attribution one frame late; slicing ends that. No mapping, or a slice
  under half the frame: the chunk, as before (`rolling-chunk`). Stop and
  start are sent together — awaited in turn, the start waited out the next
  task and left every frame after a rotation unsampled.
- **Name the line**: each `topFrames` entry carries `lines` — `[{line,
  share}]`, the function's self ticks by 1-based source line from V8's
  `positionTicks`, ≥5% each, top 3 (omitted when the only line is the
  function's own: a minified bundle's line 1). A function V8 inlined into
  its caller samples as the caller, and its line is the call site. The
  run file keeps the same per-line ticks for each phase's 25 heaviest
  functions, and `report` prints the run's heaviest self time with them.
- **Do not give up on the longest frames**: a frame of ≥150 ms
  (`ATTRIBUTE_LONG_FRAME_MS`, `attributeLongFrameMs`) ignores the cooldown.
  A load of back-to-back 400 ms frames came back all `unattributed
  (cooldown)` — four worst frames and a 25 s one — and those are the frames
  most worth explaining and cheapest to profile (the frame is already lost:
  a stop is ~1% of 400 ms). Measured on test/fixtures/long-frames.html (12
  back-to-back 300 ms frames, each running a function of its own): before,
  8 of 11 `cooldown` and the 3 attributed named a neighbour's function;
  after, 12/12 from their own samples, each naming its own function
  (test/long-frames-e2e.mjs).
- **The restart is the cost, so the profiler is anchored** (0.10.1). 0.10.0
  argued the exemption safe by sizing the STOP (~2 ms) and missed the START:
  with no profile running, V8 walks the whole heap to log every compiled
  function — 35 ms at 16 MB, 270 ms at 158 MB, 1069 ms at 629 MB. A 9000-car
  traffic sim attached at 520 ms frames against 60 ms unattached (the app's
  own frame timer unmoved at 45–49 ms, the time "native"): each restart made
  the next frame long, which restarted the profiler again. So the pipeline
  keeps an ANCHOR profile running (the console's `profile()`, through
  `Runtime.evaluate` with the command-line API; re-started when a document
  arms — a navigation ends it — and replaced every 5 min so its samples stay
  few; one per worker too), and a rotation's start then costs ~1 ms
  (865 ms → 1 ms on a 513 MB heap). Every start is TIMED (the gap between
  the stop's reply and the start's): one over 25 ms re-anchors; if it stays
  expensive the cooldown and the window stretch to 50× it (the recorder
  under 2% of the run) and a long frame skips the cooldown only at 10× it.
  The run file's `recorder` block (restarts, total and longest ms, anchored)
  is printed by `report`, loudly past 2% of the run or 50 ms a restart.
  test/heavy-heap-e2e.mjs (a 400 MB heap, 40 ms frames): 0.10.0 ran at a
  583 ms rAF median with 45 hitches in 30 s; anchored, 33 ms and 4, the
  longest restart 0.3 ms.
- **Watch the instances**: the recorder defines `__THREE_DEVTOOLS__`
  before page scripts (listening on an existing one instead), so every
  three.js `Scene` announces itself; every 120 frames it checks visible
  InstancedMeshes for slots inside `.count` neither written through
  `setMatrixAt` nor changed for 5 checks while other slots move, and emits
  `instance-slots` (an incident, footprint `instance-slots|phase|mesh`),
  plus one clearing record when they go. Verified against three.js 0.183
  in headless Chromium: a cull that stopped writing 95 of 200 slots read
  `95 untouched for 10s`; the fixed page emitted nothing.
- **Keep the whole run**: every profiler chunk (hitch rotation, window
  roll, final stop) folds into `runs/<session>.json` before it is dropped
  — self and inclusive samples per function, per page phase, plus the
  tier-0 frame windows. `touched` reads it to say whether the changed
  files received any sample; `compare` reads it for per-run function
  shares and the machine-vs-code composition check.

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
- **Detection has an absolute arm**: in the page, a frame is a hitch
  above 2× the rolling median (and the `--min-hitch-ms` floor, 25 ms by
  default) once the ring holds 60 frames — OR above 200 ms (never below
  the floor) regardless of the median and the ring. The relative arm
  alone was blind to a load, learned in the field: attach reloads the
  page, a boot-time restore spends its first seconds in a handful of
  multi-second frames, and a 12-second city load never put 60 frames in
  the ring — zero hitches, a ledger that read as "nothing went wrong". A
  phase slow long enough to fill half the ring also lifts the median past
  its own spikes; the absolute bar does not move.
- **Profiler observer effect**: 1–3% steady overhead plus GC from stack
  sampling. Bounded and labeled (`profiled: true` on the window) so a
  profiled p95 is never compared against an unprofiled one. The bound is
  mechanical, learned in the field (a mid-size three.js game, ~350 draws
  and ~450 simulated cars, ran at 12 fps under attach with its own loop
  still at 6–9 ms): the sampler runs at 10 ms, a hitch rotates it only
  when the stall is ≥80 ms and no rotation ran in the last second of page
  time (a frame of ≥150 ms ignores the cooldown, §2), and an unread
  window rolls itself over every 10 s. A hitch the
  gate skips is still recorded, marked `unattributed: below-floor |
  cooldown`, and counted onto the next attributed record as
  `skippedSinceLast` — the §2 "rate-limited with loud drop counts",
  applied to attribution. Without the gate the rotation's own cost made
  the next frame a hitch, which rotated again, and the records minted in
  that state named whatever the sampler had stalled.
- **A second CDP client**: DevTools open on the same target is another
  session on the same main thread; measured at ~25 ms per frame on the
  game above. Close it while attach records, or read its numbers as
  "with DevTools".
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
