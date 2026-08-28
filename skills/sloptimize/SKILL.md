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

Push channel: if a `sloptimize watch` Monitor is armed in this session,
its lines (★ usermark / ⚡ hitch / ⏳ gpu / ◌ feed quiet) arrive as
notifications; each one starts this playbook unprompted at step 1.

Trust rules: census estimates are estimates (the field names say so); an
absent field means unmeasured, never zero; `long-script` hitches escalate to
a CPU profiler (Chrome DevTools), per-draw GL state to Spector — sloptimize
answers WHICH entity, WHICH frame, WHICH workload, only.
