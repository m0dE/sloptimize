# Comparability, the gate, and what follows — roadmap

Agreed 2026-10-02 with dmitriy (ticket 1cfda321), from friction hit on a
city-builder's perf work. Every item is a game-agnostic primitive the game
feeds with its own names — phases, counters, clock, drive script. Order is
build order. All eight shipped on branch ticket-1cfda321 (PR #9), one
commit each; the SPEC sections named below are the reference.

## 0. Run provenance + refusal across conditions — SHIPPED (SPEC §3.8)

Every false perf conclusion is a comparability failure. Runs carry a
conditions block (display refresh, instrument, run mode, regime, GPU,
platform, cores, drawing size, headless, sampler interval, drive script,
phase mix, browser, recorder knobs). `compare` refuses material mismatches
(exit 3, `--allow-mismatch` reads under a banner); `check` refuses against
`budgets.json`'s `perf.conditions`; `report` prints the conditions and the
vsync note. Unrecorded = unverified, never refused.

Later items extend the one field table in `src/conditions.js`: the drive
script's hash (6), the counter denominator (2), coverage mode (3).

## 1. The gate — per-phase budgets, regression exit code, refusal on too few runs — SHIPPED (SPEC §7.1)

- `check --session|--build <id>` judges a whole RUN per phase, not the
  2-second `profile.json` snapshot.
- Budgets `perf.budget.<phase>.<metric>` (`*` = every phase): `worst_ms`,
  `p95_ms`, `median_ms`, draw calls, triangles, programs, and the host's own
  sections and counters (the game must emit them — dmitriy's team will).
- **Hitch budgets count against the ABSOLUTE floor, not the relative one.**
  Detection is relative (2× rolling median), so a uniformly slower build
  clears the bar less often and reports FEWER hitches — a relative hitch
  budget goes green while the game gets worse (the September load case,
  inverted). Count frames over a fixed ms bar, say which rule a count came
  from, and only allow a relative count beside a median/p95 budget.
- `compare <base> <new> --fail-on-regression`: non-zero when any metric is
  significantly worse.
- **Insufficient runs is its own exit code**, distinct from pass and breach,
  with a declared minimum runs per side; `--fail-on-regression` treats it as
  a failure by default. A 2-sample floor is a guess; a gate that passes
  because it could not measure converts "unknown" into "fine" on every CI run.
- **`attach --runs N` ships here** (pulled forward from 6): the gate needs
  repetitions from one command.

## 2. Game counters, with a GAME-SUPPLIED denominator — SHIPPED (SPEC §3.11)

- `window.__sloptimizeCount(name, n)` (tier 0) and tier 1's `counts`.
- **Rates against the game's clock when it supplies one**:
  `window.__sloptimizeClock('simMs', t)`. Wall time over-credits a faster
  build: rendering 20% faster covers 20% more simulated world per wall
  second, so deliveries/wall-second rise with no throughput gain — a frame
  win counted twice (dmitriy's PerfRun shipped this bug, then fixed it to
  "per minute of sim time"). Per-frame is wrong too. Fall back to unpaused
  wall time only when no clock is supplied.
- Record WHICH denominator each counter used; it joins the conditions
  table, and compare refuses wall-normalised vs clock-normalised.
- `report` shows rates; `compare` judges them with the existing noise
  floor; budgets can be directional (`perf.rate.<name>: { min | max }`).

## 3. Coverage — function-level, as its own run mode — SHIPPED (SPEC §3.12)

- **Function-level, not module-level.** The miss it exists for:
  `TrafficLight.js` loaded, its manager was constructed and ticked over an
  empty map — the MODULE executed; `TrafficLight.prototype.update` had 0
  calls. Output: functions never called inside loaded modules, ranked by
  module size; plus `--changed/--since` (an exact `touched`).
- Say which finding it is: a module that never LOADED (dead import,
  stripped feature) vs a module that loaded and sat IDLE (bench content
  missing — the one benches get wrong).
- **A separate run mode** (`attach --coverage`): precise coverage has real
  cost (function-level call counts are the cheap mode, block-level the
  expensive one — even the cheap mode keeps feedback vectors alive and is
  not free). `mode: 'coverage'` in conditions; compare and the gate refuse
  it as a timing side (already true via item 0), and coverage is never
  reported from a timing run as if complete. Best-effort coverage is NOT a
  substitute: it can report a called function as uncalled.

## 4. Fixed-interval detection on recurring footprints — SHIPPED (SPEC §3.7)

- `issues` / `history`: "recurs every 15.0 s ± 0.2 (6 occurrences)" from
  the occurrence timestamps the ledger already holds. ≥4 occurrences; skip
  paused/hidden spans; show the spread, not just a verdict.
- Target: autosave, GC bursts, streaming ticks, sync, analytics flushes. A
  fixed interval says timer, not user action.

## 6. `attach --drive <script>` — SHIPPED (SPEC §3.13)

- A game-supplied script on the recording's timeline (`at(s, fn)`,
  `phase(name)`); the game exposes its own camera/input API.
- The script's hash joins conditions; two scripts never compare.

## 7. GPU-bound verdict — MERGED (SPEC §3.3)

- Rebase and merge `gpu-bound-verdict` (game's own GPU time per frame).
- Host contention is a different question: `compare` detects it across two
  sides (uniform change, unchanged composition). Within ONE run it needs a
  different signal (frame-time variance rising while work per frame holds) —
  scope separately; `report` must not promise a warning it can only
  sometimes produce.

## 5. Memory trend for long sessions — SHIPPED (SPEC §3.14)

- **GPU resource counts first**: `renderer.info.memory` geometries /
  textures / programs on the heartbeat — a dispose missed on a rebuild grows
  geometries monotonically and is invisible to every metric today. May
  belong with census.
- Then the JS heap: post-GC via `HeapProfiler.collectGarbage` over the CDP
  connection attach already holds (the page cannot force GC without
  `--expose-gc`); `performance.memory` is coarse without
  `--enable-precise-memory-info`, so the trend says which source it used.
- Shipped as `attach --heap-snapshots` (start ~30 s in, end at stop) rather
  than `ask heap`: `ask` is the tier-1 channel, and a snapshot needs the CDP
  connection only attach holds.
- Not shipped: within-one-run host-contention detection (item 7's second
  half) — scoped out, as agreed; `report` promises nothing it cannot produce.

## Theirs, not ours

The autosave kill-switch; a bench save with traffic lights; golden
screenshots (deferred — needs deterministic rendering and item 6). They
will emit their per-frame sections and the item-2 counters to the ledger,
which is what makes the per-phase gate useful rather than theoretical.
