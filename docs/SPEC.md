# sloptimize — founding specification

Status: **v0 draft, pre-implementation.** This is the buildable contract
derived from the strategy work in the slopjs repo
(`docs/performance-strategy.md`, branch `ticket-ebf515b9`), which carries the
full evidence base and citations. Where this document and that one disagree,
this one wins — it is newer and more specific.

The one-sentence product: **give a coding agent the three verbs it measurably
cannot perform alone — measure, attribute, verify — against a running
three.js game, and make the loop terminate.**

---

## 0. Design principles (the spec in miniature)

Every decision below derives from six principles. When a future feature
request conflicts with one, the principle wins or this section gets amended
first.

1. **The agent can never watch, so the game must remember.** Token cost and
   loop latency make live observation impossible at any price. All evidence
   is recorded before anyone asks, to disk, in schemas sized for a model's
   context.
2. **Verdicts, not dashboards.** Every agent-facing surface is
   non-interactive, machine-readable, and exit-code-meaningful. A number that
   requires a human glance to interpret is dead weight.
3. **Attribution over aggregation.** A global counter ("940 draw calls") is
   the starting point, never the answer. Every metric must resolve toward a
   `track()` entity id, and through it toward a construction site in source.
4. **Never conclude past the evidence.** Truth grades on every measurement,
   noise floors on every comparison, "no detectable change" as a first-class
   result, and stated limits instead of degraded guesses.
5. **The ruler is not the agent's to hold.** Measurement runs outside the
   agent's write path; what cannot be prevented (a local agent can edit
   anything) is made expensive and visible instead.
6. **Own the protocol, borrow everything else.** three.js counts
   (`renderer.info`), stats-gl times the GPU, Chromium runs the frames,
   Chrome DevTools profiles functions, Spector captures draw state. sloptimize
   owns identity-attached measurement and the loop — nothing else.

---

## 1. Architecture

Five components, one product:

```
game (browser) ──┐
                 │  in-page runtime: recorder, census, attribution
                 │  (src/, injected or imported; reads @slopjs/inspector ctx)
                 ▼
vite plugin  ────►  .sloptimize/  on disk  ◄──── CLI (bin/sloptimize.mjs)
(vite/plugin.js)    the agent's reading room     bench, check, attribute, doctor
                 ▲
                 │  MCP server (mcp/) — live tools against the paused world
                 └  launched Chromium (bench only, optional)
```

- **In-page runtime** — samples frames, maintains the ring buffer, detects
  hitches, walks the scene for the census, executes bisection while paused.
- **Vite plugin** (`sloptimize/vite`) — dev-only (`apply: 'serve'`), exposes
  `/__sloptimize/*` endpoints, lands payloads in `.sloptimize/`. Composes
  with `@slopjs/inspector/vite`; requires it in v0 (see §2).
- **CLI** — `sloptimize check|bench|attribute|report|doctor`. The commands an
  agent runs in its shell; also the hook's substrate.
- **MCP server** — optional, stdio, for the live paused-world tier.
- **Files** — the primary agent interface. File-first, tools-second, same as
  slopjs: a hook or a `Read` needs no protocol.

### 1.1 Directory layout on disk (in the game project)

```
.sloptimize/
  profile.json          rolling summary: current medians, p95, counters, regime
  perf.jsonl            hitch records, append-only
  census.json           per-entity cost census, from the last walk
  bench/<name>.json     one bench run, by snapshot name + timestamp
  bench-history.jsonl   the ledger: every bench comparison ever, append-only
  goldens/<name>.png    correctness-gate reference frames (gitignored)
budgets: in the game's source, via tune('perf.budget.*') — see §7
```

`perf.jsonl` and `bench-history.jsonl` are **not** gitignored (they are the
audit trail); `goldens/` and `bench/` are.

---

## 2. Platform contract with `@slopjs/inspector`

sloptimize peer-depends on the inspector and consumes only public or
to-be-published surfaces. v0 requires the inspector's vite plugin to be
present (it supplies the pause, the IDs, the bridge security model). The
**platform asks** — small additions the inspector must grow, to be proposed
as PRs there, listed here so the dependency is explicit:

| ask | why sloptimize needs it |
|---|---|
| `onFrame(cb)` hook on the render interception (`src/discover.js` wrap) | the recorder's sampling point; called once per `renderer.render` with `{ renderer, scene, camera, timestamp }`. Without it we would re-wrap `render` and fight the inspector's own wrapper. |
| camera state included in `snapshot.capture()` / restored by `restore()` | identical workload requires identical view; today snapshots omit the camera. |
| a documented `captureFrame()` that works while paused | the correctness gate's golden frames; the inspector already solves `preserveDrawingBuffer` timing — expose it. |
| read access to the tracked registry (`all()`, `idOf`, `pathOf` — already exported) | census attribution to entity ids. Already public; listed for completeness. |
| `applyOp` visibility ops honored while paused with a forced re-render | measured bisection = toggle, re-render, read `renderer.info`. |

Until an ask lands upstream, the corresponding sloptimize feature ships
degraded and says so in `sloptimize doctor` (principle 4) — it does not
monkey-patch around the inspector.

---

## 3. The flight recorder

### 3.1 Sampling

- Source: the `onFrame` hook (§2). Per frame, read `performance.now()` delta
  between render calls **and** the wall time spent inside the render call
  (wrap start/end), plus `renderer.info.render.{calls,triangles,points,lines}`,
  `renderer.info.memory.{geometries,textures}`, `renderer.info.programs.length`.
- Cost budget: **≤ 0.2ms per frame, zero allocations on the steady path**
  (pre-allocated ring slots; strings only at flush time). The recorder must
  never be the hitch it reports.
- Ring buffer: 600 frames (~10s at 60fps) of full samples, in memory, always
  on while the plugin is active — panel open or closed, paused or running.
  Pause state is recorded per sample (`paused: true` frames are excluded from
  budget checks but kept for continuity).
- Flush: every 2s (aligned with the inspector's refresh throttle), write
  `.sloptimize/profile.json` — the rolling summary, not the ring.

### 3.2 `profile.json` (rolling summary)

```json
{
  "at": "2026-08-23T12:00:00.000Z",
  "regime": "hardware",            // "hardware" | "software" | "unknown" — see §6.4
  "window": { "frames": 600, "seconds": 10.4 },
  "frame": { "medianMs": 8.1, "p95Ms": 15.2, "insideRenderMs": 4.2, "fps": 60 },
  "render": { "calls": 940, "triangles": 1200000, "points": 0, "lines": 12 },
  "memory": { "geometries": 312, "textures": 48, "programs": 17 },
  "budgets": { "checked": 3, "breached": ["perf.budget.draw_calls"] },
  "paused": false
}
```

A field the runtime cannot measure is **absent**, never `0` (the inspector's
em-dash rule, inherited as JSON absence).

### 3.3 Hitch detection and `perf.jsonl`

A hitch is a non-paused frame whose delta exceeds
`max(2 × rolling median, budget frame ms × 1.5)` — relative and absolute
guards together, so a 30fps-by-design game does not report every frame. Per
hitch, append one record:

```json
{
  "type": "hitch",
  "at": "2026-08-23T12:00:01.100Z",
  "frame": 8412,
  "frameMs": 41.0,
  "medianMs": 8.1,
  "insideRenderMs": 6.0,
  "delta": {
    "calls": +12, "triangles": +48000, "programs": +3, "textures": +2,
    "geometries": 0
  },
  "world": {
    "spawned": ["enemy_17", "enemy_18", "auto:mesh_1f2a"],
    "removed": [],
    "camera": { "position": [4.1, 12.0, -30.2], "quaternion": [0,0.7,0,0.7] },
    "inputsHeld": ["KeyW", "Mouse0"]
  },
  "classification": {
    "guess": "shader-compile",
    "confidence": "medium",
    "evidence": "programs +3 in the hitch frame"
  },
  "snapshotRef": "hitch-8412"        // present iff auto-snapshot succeeded, §5
}
```

Classification vocabulary (closed set, extensible only by spec change):
`shader-compile` (programs delta > 0), `texture-upload` (textures delta > 0,
programs 0), `spawn-burst` (spawned length above threshold),
`gc-or-upload-by-elimination` (no counter moved), `long-render`
(insideRenderMs dominates), `long-script` (frame delta dominates,
insideRenderMs small). Multiple guesses allowed, ranked. `confidence` is
`low | medium | high` and the `evidence` string is mandatory — a guess
without its reason is banned by principle 4.

Rate limit: at most 1 record per second and 500 per session; when the limit
truncates, the *last* record of the session says how many were dropped
(silence must mean nothing was dropped — the inspector's selection-block
rule, inherited).

### 3.5 Usermarks — the human's half of hitch detection

The automatic threshold cannot see "it feels wrong": steady-but-low fps,
micro-stutter under the hitch bar, jitter that only a hand on the mouse
notices. So the recorder exposes one more verb:

- `usermark({ windowMs = 5000, note, inputsHeld, world })` — freeze the
  trailing window of the ring into one appended record: window frame count,
  median/p95 over the window, and the **five worst frames ranked**, each with
  its counter deltas and the same closed-vocabulary classification an
  automatic hitch gets.
- The host binds it to a chord (the reference integration uses
  **Ctrl+F11**) and shows a one-line confirmation. The press is the
  human's timestamp; the ring is the evidence; the record is the labeled
  training example an agent can read cold.
- Usermarks share `perf.jsonl` (type `"usermark"`), bypass the 1/s hitch
  rate limit (a human press is already rate-limited by a human), and count
  against the 500/session cap.

This section exists because the product's first field deployment asked for
exactly this, in the operator's words: "whenever a bottleneck or jitter is
detected, I can press a unique shortcut which will save the keyframe and use
all data recorded from the last 5 seconds to identify the bottleneck."

### 3.4 What the recorder does not do

No JS stack sampling (DevTools' job), no per-frame heap snapshots (cost), no
network waterfall. `performance.memory` (Chromium-only) is sampled at 1Hz
solely to support the `gc` classification, and its absence downgrades that
guess's confidence — it never blocks a record.

---

## 4. Census and attribution

### 4.1 Static census (`census.json`)

Produced by a full scene walk on demand (`sloptimize attribute --static`, an
MCP call, or the panel) and after every `inspector check`-style scan; never
per-frame. Per tracked entity (and per auto-tracked node, flagged):

```json
{
  "at": "2026-08-23T12:00:00.000Z",
  "totals": { "calls": null, "meshes": 1240, "triangles": 1200000,
              "uniqueMaterials": 41, "uniqueGeometries": 220,
              "textureBytesEstimate": 182000000 },
  "entities": [
    {
      "id": "gltf_town",
      "meshes": 611,
      "triangles": 604000,
      "uniqueMaterials": 9,
      "uniqueGeometries": 34,
      "sharedGeometryGroups": [
        { "geometry": "auto:geo_a91c", "material": "auto:mat_2210",
          "count": 500, "instanced": false }
      ],
      "textureBytesEstimate": 96000000,
      "castShadow": 611,
      "visible": true,
      "persistent": true
    }
  ],
  "hints": [
    {
      "kind": "instancing-candidate",
      "entity": "gltf_town",
      "detail": "500 meshes share one geometry+material and are not instanced",
      "estimate": { "callsBefore": 940, "callsAfter": 441 },
      "fix": "merge into one InstancedMesh at the construction site of gltf_town"
    }
  ]
}
```

`totals.calls` is `null` in the static census — draw calls are a runtime
fact, and the census does not pretend to know it (principle 4); `profile.json`
carries the measured number.

Hint vocabulary (closed set): `instancing-candidate`,
`material-dedup-candidate` (N materials with identical parameters),
`shadow-caster-light` (shadow-casting point/spot lights, with their map
cost), `undisposed-suspect` (geometries/textures count monotonically growing
across censuses), `oversized-texture` (dimension threshold),
`uncapped-pixel-ratio`. Texture bytes are labeled `Estimate` in the field
name because that is what they are (width×height×format guess, no VRAM
introspection in WebGL).

### 4.2 Measured bisection (`attribute_cost`)

Protocol, executed by the in-page runtime while **paused** (requires the
inspector's pause; refuses to run otherwise with a structured error):

1. Render K frames (default 5), record baseline `renderer.info` counters and
   median inside-render ms.
2. For each candidate (default: top 20 census entities by triangles, or an
   explicit id list): set the entity's root `visible = false` via the
   inspector's own `applyOp`, render K frames, record, restore visibility.
3. Emit per-entity deltas: `calls`, `triangles`, `insideRenderMs` (the last
   marked `noisy: true` when below the measured per-run spread).
4. Restore the world exactly (ops applied through the same `applyOp` path
   means undo history stays coherent; the run ends with a verification that
   post-state === pre-state, and reports if not).

Output ranks entities by measured contribution and carries the caveat as
data, not prose: `"sumsToBaseline": false` — hiding a shadow caster changes
shadow-map cost, batching state shifts; this is a **ranking instrument, not
an accounting identity**, and every consumer (skill, panel) must render that
caveat.

### 4.3 Attribution to source

Every census/bisection row carries the entity id; ids resolve to construction
sites through the inspector's existing writeback tooling (`locate`). The
hint's `fix` string names the site when `locate` finds one, and says
`site: unknown` when it does not — auto-tracked (`auto:`) entities always
say so, with the standing advice to `track()` them.

---

## 5. Hitch reproduction

On a hitch, the recorder requests `snapshot.capture()` (with camera, per the
§2 ask) for the frame `k = 30` frames before the spike, using the snapshot
system's HMR-carry machinery, and saves it as `hitch-<frame>`. The record's
`snapshotRef` names it. Reproduction is then:

```
sloptimize repro hitch-8412          # CLI wrapper, or the MCP equivalent:
  snapshot.load('hitch-8412'); clock.step(35);   # step across the hitch, reading counters
```

**Scope, stated as data:** the repro record carries
`"fidelity": "workload"` — snapshots hold tracked transforms, visibility,
tunables, camera; not physics internals, mixer time, RNG, or spawn queues. A
restore *looks* identical and *evolves* differently. This is strong for
draw/material/fill workloads and weak for simulation-CPU spikes, and the
skill says exactly that. Trajectory-fidelity replay (seeded RNG, fixed
timestep, keyframe chains) is **out of scope for v1** and enters the spec
only if workload repro is demonstrated insufficient on real cases.

---

## 6. The bench

### 6.1 Contract

```
sloptimize bench --snapshot town-square [--frames 600] [--launch] [--json]
sloptimize bench --compare A B [--json]      # or --compare last
```

A bench run: restore the named snapshot (camera included), pin `clock` to a
fixed 1/60s tick, run N frames, discard the first 120 (warmup: shader
compiles, JIT), record per-frame deltas and counters, repeat the whole run R
times (default 3), report per-metric median and p95 across runs plus the
inter-run spread — the **noise floor**.

### 6.2 Output (`bench/<name>.json`)

```json
{
  "name": "town-square",
  "at": "2026-08-23T12:05:00.000Z",
  "regime": "hardware",
  "environment": { "launched": true, "headless": "new", "gpu": "ANGLE (Apple M2)",
                   "configHash": "sha256:9f2c…" },
  "frames": 600, "runs": 3,
  "frame": { "medianMs": 9.1, "p95Ms": 14.8, "noiseFloorMs": 0.9 },
  "render": { "calls": 24, "triangles": 1200000, "programs": 14 },
  "grade": { "counters": "exact", "timing": "hardware" }
}
```

`configHash` covers snapshot content, frame count, runs, viewport, and
pixelRatio — two reports compare only if hashes match, and `--compare`
refuses otherwise (exit 3).

### 6.3 Comparison verdicts

`--compare` emits exactly one verdict per metric and one overall:

- `improved` / `regressed`: the delta exceeds the pooled noise floor.
- `no-detectable-change`: inside the noise floor. **This is a result**, not a
  failure, and the skill maps it to "revert".
- Counters compare exactly (no noise floor — they are deterministic).
- Overall verdict additionally reports **distance-to-budget** for every
  breached budget: `"frame p95 14.8ms; budget 16.7ms: inside"` — because
  agents satisfice, and "improved" without "are we there" invites stopping
  early.

Exit codes: `0` improved-or-inside-budgets, `1` regressed, `2`
no-detectable-change, `3` incomparable, `4` environment failure (no browser,
no snapshot). The codes are API; the skill depends on them.

### 6.4 Truth grades and regimes

- `counters` grade — draw calls, triangles, programs, census: **exact on any
  renderer including SwiftShader.** CI-safe.
- `timing` grade — frame ms, inside-render ms, GPU ms: meaningful only in
  `regime: "hardware"`. Regime detection: `WEBGL_debug_renderer_info`
  unmasked renderer string matched against software rasterizers (SwiftShader,
  llvmpipe); unknown → `"unknown"` and timing is reported but flagged. A
  timing comparison across regimes is refused (exit 3). **An unlabeled
  number is a lie waiting for a model to believe it.**
- GPU ms (optional): via `stats-gl`'s timer-query mechanism when the optional
  peer is installed and the extension exists — Chromium-only, and reported as
  absent elsewhere, never estimated.

### 6.5 The launched browser (`--launch`)

- Default: bench against the already-open dev tab through the plugin bridge
  (the developer's real GPU, zero new dependencies).
- `--launch`: spawn Chromium for an unattended run — required for `/loop`
  and CI. Binary discovery order: `SLOPTIMIZE_BROWSER` env var →
  `playwright-core`'s managed Chromium if the optional peer is installed →
  well-known system paths (the inspector's `verify-zero-config.mjs` CDP
  approach, productized). No browser found → exit 4 with the install hint.
- A launched browser uses a fresh profile, fixed 1280×720 viewport,
  `--disable-extensions`, pinned `devicePixelRatio: 1` — reproducibility
  beats realism for verdicts.
- The whole launcher is **Chromium-only by design**, stated in `doctor`.

### 6.6 The ledger (`bench-history.jsonl`)

Every `--compare` appends one line, machine-written only:

```json
{
  "at": "2026-08-23T12:06:00.000Z",
  "snapshot": "town-square",
  "change": { "ref": "git:1a2b3c4", "description": "instance gltf_town rocks" },
  "before": { "calls": 940, "p95Ms": 21.4 },
  "after": { "calls": 24, "p95Ms": 9.1 },
  "verdict": "improved",
  "budgets": { "perf.budget.draw_calls": "inside", "perf.budget.frame_ms_p95": "inside" },
  "configHash": "sha256:9f2c…"
}
```

The ledger is the loop's memory (§8): an iteration reads it before acting,
so a reverted strategy is never retried and progress is auditable after the
fact. It is append-only by contract; the CLI has no delete/edit verb.

---

## 7. Budgets and `sloptimize check`

Budgets are declared in game source through the inspector's own `tune()`:

```js
tune('perf.budget.draw_calls', 300, { min: 1, max: 10000 });
tune('perf.budget.frame_ms_p95', 16.7, { min: 1, max: 100 });
tune('perf.budget.triangles', 2_000_000, { min: 1, max: 100_000_000 });
```

Rationale: budgets live in **reviewed source** (a diff to a budget is loud in
a PR — the anti-gaming posture, §9), are visible in the inspector's Tunables
panel like any other tunable, and need no new config format.

```
sloptimize check                # reads profile.json (or runs a bench with --bench)
  budgets: 3 checked, 1 breached
    perf.budget.draw_calls   940 / 300   ← over by 3.1×
  exit 1
```

Exit `0` when all budgets pass, `1` on any breach, `4` when no measurement
exists to check against (never a silent pass). `--counters-only` restricts to
the exact grade for CI on GPU-less machines. In a project with no
`perf.budget.*` tunables, `check` reports "no budgets declared" and exits 0
with a warning — budgets are opt-in, but their absence is said out loud.

---

## 8. Agent integration — the whole point

### 8.1 Surfaces, in order of preference

1. **Files** (`.sloptimize/*`) — read with the agent's own Read tool. No
   protocol, no server needed. The primary interface.
2. **CLI** — every command supports `--json` and meaningful exits. What the
   agent runs in Bash, what hooks wrap, what CI calls.
3. **Hook** — `sloptimize hook-status` prints a ≤5-line block for
   `UserPromptSubmit`: current regime, p95 vs budget, breached budgets, last
   hitch classification. Installed alongside the inspector's selection hook;
   silent (exit 0, no output) when nothing is running or nothing is breached
   — ambient perf the way selection is ambient, and only when it matters.
4. **MCP** (optional) — the live tier: `get_profile`, `get_census`,
   `attribute_cost`, `run_bench`, `get_ledger`, `repro_hitch`. Same
   structured-error-never-hang contract as the inspector's server.

### 8.2 Doctrine (SKILL.md + CLAUDE.md fragment)

Ships in-package (`skills/sloptimize/SKILL.md`) and is scaffolded into
projects the same way the inspector's skill is. The rules it must contain,
verbatim in spirit:

1. **Never claim a performance fix without a bench comparison.** A fix
   without a `bench --compare` verdict is a hypothesis.
2. The playbook: read `perf.jsonl` → classify → `attribute` → **one change**
   → `bench --compare` → report the verdict *and* distance-to-budget.
3. Map verdicts mechanically: improved → commit; no-detectable-change →
   revert; regressed → revert. No exceptions without the human.
4. Read the ledger before optimizing — do not retry a reverted strategy.
5. Trust grades: never quote a `timing` number from a `software` regime;
   never present census estimates as measurements.
6. Escalation seams: CPU-bound in script → Chrome DevTools MCP trace (which
   function); need per-draw GL state → Spector capture (which command).
   sloptimize answers *which entity, which frame, which workload* — only.

### 8.3 The `/loop` iteration contract

The self-iteration mode this product exists for. One iteration:

```
1. sloptimize check --json           → all inside? stop: done.
2. read .sloptimize/bench-history.jsonl (ledger) + perf.jsonl + census.json
3. pick ONE change, excluding strategies the ledger shows reverted
4. apply the change (ordinary code edit)
5. sloptimize bench --snapshot <canonical> --launch --compare last --json
6. correctness gate (§8.4): fails → revert, record, count a strike
7. verdict improved → commit (message carries the ledger line)
   otherwise → revert
8. stop conditions: budgets pass | 3 consecutive no-detectable-change |
   2 correctness strikes | iteration cap reached. Else loop.
```

Every step is a command or a file read; no step requires judgment about
*whether* to proceed — only step 3 requires intelligence, which is the
division of labor: **the tool decides what is true; the agent decides what
to try.** The canonical bench snapshot is chosen by the human once (a
representative heavy scene) and named in the skill — the agent must not
invent its own benchmark workload (LM-generated perf tests miss the real
regression roughly half the time in the literature).

### 8.4 The correctness gate

`sloptimize gate --snapshot <name>`: restore snapshot, `clock.step(1)`,
capture the frame, perceptual-diff (SSIM, threshold configurable, default
0.98) against `goldens/<name>.png`. Exit 0 pass / 1 fail / 4 no golden.
Goldens are created **only** by an explicit `sloptimize gate --record`,
which the doctrine reserves for the human (or a human-approved step); the
skill forbids the agent from re-recording a golden to make a failure pass,
and a re-recorded golden is a loud artifact in any review of `.sloptimize/`
timestamps. The gate complements — never replaces — the project's own tests.

---

## 9. Anti-gaming posture

A local agent with write access can edit budgets, goldens, this package, or
the ledger file itself. That cannot be prevented and this spec does not
pretend otherwise. It can be priced and exposed:

- Budgets in reviewed source (§7): moving a goalpost is a visible diff.
- The ledger is append-only by contract and machine-written; the CLI offers
  no edit verb, and each entry carries the `configHash` — a comparison
  against a mutated config self-identifies.
- Goldens regenerate only via the explicit human-reserved command (§8.4).
- Bench numbers are produced by this package's harness, not by
  agent-authored probe code; the skill forbids hand-rolled measurement
  scripts when the harness exists.
- The final backstop is unchanged from all agent work: a human reads the PR,
  where the ledger lines in commit messages make the claimed trajectory
  checkable in minutes.

---

## 10. Stated limits (what sloptimize will say it cannot do)

Printed by `sloptimize doctor`, documented in the README, never silently
degraded:

- **No per-draw GPU timing.** WebGL's timer extension allows one non-nested
  query scope, results arrive frames late, and pipelined draws do not sum to
  frame time. GPU ms is frame-level, Chromium-only, via stats-gl, or absent.
- **Fill-rate/overdraw attribution is heuristic only** (pixel-ratio
  experiment: fps recovers when resolution drops → fill-bound), and the
  verdict says "heuristic".
- **Costs from bisection do not sum** (§4.2) — ranking, not accounting.
- **Timing from software renderers is flagged and never compared** (§6.4).
- **Workload repro, not trajectory repro** (§5).
- **Simulation-CPU spikes attribute poorly** — the classification will say
  `long-script` and the escalation seam points at Chrome DevTools MCP.
- **EffectComposer/custom-pipeline hosts** inherit the inspector's
  interception gap; the recorder degrades to rAF-delta-only sampling there
  and `doctor` names it.
- **Multiplayer** is out of scope for the same reason it is out of scope for
  the inspector's pause: you cannot pause or restore the server.

---

## 11. Dependency policy

Hard runtime dependencies: **none** (the slopjs posture). Peers:
`@slopjs/inspector` (required), `three` (required),
`playwright-core` (optional — managed browser for `--launch`),
`stats-gl` (optional — GPU ms). Dev-only tooling may use whatever it needs.
The vite plugin activates only under `serve`; a production build contains
nothing of this package.

---

## 12. Milestones

- **M0 — recorder.** In-page runtime + vite plugin + `profile.json` +
  `perf.jsonl` + hitch classification + `sloptimize doctor`. The platform
  ask: `onFrame`. *Exit criterion: a hitch that happened before the panel was
  ever opened is explained from the file alone.*
- **M1 — census + hints.** `census.json`, hint vocabulary, `sloptimize
  attribute --static`, id→site resolution via `locate`. *Exit: the
  instancing-candidate hint names a real site in a real vibe-coded game.*
- **M2 — budgets + check + hook.** `tune('perf.budget.*')` convention,
  `sloptimize check` exit codes, `hook-status`. *Exit: CI fails a PR that
  doubles draw calls, on a GPU-less runner, counters-only.*
- **M3 — bench + ledger + gate.** Snapshot-pinned bench, `--launch`,
  compare verdicts, noise floors, `bench-history.jsonl`, the SSIM gate.
  Platform asks: snapshot camera, `captureFrame`. *Exit: the same fix
  benched twice yields the same verdict; a no-op change yields
  no-detectable-change.*
- **M4 — bisection + MCP + doctrine.** `attribute_cost`, the MCP server, the
  skill, the `/loop` contract end to end. *Exit: a `/loop` session takes a
  seeded 2,000-draw-call scene inside budgets unattended, with a clean
  ledger and zero gate failures.*

M0 is independently shippable and useful; each milestone is a publishable
release.

---

## 13. Open questions (tracked, not blocking M0)

1. Should `hook-status` and the inspector's selection hook merge into one
   block to save prompt tokens, or stay separable products? (Leaning:
   separable, one line each.)
2. Census texture-byte estimation for compressed formats (KTX2/basis) —
   estimate decoded or on-disk size? (Leaning: decoded, labeled.)
3. Does the bench restore path need `loadLayout` awareness for scenes built
   from layout files, or does snapshot restore subsume it? (Needs a real
   test scene.)
4. WebGPU (`WebGPURenderer`): `renderer.info` parity is partial and the
   interception point differs. Deferred until the inspector takes a position
   on WebGPU; tracked here so it is not forgotten.
5. Whether `attribute_cost` should also bisect **lights** (visibility
   toggling a light changes compiled program count — measurable, but slow).

---

*Derived from: the slopjs performance strategy (`docs/performance-strategy.md`
in the slopjs repo — audit of the inspector's current perf surface, two
research sweeps with citations, and the spin-out decision). August 2026.*
