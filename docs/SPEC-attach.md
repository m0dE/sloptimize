# sloptimize attach — v2 spec (the zero-setup tier), with its own critical review

Status: draft for approval. Amends SPEC.md; where they disagree on the
recorder's delivery, this document wins. Written after one full field
deployment (mecharoyale), so every claim below is checked against the
bugs that deployment actually chased.

---

## 0. First principles

A freeze is time spent somewhere the frame needed to be. There are only
four somewheres, and each demands a different instrument:

| where the time went | example from the field | instrument that names it |
|---|---|---|
| main-thread JS | warm sweep blocking 165–305ms | a **sampling JS profile** covering the hitch (function names) |
| GPU process | 8.4s page-load freeze: no rAF, no long task, no counter moved | **queue latency** (`onSubmittedWorkDone`) + a **creation ledger** with call stacks |
| the pixels' meaning (logic) | launch playing invisibly under the battleground | game-state observability (beat trails) — **not a profiler's job** |
| scene structure | 200 unbatched meshes | census + attribution (engine access required) |

Principle: **instrument the layer that owns the answer, and own no layer
you don't need.** Draw calls live in the graphics API. Function names
live in the VM. Entity names live in the engine. A profiler that demands
engine integration to count draw calls is charging the wrong toll.

## 1. Critical review of the attach idea (what survives scrutiny)

Claimed: attach over CDP → zero game code, works on any project.

**Survives:**
- Draw/triangle/pipeline/upload counting via API prototype wraps is
  engine-free and exact. Verified in the field: our GPUDevice/GPUQueue
  wrappers were already engine-free; only their *delivery* was coupled.
- CDP gives the one thing our field deployment lacked and paid for in
  probe rounds: a **continuous sampling JS profiler** (`Profiler.start`,
  ~1–3% overhead in dev). Every `long-script` hitch we recorded said
  "frame 4805ms, 14ms inside render" and stopped there; with a rolling
  profile, the same record carries the top-of-stack function names for
  its window. That is strictly better than our hand-planted
  `noteStallActivity` tags — tags name what someone remembered to tag,
  stacks name everything.
- Creation-site attribution without the engine: capture `Error().stack`
  inside the `createRenderPipeline`/`createShaderModule` wrap (creations
  are rare; the cost is nil). Through sourcemaps, that names the caller —
  which is what our descent fix needed a bespoke probe to learn.
- The activation-bug class (hostname gates, ingest probes, arming
  order — three real field bugs) disappears: attaching *is* activation.

**Does not survive (stated, not papered over):**
- **The operator's normal-play browser.** CDP needs a debug port. "I
  just play" in the user's everyday Chrome does not include a debug
  port. Mitigation, not solution: `sloptimize open <url>` launches their
  normal profile with the port; the in-page tier (below) remains the
  ambient always-on path. Attach is the *agent's* tier and the
  *first-contact* tier, not the replacement for the ambient one.
- **Correctness bugs.** Most of what this field deployment fixed (a
  pixel race, a killed clock, a sea-level seed) no profiler finds. Those
  needed game-state observability. sloptimize resolves *performance*
  freezes; it must say so, or it will be blamed for the other kind.
- **insideRenderMs** needs the engine's render call bracketed; tier 0
  approximates it from the draw-call timestamps inside a frame and
  labels it `approx`.
- Chromium-only, dev-only. Already the spec's posture; unchanged.

## 2. The tiers (progressive precision, none required to start)

- **Tier 0 — attach.** `sloptimize attach [--launch <url>]`: CDP
  session; injects the recorder (rAF timing + API wraps + rolling JS
  profile); streams records back over a CDP binding; writes the same
  `.sloptimize/` files. Zero game changes. Hitch records gain
  `topFrames` (from the profile) and pipeline creations gain
  `createdAt` stacks.
- **Tier 1 — in-page feed.** What mecharoyale runs today: the game
  calls `rec.frame(...)` with engine-true numbers (exact
  insideRenderMs, renderer.info, spawn deltas) and ships ambient with
  the game to every dev session. Highest fidelity, always-on, no
  attach needed.
- **Tier 2 — engine/slopjs.** Census, entity attribution, measured
  bisection, snapshot repro. Unchanged from SPEC.md §4–5.

Verdicts carry their tier; a tier-0 number never silently poses as a
tier-1 one (the regime-labeling rule, extended).

## 3. Packaging

A Claude Code plugin: the skill (doctrine), the prompt hook, and an MCP
server owning attach + the push channel (hitch → MCP notification →
agent wakes; replaces the hand-rolled session Monitor). Install once per
machine; per-project setup is zero (tier 0) or one frame-feed line
(tier 1).

## 4. Will this resolve the issues we actually dealt with?

Checked against the ledger of this ticket, honestly:

| issue | would attach-tier sloptimize have resolved it? |
|---|---|
| random in-match freezes (`long-script`, unattributed) | **Yes** — the rolling JS profile names the functions in the hitch window; this is the class the current tooling still cannot attribute. |
| 8.4s page-load freeze (off-loop, invisible to JS) | **Yes, the diagnosis** — queueDone latency + creation ledger with stacks discriminates GPU-compile vs upload vs other; the fix still depends on what it names. |
| descent-entry compile stutters | **Yes** — creation stacks would have named the shadow-pass site without the bespoke attribution probe. |
| warm-sweep stalls | **Yes** — profile stacks ≥ hand tags. |
| launch sequence broken (race/choreo/seed) | **No.** Logic bugs. Game-state observability found them and remains outside a profiler's honest scope. |
| profiler dark on the operator's machine | **Yes by construction** for attach; tier 1 keeps the server-probe activation fix. |

## 5. Milestone

**M-A0**: `attach` MVP — CDP connect/launch, injected recorder, API
wraps + rolling profiler, `.sloptimize/` output, `topFrames` in hitch
records, creation stacks. Exit criterion: on a game with ZERO
integration, a seeded `long-script` freeze is attributed to its function
by file:line from the written record alone.
