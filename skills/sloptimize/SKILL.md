---
name: sloptimize
description: Use when investigating or fixing rendering performance in a three.js game instrumented with sloptimize — reading .sloptimize/ evidence, classifying hitches, attributing cost, and verifying fixes by measurement.
---

# The sloptimize loop

**Never claim a performance fix without a measured before/after.** A fix
without one is a hypothesis.

The playbook, in order:
1. `sloptimize report --dir <game>/.sloptimize` — the current profile,
   recorded hitches (each classified WITH evidence), usermarks (the human's
   Ctrl+F11 "it felt wrong here" captures), and census hints.
2. Classify before touching code: shader-compile / texture-upload /
   spawn-burst / long-render / long-script / gc-or-upload-by-elimination.
   The record's `evidence` string says why the guess exists.
3. `sloptimize census` — per-entity meshes/triangles/materials/shadow
   casters, plus the closed hint vocabulary (instancing-candidate,
   material-dedup-candidate, oversized-texture, undisposed-suspect).
4. ONE change at a time.
5. Verify: counters (draw calls, triangles, programs) compare EXACTLY on any
   renderer, including software rasterizers. Timing numbers only count in
   `regime: hardware`; never quote a timing from a `software` regime.
6. `sloptimize check` against `.sloptimize/budgets.json` — "fast enough" is
   an exit code, and distance-to-budget is part of every verdict you report.
7. Record the fix once the new build has ledger evidence:
   `sloptimize fix --title "…" --issue "…" --solution "…" --commit <sha>`
   (MCP: `record_fix`). The before/after are measured windows of the
   ledger — previous build vs new build by default — never numbers you
   type. `sloptimize history` and the debugger's Fixes tab show it; that is
   how the human sees what the loop bought.

The fix loop (git only): a verified fix is PROPOSED, never pushed to main —
`sloptimize fix propose --title "…" --issue "…" --solution "…"` turns the
working tree (or the current branch) into a `sloptimize/<slug>` branch plus
a ledger entry the debugger's Fixes tab lists with merge/reject. Read
`sloptimize policy` first: `propose` means stop there; `merge` means
`sloptimize fix merge <id>` yourself once the tests are green. A repo
without git says so — nothing to do until `git init`.

↯ jitter records (SPEC §3.6) are the OTHER incident: the unit or the camera
landed off its own trajectory — a `snap` (one displacement, motion resumed
from the new place) or an `oscillation` (frame-to-frame reversals: a
fixed-step sim drawn without interpolation, or two writers on one
transform). This is a correctness incident, not a timing one — census and
counters will not explain it. Read the record: `track`, `jump` per axis (a
vertical-only jump is a step or a ground snap; horizontal is a correction
or a teleport), `speed`, `dtMs`, `coincident`, `reach`. `reach-change` =
the camera's boom clamped or zoomed; `follows-track` = the camera was a
passenger — work the unit's record; `long-frame-catch-up` = the stall it
rode is the incident (already woke as a hitch). Find the writer of that
transform in that phase and fix the discontinuity at its source. Verify
with `sloptimize history` (jitters/h before → after) and a played session
— never by raising the floor.

Push channel: if a `sloptimize watch` Monitor is armed in this session,
its lines (★ usermark / ⚡ hitch / ⏳ gpu / ◌ feed quiet) arrive as
notifications; each one starts this playbook unprompted at step 1.

Trust rules: census estimates are estimates (the field names say so); an
absent field means unmeasured, never zero; `long-script` hitches escalate to
a CPU profiler (Chrome DevTools), per-draw GL state to Spector — sloptimize
answers WHICH entity, WHICH frame, WHICH workload, only.
