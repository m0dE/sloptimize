# Integrating sloptimize into a game (and its Claude Code session)

What the mecharoyale deployment wired, generalized. Five pieces; each is
small, and the first three are enough to be useful.

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
  preview proxy looks like production. Probe the ingest endpoint once at
  boot; a 204 arms everything, anything else stays dark.

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

In the session, arm a persistent Monitor polling `perf.jsonl` with a byte
cursor (~20s), emitting one line per new usermark or ≥100ms auto-hitch
(SPEC §8.1.1; mecharoyale's exact script is in its session history — 30
lines of python). The operator then just plays: auto-detected hitches and
Ctrl+F11 notes wake the agent with the classification attached.

## Porting cost, measured once

mecharoyale (149k-line client, esbuild, WebGPU, no vite): runtime file
~250 lines, server endpoint ~100 + tests, build-resolution plugin ~15,
one `rec.frame(...)` call at the existing stats site, settings + skill
copies. One session end to end, including the mistakes this doc exists
to save you from (hostname gating, arming inside an on-demand function,
frameMs not bounding insideRenderMs).
