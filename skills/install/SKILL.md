---
name: install
description: Use when asked to install, integrate, or wire sloptimize into a game project — performs the tier-1 integration (in-page runtime, ingest sink, budgets, Claude hooks) and verifies the feed live before claiming success.
---

# Installing sloptimize into a game

You are wiring the always-on tier (tier 1) into a real game repo. The
reference deployment's mistakes are encoded below as MUST rules — do not
rediscover them. `docs/INTEGRATION.md` in the sloptimize package is the
narrative version; `docs/USAGE.md` is what the result behaves like.

**The definition of done is a measured round-trip, not written code.** Do
not report success until step 7 shows your test keyframe in
`sloptimize report`.

## 1. Locate the package and the game's shape

- Find sloptimize: `node_modules/sloptimize` (npm) or a sibling checkout.
- Identify: the render loop's stats site (wherever `renderer.info` is
  already read), the dev-server topology (vite? own server? esbuild?), and
  the dev-only switch the project already uses for debug endpoints.

## 2. The in-page runtime

Create a dev module (reference: mecharoyale's `dev/sloptimize-runtime.ts`)
that:

- `createRecorder({ budgetFrameMs: <the game's frame budget> })`.
- **MUST give the recorder its own rAF clock** — a game-loop-fed clock is
  blind to boot/menu/loading, exactly the windows that freeze. The game
  loop only *enriches* counters; treat counters staler than ~250ms as
  zeros.
- `frameMs` MUST bound `insideRenderMs` (rAF-to-rAF delta, wall time
  inside render).
- Feed `paused: true` while the tab is hidden or unfocused (and for the
  first frame after refocus) — throttled-tab gaps must never classify as
  hitches.
- Bind a keyframe chord (Ctrl+F12 recommended) AND a small clickable chip:
  capture the trailing 5s FIRST, then open the package's debugger
  (`createPanel` — Current Session · Issues · Optimizations · Settings + the
  note box) and post the keyframe only if a note comes back. The incident
  rows you hand it carry `fp` (the footprint id) and, for rows that are not
  milliseconds, `label`/`glyph`.
- Stamp `build`, `phase`, `automated` (navigator.webdriver), `ctx` and
  `footprint` (`footprintOf(record)`) on every posted record — the writer
  names the cause; every reader agrees without re-deriving.

### 2b. The jitter detector (the second incident type)

Read `docs/JITTER-AND-FOOTPRINTS.md` §1–2, then:

- `createMotionMonitor({ unit, longFrameMs: <the sim's dt clamp, ms>,
  tracks: { unit: { floor }, camera: { floor, reach: 'boom', follows: 'unit' } } })`.
  `longFrameMs` MUST be the game's real clamp, found in its loop — never a
  guess; the floor is the smallest pop a player can see in the game's units.
- Feed once per RENDERED frame, after the render (transient shakes must not
  be sampled): the `unit` track is the point the view is arranged around
  (the pivot — rotation-invariant), NEVER the raw camera; the `camera` track
  is the eye, HELD on any frame that consumed look/zoom input, with `reach`
  = its distance to the pivot.
- Hold both tracks while paused/unfocused and in phases without a
  continuous view (boot, a cinematic that cuts). Derive a view-configuration
  key (pivot publisher · camera mode · spectate target) and `cut()` when it
  changes — never enumerate call sites.
- Drain beside the recorder into the same post.

### 2c. The situation and footprints

Read `docs/JITTER-AND-FOOTPRINTS.md` §3–4, then:

- Write a `context()` returning ≤6 LOW-CARDINALITY facets of the player's
  situation (the reference: stance, hull, squad, view, combat) — categories,
  never positions or counters. Refresh `canonicalContext(context())` once a
  second; pass the string as `ctx` to `frame()`, `usermark()` and every
  motion `sample()`.
- At post, for every record: `r.ctx ??= ctx; const fp = footprintOf(r); if (fp) r.footprint = fp;`.
- Post a `{type:'heartbeat', medianFrameMs, p95Ms, calls, triangles,
  programs}` ledger line once a minute while armed — the counters are the
  Timeline's draw-call history.

## 3. Activation — MUST NOT gate on hostname

Probe the ingest endpoint at boot: 204 arms, anything else stays inert,
and the probe retries on a backoff (5s/30s/2min, then 5min). A dev preview
behind a proxy looks like production to a hostname test; only the server
knows what it is.

## 4. The sink

- Vite host: the vite plugin surface (when present), else the same
  endpoint as below in the dev server.
- Any other host: one dev-only `POST /api/sloptimize/ingest` accepting
  `{kind: 'profile'|'records'|'census', payload}` → writes
  `.sloptimize/profile.json`, appends `perf.jsonl`, writes `census.json`.
  Refuse with a plain 404 when the dev switch is off — identical to an
  unknown route. Beside it, one dev-gated `GET /api/sloptimize/ledger` →
  `{perf, fixes}` (the ~2MB tail of `perf.jsonl` + all of `fixes.jsonl`,
  raw JSONL) for the debugger's history tabs. Prefer arming by topology (the presence of
  `.sloptimize/budgets.json` in the server cwd) with env overrides, over
  a bare env flag someone must remember.
- **MUST NOT die silently**: once armed, a refused or failed post flips
  the feed DARK — buffer (bounded, count drops), retry on the backoff,
  and SHOW the state on the chip. The first deployment lost an hour of
  real freezes to "first 404 disables posting".

## 5. Budgets and gitignore

- Write `.sloptimize/budgets.json` with the game's real limits, e.g.
  `{"perf.budget.frame_ms_p95": 16.7, "perf.budget.draw_calls": 400}`.
- Gitignore `.sloptimize/*` **except** `budgets.json`.

## 6. The Claude Code session surface

- If installed as a plugin, the prompt hook ships already. Otherwise add
  the `UserPromptSubmit` hook to the game's `.claude/settings.json`:
  `npx sloptimize hook-status --dir .sloptimize` (add a second `--dir`
  for a shared deployment directory if one exists).
- Copy the doctrine skill into `.claude/skills/sloptimize/` when not
  running as a plugin.

## 7. Verify — the gate

1. Start the game server in its dev topology; open the game.
2. Confirm the chip reads armed (`◉`), or `__sloptimize.feed()` says ok.
3. Fire a synthetic keyframe: `__sloptimize.mark('install-test')` in the
   console (or the chord).
4. Run `npx sloptimize report --dir <game>/.sloptimize` and confirm the
   `install-test` usermark is in it — with a `footprint` and a `ctx` on the
   ledger line.
5. Run `npx sloptimize check` and report the budget verdict.
6. Jitter: `__sloptimize.motion()` (or your equivalent) shows both tracks
   sampling with `held` counting up on look input; force one jump of the
   unit (move the body/hull by a metre in one frame from the console) and
   confirm a `jitter` record with `kind: 'snap'` and the right `units` lands
   — and that a camera flick, a mode flip and a respawn land NOTHING.
7. `npx sloptimize issues --dir <game>/.sloptimize` lists the footprints
   seen so far, the `install-test` keyframe among them.

Only after 4 succeeds may you tell the user the install is complete —
report what was wired, the verify evidence, and the one daily obligation
that remains (start the server in its dev topology; everything else is
automatic).
